/**
 * Vault + credential integration tests (WP-1.9).
 *
 * Covers the done criteria:
 * - Encryption round-trip (decrypt gives back plaintext; ciphertext ≠ plaintext).
 * - Serialization: `token`/`secretValue`/`accessToken`/`clientSecret`/`refreshToken`
 *   NEVER appear in any API response (create + list).
 * - Binding resolution: env-var cred → `$MSB_` placeholder, NO value in the binding.
 * - Archive-cascade: archiving a vault purges all credential `secret_enc`.
 * - Unique key per vault → 409.
 * - Max-20 credentials per vault → 422.
 *
 * Uses a real Postgres via @testcontainers/postgresql; skips without a container
 * runtime (mirrors the db/__tests__ convention). The pure crypto test runs always.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { idempotencyMiddleware } from "../../../api/middleware/idempotency.js";
import { ApiError } from "../../errors.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import {
  createVaultCrypto,
  encryptSecret,
  decryptSecret,
  type VaultCrypto,
} from "../crypto.js";
import { createVaultSecretStore } from "../secret-store.js";
import { vaultRoutes } from "../../../api/vaults.js";

// scopes: ["admin"] — this fixture injects tenantCtx directly (bypassing
// issueApiKey), so it must carry a scope explicitly to pass the
// requireScopeByMethod guard (R0.1) that vaultRoutes registers.
const TENANT: TenantCtx = { tenantId: "tnt_vault_test", scopes: ["admin"] };
const RUNTIME = hasContainerRuntime();

// A fixed 32-byte test key (NOT a real secret — test fixture only).
const TEST_KEY = Buffer.alloc(32, 7);
const TEST_CRYPTO: VaultCrypto = createVaultCrypto(TEST_KEY, "test");

/** Sensitive field names that must NEVER appear in a credential response. */
const SENSITIVE_KEYS = [
  "token",
  "secretValue",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
];

/** Recursively collect every string key anywhere in a JSON value. */
function allKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

/** Assert no sensitive key appears anywhere in a JSON-serialized body. */
function assertNoSecrets(body: string, label: string) {
  const parsed = JSON.parse(body);
  const keys = allKeys(parsed);
  for (const s of SENSITIVE_KEYS) {
    expect(keys, `${label}: sensitive field "${s}" leaked`).not.toContain(s);
  }
}

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand-in for auth: attach tenant context on every request.
  app.addHook("onRequest", async (req) => {
    req.tenantCtx = TENANT;
  });
  // Mirror the global ApiError → ErrorEnvelope handler from server.ts so
  // error responses carry the contract `error.code` (the real app uses
  // createApp; this test exercises vault routes in isolation).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: {
          type: err.statusCode >= 500 ? "server_error" : "request_error",
          code: err.code,
          message: err.message,
          requestId: req.id,
        },
      });
    }
    const message = err instanceof Error ? err.message : "internal error";
    return reply
      .status(500)
      .send({ error: { type: "server_error", code: "internal_error", message, requestId: req.id } });
  });
  idempotencyMiddleware(app, pool);
  await app.register(vaultRoutes, { pool, crypto: TEST_CRYPTO });
  return app;
}

async function createVault(app: FastifyInstance, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/vaults",
    headers: { "idempotency-key": `vault-${name}`, "content-type": "application/json" },
    payload: JSON.stringify({ name }),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id;
}

async function addCred(
  app: FastifyInstance,
  vaultId: string,
  body: Record<string, unknown>,
  idemKey: string,
) {
  return app.inject({
    method: "POST",
    url: `/v1/vaults/${vaultId}/credentials`,
    headers: { "idempotency-key": idemKey, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Pure crypto round-trip (no DB — always runs).
// ---------------------------------------------------------------------------

describe("vault crypto (AES-256-GCM)", () => {
  it("round-trips plaintext and ciphertext differs from plaintext", () => {
    const plaintext = "ghp_supersecret_test_token_0123";
    const enc = encryptSecret(plaintext, "test", TEST_KEY);
    // Ciphertext must not contain the plaintext bytes.
    expect(enc.ciphertext.toString("utf8")).not.toContain(plaintext);
    expect(enc.nonce.length).toBe(12);
    // Tag is appended: ciphertext is ct(28) + tag(16) > plaintext byte length.
    expect(enc.ciphertext.length).toBeGreaterThan(plaintext.length);
    const back = decryptSecret(enc, TEST_KEY);
    expect(back).toBe(plaintext);
  });

  it("uses a fresh nonce per encryption (non-deterministic)", () => {
    const pt = "same-input";
    const a = encryptSecret(pt, "test", TEST_KEY);
    const b = encryptSecret(pt, "test", TEST_KEY);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects a tampered ciphertext (auth tag verification)", () => {
    const enc = encryptSecret("secret", "test", TEST_KEY);
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] ^= 0xff; // flip a bit
    expect(() =>
      decryptSecret({ ...enc, ciphertext: tampered }, TEST_KEY),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration tests (real Postgres).
// ---------------------------------------------------------------------------

describe("vault routes + secret store", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!RUNTIME) return;
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });
    await query(
      pool,
      `INSERT INTO tenants (id, name) VALUES ($1, 'Vault Test') ON CONFLICT DO NOTHING`,
      [TENANT.tenantId],
    );
    app = await buildApp(pool);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it.skipIf(!RUNTIME)("serializes NO sensitive fields on create + list", async () => {
    const vaultId = await createVault(app, "serialization-vault");

    // static_bearer carries `token`; environment_variable carries `secretValue`.
    const sb = await addCred(
      app,
      vaultId,
      { key: "https://api.example.com", category: "static_bearer", token: "ghp_leak_test_sb" },
      `cred-sb-${vaultId}`,
    );
    expect(sb.statusCode).toBe(201);
    assertNoSecrets(sb.body, "create static_bearer");

    const ev = await addCred(
      app,
      vaultId,
      { key: "GIT_TOKEN", category: "environment_variable", secretValue: "ghp_leak_test_ev" },
      `cred-ev-${vaultId}`,
    );
    expect(ev.statusCode).toBe(201);
    assertNoSecrets(ev.body, "create environment_variable");

    const list = await app.inject({
      method: "GET",
      url: `/v1/vaults/${vaultId}/credentials`,
    });
    expect(list.statusCode).toBe(200);
    assertNoSecrets(list.body, "list credentials");
    const listed = JSON.parse(list.body).data as unknown[];
    expect(listed.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it.skipIf(!RUNTIME)("resolves env-var creds to $MSB_ placeholders with no value", async () => {
    const vaultId = await createVault(app, "bindings-vault");
    const secretValue = "ghp_binding_secret_value_xyz";
    const cred = await addCred(
      app,
      vaultId,
      { key: "MY_ENV_SECRET", category: "environment_variable", secretValue },
      `cred-bind-${vaultId}`,
    );
    expect(cred.statusCode).toBe(201);

    const store = createVaultSecretStore(pool);
    const bindings = await store.resolveBindingsForSession({
      tenantId: TENANT.tenantId,
      sessionId: "sess_test",
      vaultIds: [vaultId],
    });

    const envBinding = bindings.find((b) => b.category === "environment_variable");
    expect(envBinding).toBeDefined();
    expect(envBinding!.placeholderName).toBe("$MSB_MY_ENV_SECRET");
    expect(envBinding!.credentialRef).toEqual({
      tenantId: TENANT.tenantId,
      vaultId,
      credentialKey: "MY_ENV_SECRET",
    });
    // §25.5: the binding must carry NO secret value.
    const serialized = JSON.stringify(bindings);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("secretValue");
  }, 60_000);

  it.skipIf(!RUNTIME)("archive-cascade purges all credential secrets", async () => {
    const vaultId = await createVault(app, "cascade-vault");
    await addCred(
      app,
      vaultId,
      { key: "CRED_A", category: "environment_variable", secretValue: "v_a" },
      `ca-${vaultId}-a`,
    );
    await addCred(
      app,
      vaultId,
      { key: "CRED_B", category: "static_bearer", token: "v_b" },
      `ca-${vaultId}-b`,
    );

    // Confirm secrets are present before archive.
    const before = await query<{ secret_enc: Buffer | null }>(
      pool,
      `SELECT secret_enc FROM vault_credentials WHERE tenant_id = $1 AND vault_id = $2`,
      [TENANT.tenantId, vaultId],
    );
    expect(before.rows.length).toBe(2);
    expect(before.rows.every((r) => r.secret_enc !== null)).toBe(true);

    const arch = await app.inject({
      method: "POST",
      url: `/v1/vaults/${vaultId}/archive`,
      headers: { "idempotency-key": `archive-${vaultId}` },
    });
    expect(arch.statusCode).toBe(200);
    expect(JSON.parse(arch.body).status).toBe("archived");

    // Every credential's secret must now be purged.
    const after = await query<{
      secret_enc: Buffer | null;
      status: string;
    }>(
      pool,
      `SELECT secret_enc, status FROM vault_credentials WHERE tenant_id = $1 AND vault_id = $2`,
      [TENANT.tenantId, vaultId],
    );
    expect(after.rows.length).toBe(2); // records retained for audit
    expect(after.rows.every((r) => r.secret_enc === null)).toBe(true);
    expect(after.rows.every((r) => r.status === "archived")).toBe(true);
  }, 60_000);

  it.skipIf(!RUNTIME)("rejects a duplicate credential key with 409", async () => {
    const vaultId = await createVault(app, "dup-vault");
    const first = await addCred(
      app,
      vaultId,
      { key: "DUP_KEY", category: "environment_variable", secretValue: "first" },
      `dup-${vaultId}-1`,
    );
    expect(first.statusCode).toBe(201);

    const second = await addCred(
      app,
      vaultId,
      { key: "DUP_KEY", category: "environment_variable", secretValue: "second" },
      `dup-${vaultId}-2`,
    );
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("conflict");
  }, 60_000);

  it.skipIf(!RUNTIME)("rejects the 21st credential with 422", async () => {
    const vaultId = await createVault(app, "max-vault");
    for (let i = 0; i < 20; i++) {
      const r = await addCred(
        app,
        vaultId,
        { key: `K${i}`, category: "environment_variable", secretValue: `v${i}` },
        `max-${vaultId}-${i}`,
      );
      expect(r.statusCode, `credential ${i}`).toBe(201);
    }
    const over = await addCred(
      app,
      vaultId,
      { key: "K20", category: "environment_variable", secretValue: "v20" },
      `max-${vaultId}-20`,
    );
    expect(over.statusCode).toBe(422);
    expect(JSON.parse(over.body).error.code).toBe("invalid_request");
  }, 60_000);

  it.skipIf(!RUNTIME)("creates mcp_oauth credentials (Phase 2) with no secret leak", async () => {
    const vaultId = await createVault(app, "oauth-vault");
    const r = await addCred(
      app,
      vaultId,
      {
        key: "https://mcp.example.com",
        category: "mcp_oauth",
        accessToken: "at_secret",
        refreshToken: "rt_secret",
        refresh: {
          method: "client_secret_basic",
          tokenUrl: "https://token.example.com/oauth/token",
          clientId: "cid",
          clientSecret: "csec_secret",
        },
      },
      `oauth-${vaultId}`,
    );
    expect(r.statusCode, r.body).toBe(201);
    assertNoSecrets(r.body, "create mcp_oauth");
  }, 60_000);

  it.skipIf(!RUNTIME)("validate returns the taxonomy (env-var → unknown)", async () => {
    const vaultId = await createVault(app, "validate-vault");
    await addCred(
      app,
      vaultId,
      { key: "VAL_ENV", category: "environment_variable", secretValue: "v" },
      `val-${vaultId}`,
    );
    const r = await app.inject({
      method: "POST",
      url: `/v1/vaults/${vaultId}/credentials/VAL_ENV/validate`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(JSON.parse(r.body).status).toBe("unknown");
  }, 60_000);
});
