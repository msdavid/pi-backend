/**
 * Idempotency middleware integration tests (WP-P0.5, §"`Idempotency-Key`").
 *
 * - Replayed POST returns the stored response byte-for-byte (same status + body).
 * - Same key + different request body → 409 idempotency_conflict.
 *
 * Uses a real Postgres via @testcontainers/postgresql; skips when no container
 * runtime is available (mirrors the db/__tests__ convention).
 */

import { createHash } from "node:crypto";
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
import { idempotencyMiddleware } from "../idempotency.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";

const TENANT: TenantCtx = { tenantId: "tnt_test" };
const RUNTIME = hasContainerRuntime();

async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand-in for P0.4 auth: attach tenant context on every request.
  app.addHook("onRequest", async (req) => {
    req.tenantCtx = TENANT;
  });
  idempotencyMiddleware(app, pool);
  app.post("/widgets", async (_req, reply) => {
    return reply.status(201).send({ result: "created", id: "w_01", n: 1 });
  });
  return app;
}

describe("idempotency middleware", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!RUNTIME) return;
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });
    await query(pool, `INSERT INTO tenants (id, name) VALUES ($1, 'Test') ON CONFLICT DO NOTHING`, [
      TENANT.tenantId,
    ]);
    app = await buildApp(pool);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it.skipIf(!RUNTIME)("replays the stored response byte-for-byte", async () => {
    const headers = { "idempotency-key": "k-replay-1", "content-type": "application/json" };
    const body = JSON.stringify({ name: "widget" });
    const first = await app.inject({ method: "POST", url: "/widgets", headers, payload: body });
    expect(first.statusCode).toBe(201);
    const firstBody = first.body;

    const second = await app.inject({ method: "POST", url: "/widgets", headers, payload: body });
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(firstBody);
  }, 60_000);

  it.skipIf(!RUNTIME)("same key + different body → 409 idempotency_conflict", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "idempotency-key": "k-conflict-1", "content-type": "application/json" },
      payload: JSON.stringify({ name: "a" }),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/widgets",
      headers: { "idempotency-key": "k-conflict-1", "content-type": "application/json" },
      payload: JSON.stringify({ name: "b" }),
    });
    expect(second.statusCode).toBe(409);
    const parsed = JSON.parse(second.body);
    expect(parsed.error.code).toBe("idempotency_conflict");
  }, 60_000);

  /** Seed an in-flight placeholder claim (response_status = 0) with a given age. */
  async function seedClaim(key: string, claimedAtSql: string): Promise<void> {
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    await query(
      pool,
      `INSERT INTO idempotency_keys
         (tenant_id, key_hash, request_body_hash, response_status, response_body,
          claimed_at, expires_at)
       VALUES ($1, $2, 'seed-body-hash', 0, NULL,
               ${claimedAtSql}, now() + interval '24 hours')`,
      [TENANT.tenantId, keyHash],
    );
  }

  it.skipIf(!RUNTIME)(
    "reclaims a stale in-progress claim so a crashed request's key is reusable (ROB-12)",
    async () => {
      // A claim older than the lease with an unexpired 24h TTL: the original
      // holder crashed before onSend released/overwrote the placeholder.
      await seedClaim("k-stale-reclaim-1", "now() - interval '10 minutes'");

      const res = await app.inject({
        method: "POST",
        url: "/widgets",
        headers: { "idempotency-key": "k-stale-reclaim-1", "content-type": "application/json" },
        payload: JSON.stringify({ name: "widget" }),
      });

      // Reclaimed → the handler ran (201), not a 409 "request in progress".
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).result).toBe("created");
    },
    60_000,
  );

  it.skipIf(!RUNTIME)(
    "does NOT reclaim a fresh in-progress claim — 409 in-progress (ROB-12)",
    async () => {
      // A claim within the lease is a genuinely in-flight peer: never stolen.
      await seedClaim("k-fresh-inflight-1", "now()");

      const res = await app.inject({
        method: "POST",
        url: "/widgets",
        headers: { "idempotency-key": "k-fresh-inflight-1", "content-type": "application/json" },
        payload: JSON.stringify({ name: "widget" }),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe("idempotency_conflict");
    },
    60_000,
  );
});
