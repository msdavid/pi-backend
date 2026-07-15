/**
 * Idempotency concurrency test (R5.1 — atomic claim-first).
 *
 * The regression: a plain SELECT-then-(later)-INSERT lets two simultaneous
 * requests carrying the SAME `Idempotency-Key` + body both miss the store and
 * both run the mutation. The claim-first `preHandler` (atomic `INSERT … ON
 * CONFLICT DO NOTHING RETURNING`) closes that window: exactly one of N concurrent
 * requests wins the claim and executes the handler; the losers see the in-flight
 * claim and 409 (or, once it settles, replay the stored response).
 *
 * This test fires 20 concurrent identical POSTs against a route that increments a
 * table, then asserts the mutation ran EXACTLY once and that the responses split
 * into a single 2xx winner plus 409 idempotency_conflict losers.
 *
 * Uses a real Postgres via @testcontainers/postgresql (the dispatcher.test.ts
 * pattern); skips when no container runtime is available.
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
import { idempotencyMiddleware } from "../idempotency.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";

const TENANT: TenantCtx = { tenantId: "tnt_concurrency" };
const RUNTIME = hasContainerRuntime();

/**
 * Build an app whose `POST /increment` inserts one row into `mutation_log`
 * (the "mutation") and returns 201. A short delay holds the winner's claim
 * open long enough that the concurrent losers observe the in-flight row and
 * 409, rather than racing past the claim to run the mutation again.
 */
async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    req.tenantCtx = TENANT;
  });
  idempotencyMiddleware(app, pool);
  app.post("/increment", async (_req, reply) => {
    const { rows } = await query<{ id: number }>(
      pool,
      `INSERT INTO mutation_log DEFAULT VALUES RETURNING id`,
    );
    // Hold the claim briefly so peers collide with the in-flight row.
    await new Promise((r) => setTimeout(r, 150));
    return reply.status(201).send({ result: "incremented", id: rows[0].id });
  });
  return app;
}

describe("idempotency middleware — concurrency (R5.1)", () => {
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
      `INSERT INTO tenants (id, name) VALUES ($1, 'Concurrency') ON CONFLICT DO NOTHING`,
      [TENANT.tenantId],
    );
    await query(pool, `CREATE TABLE IF NOT EXISTS mutation_log (id serial PRIMARY KEY)`);
    app = await buildApp(pool);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it.skipIf(!RUNTIME)(
    "20 concurrent identical requests run the mutation exactly once",
    async () => {
      const headers = {
        "idempotency-key": "k-concurrent-1",
        "content-type": "application/json",
      };
      const payload = JSON.stringify({ name: "widget" });

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.inject({ method: "POST", url: "/increment", headers, payload }),
        ),
      );

      // The core R5.1 guarantee: the handler's mutation ran exactly once.
      const { rows } = await query<{ n: string }>(
        pool,
        `SELECT count(*)::text AS n FROM mutation_log`,
      );
      expect(rows[0].n).toBe("1");

      const twoXX = responses.filter(
        (r) => r.statusCode >= 200 && r.statusCode < 300,
      );
      const conflicts = responses.filter((r) => r.statusCode === 409);

      // Every response is accounted for as either the winner or an in-flight loser.
      expect(twoXX.length + conflicts.length).toBe(20);
      // Exactly one request executed the mutation and returned its 2xx response;
      // the other 19 collided with the in-flight claim and 409'd.
      expect(twoXX.length).toBe(1);
      expect(conflicts.length).toBe(19);

      // Losers carry the idempotency_conflict envelope.
      for (const r of conflicts) {
        expect(JSON.parse(r.body).error.code).toBe("idempotency_conflict");
      }

      // The winning response references the single mutation row.
      expect(JSON.parse(twoXX[0].body).id).toBe(1);
    },
    60_000,
  );
});
