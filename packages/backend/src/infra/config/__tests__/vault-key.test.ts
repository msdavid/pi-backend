/**
 * Vault-key source resolution: the `NODE_ENV=test` escape hatch is removed
 * (WP-R0.7).
 *
 * `resolveVaultKeySource` used to treat `NODE_ENV==="test"` as an implicit
 * `ALLOW_EPHEMERAL_VAULT_KEY` — so a production process mis-set to `test` would
 * silently boot with a throwaway key and make every stored secret permanently
 * undecryptable. The only signal that now enables an ephemeral key is the
 * explicit `ALLOW_EPHEMERAL_VAULT_KEY=true` flag.
 */

import { describe, it, expect } from "vitest";
import { resolveVaultKeySource } from "../index.js";

describe("resolveVaultKeySource: NODE_ENV=test no longer implies ephemeral", () => {
  it("REFUSES to boot under NODE_ENV=test with no key and no explicit flag", () => {
    expect(() => resolveVaultKeySource({ NODE_ENV: "test" })).toThrow(/VAULT_KEY/);
  });

  it("returns an ephemeral source only with the explicit escape hatch", () => {
    const src = resolveVaultKeySource({ ALLOW_EPHEMERAL_VAULT_KEY: "true" });
    expect(src).toEqual({ kind: "ephemeral", keyId: "ephemeral" });
  });

  it("REFUSES to boot with no key and an empty environment", () => {
    expect(() => resolveVaultKeySource({})).toThrow(/VAULT_KEY/);
  });

  it("still resolves a configured VAULT_KEY under NODE_ENV=test", () => {
    const hex = Buffer.alloc(32, 7).toString("hex");
    const src = resolveVaultKeySource({ NODE_ENV: "test", VAULT_KEY: hex });
    expect(src).toEqual({ kind: "inline", value: hex, keyId: "env" });
  });
});
