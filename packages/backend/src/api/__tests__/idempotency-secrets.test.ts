/**
 * Regression tests: credential-issuing routes must never have their response
 * body persisted by the idempotency middleware (§25.1, §8).
 *
 * `POST /v1/api-keys` returns the raw `pmb_live_…` key and `POST /v1/webhooks`
 * returns the `whsec_…` signing secret — both are "shown once, never stored".
 * Both routes *require* an `Idempotency-Key`, so the middleware's response
 * capture would otherwise write those live credentials into
 * `idempotency_keys.response_body` in plaintext for 24h.
 *
 * Asserts: after issuing, no raw credential appears anywhere in
 * `idempotency_keys`, and a replay of the same key yields 409
 * `idempotency_conflict` (never a re-served secret).
 *
 * Uses a real Postgres via @testcontainers/postgresql; skips when no container
 * runtime is available (mirrors the middleware/__tests__ convention).
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
} from "../../infra/db/index.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { tenantRoutes } from "../tenant.js";
import { webhookRoutes } from "../webhooks.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../infra/db/__tests__/test-runtime.js";

const RUNTIME = hasContainerRuntime();
/** Stable encryption key for the webhook signing-secret round-trip. */
const TEST_KEY = "0".repeat(64);

interface IdemRowSnapshot {
  key_hash: string;
  response_status: number;
  response_body: string | null;
}

async function buildApp(pool: Pool, tenantCtx: TenantCtx): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand-in for the auth middleware: attach tenant context on every request.
  app.addHook("onRequest", async (req) => {
    req.tenantCtx = tenantCtx;
  });
  idempotencyMiddleware(app, pool);
  await app.register(tenantRoutes, { pool });
  await app.register(webhookRoutes, { pool });
  await app.ready();
  return app;
}

describe("idempotency: credential-issuing routes never persist their body", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let tenantCtx: TenantCtx;

  beforeAll(async () => {
    if (!RUNTIME) return;
    process.env.MSB_SECRET_ENCRYPTION_KEY = TEST_KEY;
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });
    const tenant = await createTenant(pool, { name: "Secret Tenant" });
    // scopes: ["admin"] — this fixture injects tenantCtx directly (bypassing
    // issueApiKey), so it must carry a scope explicitly to pass the
    // requireScopeByMethod guard (R0.1) both tenantRoutes and webhookRoutes
    // register (the routes under test are POST /v1/api-keys and POST /v1/webhooks).
    tenantCtx = { tenantId: tenant.id, scopes: ["admin"] };
    app = await buildApp(pool, tenantCtx);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  /** All idempotency rows for the tenant. */
  async function idemRows(): Promise<IdemRowSnapshot[]> {
    const { rows } = await query<IdemRowSnapshot>(
      pool,
      `SELECT key_hash, response_status, response_body
         FROM idempotency_keys WHERE tenant_id = $1`,
      [tenantCtx.tenantId],
    );
    return rows;
  }

  it.skipIf(!RUNTIME)(
    "POST /v1/api-keys: raw pmb_live_ key is not written to idempotency_keys",
    async () => {
      const headers = {
        "idempotency-key": "k-apikey-1",
        "content-type": "application/json",
      };
      const res = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers,
        payload: JSON.stringify({ name: "ci" }),
      });
      expect(res.statusCode).toBe(201);
      const rawKey = JSON.parse(res.body).key as string;
      expect(rawKey).toMatch(/^pmb_live_/);

      // The middleware must have recorded the key for dedup, but with NO body.
      const rows = await idemRows();
      expect(rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(rawKey);
      expect(serialized).not.toContain("pmb_live_");
      for (const row of rows) {
        expect(row.response_body).toBeNull();
      }

      // A replay must NOT re-serve the secret: 409 idempotency_conflict.
      const replay = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        headers,
        payload: JSON.stringify({ name: "ci" }),
      });
      expect(replay.statusCode).toBe(409);
      expect(JSON.parse(replay.body).error.code).toBe("idempotency_conflict");
      expect(replay.body).not.toContain("pmb_live_");
    },
    120_000,
  );

  it.skipIf(!RUNTIME)(
    "POST /v1/webhooks: whsec_ signing secret is not written to idempotency_keys",
    async () => {
      const headers = {
        "idempotency-key": "k-webhook-1",
        "content-type": "application/json",
      };
      const res = await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers,
        payload: JSON.stringify({
          url: "https://hooks.example.com/pi-managed",
          eventTypes: ["session.status_idle"],
        }),
      });
      expect(res.statusCode).toBe(201);
      const secret = JSON.parse(res.body).signingSecret as string;
      expect(secret).toMatch(/^whsec_/);

      const rows = await idemRows();
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("whsec_");
      for (const row of rows) {
        expect(row.response_body).toBeNull();
      }

      const replay = await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers,
        payload: JSON.stringify({
          url: "https://hooks.example.com/pi-managed",
          eventTypes: ["session.status_idle"],
        }),
      });
      expect(replay.statusCode).toBe(409);
      expect(JSON.parse(replay.body).error.code).toBe("idempotency_conflict");
      expect(replay.body).not.toContain("whsec_");
    },
    120_000,
  );
});
