/**
 * Transactional quota concurrency test (R5.2, §27.3).
 *
 * The pre-flight COUNT enforcement (`checkQuota` in the middleware) is racy: N
 * concurrent creates all read the same under-limit count and all pass, so a
 * tenant can blow past its concurrent-session (or job) limit under load. R5.2
 * moves the check INSIDE the create transaction via the `tenant_quota_counters`
 * row lock — `reserveQuota` increments and compares atomically, rolling back the
 * increment (and rejecting 429) when the new count would exceed the plan limit.
 *
 * This test fires 10 concurrent creates through the REAL create path
 * (`createSession`) against a plan whose `concurrentSessions` limit is pinned to
 * 3, and asserts that EXACTLY 3 succeed and the other 7 are rejected 429
 * `rate_limited` — the property the racy pre-flight COUNT cannot guarantee.
 *
 * The limit is pinned via a `QUOTA_PLAN_FREE` env override applied with
 * `vi.hoisted` (which runs before the quota modules parse overrides at import).
 *
 * Uses testcontainers-postgres (real migrations). Skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Pin the free plan's concurrent-session limit to 3 BEFORE the quota modules are
// imported (tiers.ts parses QUOTA_PLAN_* overrides at module load). vi.hoisted
// is lifted above the imports below, so the override is in place in time.
vi.hoisted(() => {
  process.env.QUOTA_PLAN_FREE = JSON.stringify({
    concurrentSessions: 3,
    maxJobs: 3,
    // 300-byte ceiling so 10 concurrent 100-byte reserves admit exactly 3 (ROB-15).
    maxFileStorageBytes: 300,
  });
});

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
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { FakeObjectStore } from "@pi-managed/testkit";
import { createApp } from "../../../server.js";
import { ApiError } from "../../errors.js";
import { loadConfig } from "../../../infra/config/index.js";
import { createTenant } from "../../tenant/tenant.js";
import { issueApiKey } from "../../tenant/api-key.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/index.js";
import { planForName, reserveQuotaDelta } from "../index.js";

const RUNTIME = hasContainerRuntime();

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

function baseAgentConfig() {
  return {
    name: "quota-runner",
    model: MODEL,
    systemPrompt: "BASE",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: {},
    },
    skills: [],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: {},
  };
}

describe.skipIf(!RUNTIME)("transactional quota concurrency (R5.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;

  const LIMIT = 3;
  const ATTEMPTS = 10;

  beforeAll(async () => {
    db = await startPostgres();
    // Give the pool headroom: each concurrent create holds one connection for
    // its reservation transaction while it waits on the counter row lock.
    pool = createPool({ connectionString: db.connectionString, max: 20 });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Quota Concurrency", quotaPlan: "free" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "cloud-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 1024 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("the env override pins the free concurrent-session limit to 3", () => {
    // Guards the whole test: if the vi.hoisted override did not take effect the
    // limit would be the seeded default and the counts below would be wrong.
    expect(planForName("free").concurrentSessions).toBe(LIMIT);
  });

  it(`admits exactly the limit under ${ATTEMPTS} concurrent creates; the rest are 429`, async () => {
    // Fire all creates concurrently through the real create path.
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () =>
        createSession(pool, ctx, { agent: agentId, environmentId: envId }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly `LIMIT` succeed; the rest are rejected — the property the racy
    // pre-flight COUNT cannot guarantee (it would let all 10 through).
    expect(fulfilled.length).toBe(LIMIT);
    expect(rejected.length).toBe(ATTEMPTS - LIMIT);

    // Every rejection is a 429 rate_limited quota error.
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ApiError);
      const err = r.reason as ApiError;
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe("rate_limited");
      expect(err.details).toMatchObject({ resource: "concurrentSessions", limit: LIMIT });
    }

    // The durable truth agrees: exactly `LIMIT` session rows exist and the
    // counter row settled at `LIMIT` (over-limit reservations rolled back).
    const sessionCount = await query<{ count: string }>(
      pool,
      `SELECT count(*)::text AS count FROM sessions WHERE tenant_id = $1`,
      [ctx.tenantId],
    );
    expect(Number(sessionCount.rows[0].count)).toBe(LIMIT);

    const counter = await query<{ count: string }>(
      pool,
      `SELECT count FROM tenant_quota_counters
        WHERE tenant_id = $1 AND resource = 'concurrentSessions'`,
      [ctx.tenantId],
    );
    expect(Number(counter.rows[0].count)).toBe(LIMIT);
  });

  it("a further create past the settled limit is also rejected 429", async () => {
    await expect(
      createSession(pool, ctx, { agent: agentId, environmentId: envId }),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });
  });

  // ROB-15: file storage (an amount/delta dimension) is race-safe via the same
  // atomic counter reservation. 10 concurrent 100-byte reserves against a
  // 300-byte ceiling must admit EXACTLY 3 — the property the pre-flight
  // SUM(size_bytes) cannot guarantee (all 10 read the same under-limit sum).
  it("reserveQuotaDelta admits exactly the byte ceiling under concurrency", async () => {
    // Fresh tenant so the byte counter starts at 0 (this file's tenant already
    // ran the session tests; use a dedicated one to isolate the byte dimension).
    const t = await createTenant(pool, {
      name: "Byte Concurrency",
      quotaPlan: "free",
    });
    const byteCtx: TenantCtx = { tenantId: t.id };
    const CHUNK = 100;
    const results = await Promise.allSettled(
      Array.from({ length: ATTEMPTS }, () =>
        reserveQuotaDelta(pool, byteCtx, "maxFileStorageBytes", CHUNK),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled.length).toBe(3); // 300 / 100
    expect(rejected.length).toBe(ATTEMPTS - 3);
    for (const r of rejected) {
      const err = r.reason as ApiError;
      expect(err.statusCode).toBe(429);
      expect(err.code).toBe("rate_limited");
      expect(err.details).toMatchObject({ resource: "maxFileStorageBytes", limit: 300 });
    }

    // The counter settled at exactly the ceiling (over-limit reserves wrote nothing).
    const counter = await query<{ count: string }>(
      pool,
      `SELECT count FROM tenant_quota_counters
        WHERE tenant_id = $1 AND resource = 'maxFileStorageBytes'`,
      [t.id],
    );
    expect(Number(counter.rows[0].count)).toBe(300);
  });
});

/**
 * The counter is only correct if a reservation is RELEASED when the resource
 * goes away. A session leaves the concurrent set exactly once — when
 * `DELETE /v1/sessions/:id` archives it — so the release is hooked on that
 * response (`api/middleware/quota.ts`). Without it the counter ratchets up and a
 * tenant that deletes everything still cannot create: the leak this asserts is
 * absent. Driven over the REAL app (createApp → real routes → real middleware),
 * not a stub.
 */
describe.skipIf(!RUNTIME)("counter release on delete (R5.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let apiKey: string;
  let envId: string;
  let agentId: string;

  const LIMIT = 3;

  const auth = () => ({ authorization: `Bearer ${apiKey}` });
  let idem = 0;
  const headers = () => ({
    ...auth(),
    "idempotency-key": `quota-rel-${idem++}`,
    "content-type": "application/json",
  });

  const createOverHttp = () =>
    app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: headers(),
      payload: JSON.stringify({ agent: agentId, environmentId: envId }),
    });

  async function counter(): Promise<number> {
    const { rows } = await query<{ count: string }>(
      pool,
      `SELECT count FROM tenant_quota_counters
        WHERE tenant_id = $1 AND resource = 'concurrentSessions'`,
      [tenantId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString, max: 10 });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Quota Release", quotaPlan: "free" });
    tenantId = t.id;
    apiKey = (await issueApiKey(pool, { tenantId }, { name: "k" })).key;

    const ctx: TenantCtx = { tenantId };
    agentId = (await createAgent(pool, ctx, baseAgentConfig())).id;
    envId = (
      await createEnvironment(pool, ctx, {
        name: "cloud-env",
        type: "cloud",
        resources: { cpus: 1, memoryMiB: 1024 },
        networking: { mode: "unrestricted" },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("deleting a session frees its slot, so the next create is admitted", async () => {
    // Fill the plan: 3 creates admitted, the 4th rejected 429.
    const created = [];
    for (let i = 0; i < LIMIT; i++) {
      const res = await createOverHttp();
      expect(res.statusCode).toBe(201);
      created.push(res.json().id as string);
    }
    expect(await counter()).toBe(LIMIT);

    const over = await createOverHttp();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");

    // Delete one → 204 → the onResponse hook decrements the counter.
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created[0]}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(204);
    expect(await counter()).toBe(LIMIT - 1);

    // The freed slot is usable, and the plan still caps at LIMIT afterwards.
    const again = await createOverHttp();
    expect(again.statusCode).toBe(201);
    expect(await counter()).toBe(LIMIT);
    expect((await createOverHttp()).statusCode).toBe(429);
  });

  it("a failed delete (404) does not release a slot", async () => {
    const before = await counter();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/sessions/sess_does_not_exist",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(await counter()).toBe(before);
  });
});
