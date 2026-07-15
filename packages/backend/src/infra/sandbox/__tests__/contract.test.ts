/**
 * Sandbox-provider contract parity tests (WP-1.3, §5.4, §10).
 *
 * The SAME suite shape runs against:
 *  - the testkit `FakeSandboxProvider` (reference behavior; always runs), and
 *  - `MicrosandboxProvider` (real NAPI SDK; `@kvm`-gated — skipped unless `/dev/kvm`
 *    exists and the msb runtime is installed).
 *
 * Divergence between the two is a bug in the fake (or the real impl). The fake is
 * in-memory and fast; the real run exercises one microVM through its full lifecycle.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ProvisionSpec,
  SandboxProvider,
  SecretBinding,
} from "../../../domain/ports.js";
import { MicrosandboxProvider } from "../provider.js";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { kvmRuntimeAvailable } from "./kvm-gate.js";

/**
 * KVM + msb runtime, or the real-provider half of the parity suite is skipped.
 * Hard-fails instead under `PI_REQUIRE_INTEGRATION` (R1.2) — see `kvm-gate.ts`.
 */
const KVM = kvmRuntimeAvailable("@kvm sandbox-provider contract parity (real provider)");

/** A freshly-constructed provider plus per-impl seeding/cleanup hooks. */
interface Fixture {
  provider: SandboxProvider;
  /**
   * Seed the exec results for a sandbox name. For the fake this scripts the
   * `echo hello` outputs; for the real provider it is a no-op (the VM actually runs).
   */
  seed?: (name: string) => void;
  cleanup?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

async function fakeFixture(): Promise<Fixture> {
  const provider = new FakeSandboxProvider();
  return {
    provider,
    seed: (name) =>
      provider.scriptExec(name, [
        // One entry carrying BOTH a buffered result (for exec) and streaming chunks
        // (for execStream); each contract test calls exactly one exec method on a
        // fresh sandbox, so a single entry satisfies whichever runs.
        {
          stdout: "hello\n",
          chunks: [{ stream: "stdout", data: "hello\n" }],
        },
      ]),
  };
}

/** Test secret resolver — returns a fixed value + allowed host (never logged). */
const testResolver = {
  async resolve() {
    return { value: "parity-secret-value", allowedHosts: ["example.com"] };
  },
};

async function realFixture(): Promise<Fixture | null> {
  if (!KVM) return null;
  const provider = new MicrosandboxProvider({ secretResolver: testResolver });
  return { provider };
}

// ---------------------------------------------------------------------------
// Shared contract suite
// ---------------------------------------------------------------------------

function spec(): ProvisionSpec {
  return {
    name: `parity-${randomUUID().slice(0, 8)}`,
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

function runContract(name: string, make: () => Promise<Fixture | null>): void {
  describe(name, () => {
    let fixture: Fixture | null = null;
    let provider: SandboxProvider;

    beforeAll(async () => {
      fixture = await make();
      if (fixture) provider = fixture.provider;
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

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

// ---------------------------------------------------------------------------
// Parameterized runs
// ---------------------------------------------------------------------------

runContract("FakeSandboxProvider", fakeFixture);
runContract("MicrosandboxProvider", realFixture);
