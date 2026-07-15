/**
 * Vault crypto key-management tests (WP-R0.6).
 *
 * Guards the boot-time key policy (§12.4, §25.1) and the key-rotation path:
 * - REFUSE TO BOOT when no vault key is configured (no silent ephemeral key that
 *   would make every stored secret permanently undecryptable after a restart).
 * - Accept the canonical `VAULT_KEY` / `VAULT_KEY_FILE` env vars, and the
 *   deprecated `MSB_SECRET_ENCRYPTION_KEY(_FILE)` aliases (with a warning).
 * - `ALLOW_EPHEMERAL_VAULT_KEY=true` is the dev-only escape hatch.
 * - `rotateVaultKey` re-encrypts every credential from an old key to a new one.
 *
 * The rotation test needs a real Postgres (testcontainers) and skips without a
 * container runtime (mirrors vault.test.ts). The pure policy tests always run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { loadVaultCryptoKey, createVaultCrypto, rotateVaultKey } from "../crypto.js";
import { createVault } from "../vault.js";
import { addCredential } from "../credential.js";
import { createTenant } from "../../tenant/tenant.js";

describe("loadVaultCryptoKey: boot-time key policy", () => {
  it("REFUSES to boot with no key and no escape hatch", () => {
    expect(() => loadVaultCryptoKey({})).toThrow(/VAULT_KEY/);
  });

  it("allows an ephemeral key when ALLOW_EPHEMERAL_VAULT_KEY=true", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { key, keyId } = loadVaultCryptoKey({ ALLOW_EPHEMERAL_VAULT_KEY: "true" });
      expect(keyId).toBe("ephemeral");
      expect(key.length).toBe(32);
      // encryption still works under the ephemeral key
      const c = createVaultCrypto(key, keyId);
      const enc = c.encrypt("hello");
      expect(c.decrypt(enc)).toBe("hello");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the canonical VAULT_KEY env var", () => {
    const hex = Buffer.alloc(32, 3).toString("hex");
    const { key, keyId } = loadVaultCryptoKey({ VAULT_KEY: hex });
    expect(keyId).toBe("env");
    expect(key.equals(Buffer.alloc(32, 3))).toBe(true);
  });

  it("accepts the deprecated MSB_SECRET_ENCRYPTION_KEY alias with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const hex = Buffer.alloc(32, 4).toString("hex");
      const { key, keyId } = loadVaultCryptoKey({ MSB_SECRET_ENCRYPTION_KEY: hex });
      expect(keyId).toBe("env");
      expect(key.equals(Buffer.alloc(32, 4))).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

const RUNTIME = hasContainerRuntime();
const KEY_A = Buffer.alloc(32, 0xa);
const KEY_B = Buffer.alloc(32, 0xb);

describe.skipIf(!RUNTIME)("rotateVaultKey", () => {
  let db: TestDb;
  let pool: Pool;
  let tenant: TenantCtx;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Rotate Tenant" });
    tenant = { tenantId: t.id };
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("re-encrypts every credential from key A to key B", async () => {
    const cryptoA = createVaultCrypto(KEY_A, "keyA");
    const vault = await createVault(pool, tenant, { name: "v", metadata: undefined });
    await addCredential(pool, tenant, cryptoA, vault.id, {
      key: "SECRET_ONE",
      category: "environment_variable",
      secretValue: "value-one",
    });
    await addCredential(pool, tenant, cryptoA, vault.id, {
      key: "SECRET_TWO",
      category: "static_bearer",
      token: "value-two",
    });

    const res = await rotateVaultKey(pool, KEY_A, KEY_B, "keyB");
    expect(res.rotated).toBeGreaterThanOrEqual(2);

    const rows = await query<{
      secret_enc: Buffer;
      nonce: Buffer;
      key_id: string;
      key: string;
    }>(
      pool,
      `SELECT secret_enc, nonce, key_id, key FROM vault_credentials
        WHERE tenant_id = $1 ORDER BY key`,
      [tenant.tenantId],
    );

    const cryptoB = createVaultCrypto(KEY_B, "keyB");
    for (const r of rows.rows) {
      expect(r.key_id).toBe("keyB");
      // the OLD key can no longer decrypt (GCM tag mismatch)
      expect(() =>
        cryptoA.decrypt({ ciphertext: r.secret_enc, nonce: r.nonce, keyId: r.key_id }),
      ).toThrow();
    }
    const decoded = rows.rows.map((r) =>
      cryptoB.decrypt({ ciphertext: r.secret_enc, nonce: r.nonce, keyId: r.key_id }),
    );
    expect(decoded).toContain("value-one");
    expect(decoded).toContain("value-two");
  }, 120_000);
});
