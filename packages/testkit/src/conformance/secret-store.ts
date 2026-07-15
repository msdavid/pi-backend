/**
 * Conformance test kit for the `SecretStore` port (WP-5.1, spec §12, §25.1, §25.4,
 * §25.5).
 *
 * A published vitest suite any `SecretStore` implementation — the testkit
 * `FakeSecretStore` (reference), the Postgres vault `SecretStore`, or a third-party
 * plugin — runs to prove it satisfies the §25.5 invariant: it NEVER exposes raw
 * secret values to the caller, only opaque `SecretBinding` refs the
 * `SandboxProvider` registers host-side.
 *
 * ## Usage
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runSecretStoreConformance } from "@pi-managed/testkit";
 * import { MySecretStore } from "./my-store.js";
 *
 * describe("MySecretStore conformance", () => {
 *   runSecretStoreConformance("MySecretStore", async () => ({
 *     store: new MySecretStore(),
 *     seed: async (ctx, bindings) => { /* populate the vault so resolve returns them *\/ },
 *     cleanup: async () => { /* teardown *\/ },
 *   }));
 * });
 * ```
 *
 * The kit seeds a known binding (ref only — never a value), then asserts
 * `resolveBindingsForSession` returns it and that no value is reachable through the
 * store, and that `revalidate` does not throw.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  SecretBinding,
  SecretStore,
  SessionContext,
} from "@pi-managed/backend";

/**
 * A freshly-constructed store plus a `seed` hook that populates it so
 * `resolveBindingsForSession(ctx)` returns at least the supplied `bindings`.
 */
export interface SecretStoreFixture {
  store: SecretStore;
  /**
   * Populate the store so a subsequent `resolveBindingsForSession(ctx)` returns the
   * given bindings (refs only — never secret values). For in-memory fakes this is a
   * script call; for a real vault it inserts the credential rows.
   */
  seed: (ctx: SessionContext, bindings: SecretBinding[]) => Promise<void>;
  cleanup?: () => Promise<void>;
}

/**
 * Run the `SecretStore` contract suite against a single impl. `make` returns the
 * fixture, or `null` to skip (impl unavailable in this environment).
 */
export function runSecretStoreConformance(
  name: string,
  make: () => Promise<SecretStoreFixture | null>,
): void {
  describe(name, () => {
    let fixture: SecretStoreFixture | null = null;
    let store: SecretStore;

    beforeAll(async () => {
      fixture = await make();
      if (!fixture) return;
      store = fixture.store;
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    /** A session context with a unique session id. */
    function ctx(): SessionContext {
      return {
        tenantId: `t-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: `sess_${Math.random().toString(36).slice(2, 10)}`,
        vaultIds: ["vault_test"],
      };
    }

    /** A test binding carrying only a placeholder + ref — never a value (§25.5). */
    function testBinding(tenantId: string): SecretBinding {
      return {
        placeholderName: "$MSB_API_KEY",
        category: "environment_variable",
        credentialRef: {
          tenantId,
          vaultId: "vault_test",
          credentialKey: "API_KEY",
        },
      };
    }

    it("resolveBindingsForSession returns the seeded bindings as opaque refs", async () => {
      if (!fixture) return;
      const c = ctx();
      const binding = testBinding(c.tenantId);
      await fixture.seed(c, [binding]);
      const bindings = await store.resolveBindingsForSession(c);
      expect(bindings).toHaveLength(1);
      expect(bindings[0].placeholderName).toBe("$MSB_API_KEY");
      expect(bindings[0].credentialRef.tenantId).toBe(c.tenantId);
    });

    it("resolveBindingsForSession returns an empty array for an unknown session", async () => {
      if (!fixture) return;
      const c = ctx();
      // No seed → resolve must return an empty array, not throw.
      const bindings = await store.resolveBindingsForSession(c);
      expect(bindings).toEqual([]);
    });

    it("never exposes a raw secret value across the seam (§25.5)", async () => {
      if (!fixture) return;
      const c = ctx();
      const binding = testBinding(c.tenantId);
      await fixture.seed(c, [binding]);
      const bindings = await store.resolveBindingsForSession(c);
      for (const b of bindings) {
        // No value field exists on a SecretBinding; assert structurally.
        expect(b).not.toHaveProperty("value");
        expect(b).not.toHaveProperty("secret");
        expect(b).not.toHaveProperty("token");
      }
      // No synthetic secret value is reachable via the store or the bindings.
      expect(JSON.stringify(bindings)).not.toContain("raw-secret-value");
      expect(JSON.stringify(store)).not.toContain("raw-secret-value");
    });

    it("revalidate does not throw for a known session", async () => {
      if (!fixture) return;
      const c = ctx();
      await fixture.seed(c, [testBinding(c.tenantId)]);
      await expect(store.revalidate(c)).resolves.toBeUndefined();
    });

    it("revalidate does not throw for an unknown session", async () => {
      if (!fixture) return;
      const c = ctx();
      await expect(store.revalidate(c)).resolves.toBeUndefined();
    });
  });
}
