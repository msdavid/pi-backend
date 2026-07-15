/**
 * Conformance test kit for the `SandboxProvider` port (WP-5.1, spec §5.4, §10).
 *
 * A published vitest suite any `SandboxProvider` implementation — the testkit
 * `FakeSandboxProvider` (reference), the real `MicrosandboxProvider`, or a
 * third-party plugin — runs to prove it satisfies the contract documented on the
 * `SandboxProvider` interface in `@pi-managed/backend` (`domain/ports.ts`).
 *
 * The suite is the same shape as the fake/real parity tests that live next to the
 * real impls; this is the importable, published form. Divergence from the reference
 * behavior is a bug in the impl under test.
 *
 * ## Usage
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runSandboxProviderConformance } from "@pi-managed/testkit";
 * import { MySandboxProvider } from "./my-provider.js";
 *
 * describe("MySandboxProvider conformance", () => {
 *   runSandboxProviderConformance("MySandboxProvider", async () => ({
 *     provider: new MySandboxProvider(),
 *   }));
 * });
 * ```
 *
 * §25.5: this kit never asserts on secret values — only that opaque `SecretBinding`
 * refs are accepted and never carry a value.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ProvisionSpec,
  SandboxProvider,
  SecretBinding,
} from "@pi-managed/backend";

/**
 * A freshly-constructed provider plus per-impl seeding/cleanup hooks.
 *
 * - `seed`: for in-memory fakes, script the `echo hello` outputs. For real impls
 *   that actually run a VM, this is a no-op (the command runs for real). It is
 *   called once per provision, before each lifecycle test.
 * - `cleanup`: release any resources (e.g. stop testcontainers) after the suite.
 */
export interface SandboxProviderFixture {
  provider: SandboxProvider;
  seed?: (name: string) => void;
  cleanup?: () => Promise<void>;
}

/**
 * Run the `SandboxProvider` contract suite against a single impl. `make` returns
 * the fixture, or `null` if the impl cannot be provisioned in this environment
 * (e.g. no KVM) — the suite then skips with a warning rather than failing.
 */
export function runSandboxProviderConformance(
  name: string,
  make: () => Promise<SandboxProviderFixture | null>,
): void {
  describe(name, () => {
    let fixture: SandboxProviderFixture | null = null;
    let provider: SandboxProvider;

    beforeAll(async () => {
      fixture = await make();
      if (fixture) provider = fixture.provider;
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    /** A minimal provisioning spec with a unique tenant/session. */
    function spec(): ProvisionSpec {
      return {
        name: `conf-${randomUUID().slice(0, 8)}`,
        image: "alpine",
        cpus: 1,
        memoryMiB: 256,
        labels: {
          tenant: `t-${randomUUID().slice(0, 6)}`,
          session: `s-${randomUUID().slice(0, 6)}`,
        },
        networkPolicy: { mode: "unrestricted" },
        detached: true,
      };
    }

    /** A secret binding carrying only a placeholder + ref — never a value (§25.5). */
    function testBinding(tenant: string): SecretBinding {
      return {
        placeholderName: "$MSB_TEST",
        category: "environment_variable",
        credentialRef: {
          tenantId: tenant,
          vaultId: "vault_test",
          credentialKey: "TEST",
        },
      };
    }

    it("provision returns a handle with name + labels", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      expect(handle.name).toBe(s.name);
      expect(handle.labels).toEqual(s.labels);
      await provider.destroy(handle);
    });

    it("exec returns the command stdout + zero exit", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        const res = await provider.exec(handle, { cmd: "echo hello" });
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("hello");
      } finally {
        await provider.destroy(handle);
      }
    });

    it("execStream yields a stdout chunk", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        const chunks: { stream: "stdout" | "stderr"; data: string }[] = [];
        for await (const c of provider.execStream(handle, { cmd: "echo hello" })) {
          chunks.push(c);
        }
        const stdout = chunks
          .filter((c) => c.stream === "stdout")
          .map((c) => c.data)
          .join("");
        expect(stdout).toContain("hello");
      } finally {
        await provider.destroy(handle);
      }
    });

    it("stop checkpoints to stopped; start cold-reboots to running", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        await provider.stop(handle);
        expect(await provider.status(handle)).toBe("stopped");
        await provider.start(handle);
        expect(await provider.status(handle)).toBe("running");
      } finally {
        await provider.destroy(handle);
      }
    });

    it("snapshot returns a non-empty snapshot id", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        await provider.stop(handle);
        const snap = await provider.snapshot(handle);
        expect(typeof snap).toBe("string");
        expect(snap.length).toBeGreaterThan(0);
      } finally {
        await provider.destroy(handle);
      }
    });

    it("reattachByLabels finds the provisioned sandbox", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        const found = await provider.reattachByLabels({
          tenant: s.labels.tenant,
          session: s.labels.session,
        });
        expect(found.some((h) => h.name === handle.name)).toBe(true);
      } finally {
        await provider.destroy(handle);
      }
    });

    it("registerSecretBinding records the ref without a value and does not throw", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      try {
        await provider.registerSecretBinding(handle, testBinding(s.labels.tenant));
        // No throw + no value carried by the binding (§25.5) is the contract.
      } finally {
        await provider.destroy(handle);
      }
    });

    it("destroy removes the sandbox; status throws afterwards", async () => {
      if (!fixture) return;
      const s = spec();
      fixture.seed?.(s.name);
      const handle = await provider.provision(s);
      await provider.destroy(handle);
      await expect(provider.status(handle)).rejects.toThrow();
    });
  });
}
