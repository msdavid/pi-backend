/**
 * `GET /v1/tenant/usage` — time-bucketed usage rollup (WP-C3.0, console §11.5).
 *
 * HTTP-level coverage over a real Postgres testcontainer + `createApp`, so the
 * assertions exercise the shipped chain (auth → scope guard → route → domain
 * SQL). Spend is seeded through the production `PgUsageRecorder` (real
 * `usage_records` rows); each seed then pins `recorded_at` to an explicit UTC
 * instant so the bucket math is deterministic:
 *
 *  - day/month buckets are UTC-aligned (a record at `23:59:59Z` lands in that
 *    day, one at `00:00:00Z` in the next);
 *  - `groupBy=agent` / `groupBy=user` split buckets by `sessions.agent_id` /
 *    `metadata.userId` (null for sessions without one);
 *  - `from` is inclusive, `to` exclusive; an empty range returns no rows;
 *  - the rollup is tenant-scoped: one tenant never sees another's spend;
 *  - malformed params and out-of-policy ranges are `422 invalid_request`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { createAgent } from "../../domain/agent/agent.js";
import { createEnvironment } from "../../domain/environment/environment.js";
import { createSession } from "../../domain/session/index.js";
import { createUsageRecorder } from "../../domain/usage/usage-recorder.js";
import type { PriceTable } from "../../domain/usage/prices.js";
import { FakeObjectStore } from "@pi-managed/testkit";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

/**
 * Deterministic per-token rates so the expected USD is exact. Every seeded
 * model name falls back to `unknown-model`, and seeds carry input tokens only,
 * so each row's cost is `inputTokens × 0.000003`.
 */
const PRICES: PriceTable = {
  "unknown-model": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0,
    cacheReadPerToken: 0,
  },
};

/** A wide query window containing every seeded row. */
const WINDOW = "from=2026-06-01T00:00:00Z&to=2026-07-10T00:00:00Z";

interface BucketWire {
  bucketStart: string;
  agentId?: string;
  userId?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  usdCost: number;
}

interface UsageWire {
  granularity: string;
  from: string;
  to: string;
  groupBy?: string;
  data: BucketWire[];
}

describe("GET /v1/tenant/usage — bucketed rollup (WP-C3.0)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let keyA: string;
  let keyB: string;
  let agentA1: string;
  let agentA2: string;
  let agentB: string;

  async function seedTenant(name: string) {
    const t = await createTenant(pool, { name });
    const ctx: TenantCtx = { tenantId: t.id };
    const key = (
      await issueApiKey(pool, ctx, { name: "usage-read", scopes: ["read"] })
    ).key;
    const env = await createEnvironment(pool, ctx, {
      name: `usage-env-${name}`,
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    return { ctx, key, envId: env.id };
  }

  function agentConfig(name: string) {
    return {
      name,
      model: MODEL,
      systemPrompt: "You are a careful assistant.",
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

  /**
   * Seed one `usage_records` row through the production recorder, then pin its
   * `recorded_at` (which defaults to now()) to the given UTC instant. The
   * per-seed unique `model` name identifies the freshly inserted row.
   */
  async function seedUsage(
    ctx: TenantCtx,
    sessionId: string,
    model: string,
    inputTokens: number,
    recordedAt: string,
  ) {
    const recorder = createUsageRecorder({ pool, priceTable: PRICES });
    await recorder.record(sessionId, model, {
      inputTokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    await tenantScopedQuery(
      pool,
      ctx,
      `UPDATE usage_records SET recorded_at = $2
       WHERE tenant_id = $1 AND session_id = $3 AND model = $4`,
      [ctx.tenantId, recordedAt, sessionId, model],
    );
  }

  async function get(key: string, query = ""): Promise<UsageWire> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/tenant/usage${query}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as UsageWire;
  }

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });

    const a = await seedTenant("Tenant Usage Tenant A");
    const b = await seedTenant("Tenant Usage Tenant B");
    keyA = a.key;
    keyB = b.key;
    agentA1 = (await createAgent(pool, a.ctx, agentConfig("usage-agent-a1"))).id;
    agentA2 = (await createAgent(pool, a.ctx, agentConfig("usage-agent-a2"))).id;
    agentB = (await createAgent(pool, b.ctx, agentConfig("usage-agent-b"))).id;

    const s1 = (
      await createSession(pool, a.ctx, {
        agent: agentA1,
        environmentId: a.envId,
        metadata: { userId: "u_alice" },
      })
    ).id;
    const s2 = (
      await createSession(pool, a.ctx, {
        agent: agentA2,
        environmentId: a.envId,
        metadata: { userId: "u_bob" },
      })
    ).id;
    // No metadata.userId — groups as `userId: null` under groupBy=user.
    const s3 = (
      await createSession(pool, a.ctx, { agent: agentA1, environmentId: a.envId })
    ).id;
    const sB = (
      await createSession(pool, b.ctx, { agent: agentB, environmentId: b.envId })
    ).id;

    // Tenant A: 15000 input tokens / 0.045 USD across three UTC days, straddling
    // the June→July month boundary. Tenant B: one (much larger) July row.
    await seedUsage(a.ctx, s1, "seed-1", 1000, "2026-06-30T23:59:59Z");
    await seedUsage(a.ctx, s1, "seed-2", 2000, "2026-07-01T00:00:00Z");
    await seedUsage(a.ctx, s2, "seed-3", 4000, "2026-07-01T05:00:00Z");
    await seedUsage(a.ctx, s3, "seed-4", 8000, "2026-07-02T12:00:00Z");
    await seedUsage(b.ctx, sB, "seed-b", 100000, "2026-07-01T06:00:00Z");
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("day buckets are UTC-aligned (23:59:59Z → that day; 00:00:00Z → the next)", async () => {
    const body = await get(keyA, `?granularity=day&${WINDOW}`);
    expect(body.granularity).toBe("day");
    expect(body.from).toBe("2026-06-01T00:00:00.000Z");
    expect(body.to).toBe("2026-07-10T00:00:00.000Z");
    expect(body.groupBy).toBeUndefined();

    expect(body.data.map((r) => [r.bucketStart, r.inputTokens])).toEqual([
      ["2026-06-30T00:00:00.000Z", 1000],
      ["2026-07-01T00:00:00.000Z", 6000],
      ["2026-07-02T00:00:00.000Z", 8000],
    ]);
    expect(body.data[0].usdCost).toBeCloseTo(0.003, 6);
    expect(body.data[1].usdCost).toBeCloseTo(0.018, 6);
    expect(body.data[2].usdCost).toBeCloseTo(0.024, 6);
    // Ungrouped rows carry neither group key.
    expect(body.data[0].agentId).toBeUndefined();
    expect(body.data[0].userId).toBeUndefined();
  });

  it("month buckets straddle the June→July boundary", async () => {
    const body = await get(keyA, `?granularity=month&${WINDOW}`);
    expect(body.data.map((r) => [r.bucketStart, r.inputTokens])).toEqual([
      ["2026-06-01T00:00:00.000Z", 1000],
      ["2026-07-01T00:00:00.000Z", 14000],
    ]);
    expect(body.data[1].usdCost).toBeCloseTo(0.042, 6);
  });

  it("groupBy=agent splits each bucket by sessions.agent_id", async () => {
    const body = await get(
      keyA,
      "?granularity=day&from=2026-07-01T00:00:00Z&to=2026-07-03T00:00:00Z&groupBy=agent",
    );
    expect(body.groupBy).toBe("agent");
    // Within a bucket, rows sort by agent id ascending.
    const july1 = [
      [agentA1, 2000],
      [agentA2, 4000],
    ].sort(([x], [y]) => String(x).localeCompare(String(y)));
    expect(body.data.map((r) => [r.agentId, r.inputTokens])).toEqual([
      ...july1,
      [agentA1, 8000],
    ]);
    expect(body.data.map((r) => r.bucketStart)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
    ]);
  });

  it("groupBy=user splits by metadata.userId, null for unattributed sessions", async () => {
    const body = await get(keyA, `?granularity=day&${WINDOW}&groupBy=user`);
    expect(body.groupBy).toBe("user");
    expect(body.data.map((r) => [r.bucketStart, r.userId, r.inputTokens])).toEqual([
      ["2026-06-30T00:00:00.000Z", "u_alice", 1000],
      ["2026-07-01T00:00:00.000Z", "u_alice", 2000],
      ["2026-07-01T00:00:00.000Z", "u_bob", 4000],
      ["2026-07-02T00:00:00.000Z", null, 8000],
    ]);
  });

  it("range is from-inclusive / to-exclusive", async () => {
    // r2 sits exactly on `from` (included); r3 exactly on `to` (excluded).
    const body = await get(
      keyA,
      "?from=2026-07-01T00:00:00Z&to=2026-07-01T05:00:00Z",
    );
    expect(body.data.map((r) => [r.bucketStart, r.inputTokens])).toEqual([
      ["2026-07-01T00:00:00.000Z", 2000],
    ]);
  });

  it("an empty range returns no rows", async () => {
    const body = await get(keyA, "?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
    expect(body.data).toEqual([]);
  });

  it("defaults: granularity=day over the trailing 30 days", async () => {
    const body = await get(keyA);
    expect(body.granularity).toBe("day");
    const span = new Date(body.to).getTime() - new Date(body.from).getTime();
    expect(span).toBe(30 * 24 * 60 * 60 * 1000);
    // `to` defaults to now (echoed as RFC 3339 UTC).
    expect(Math.abs(Date.now() - new Date(body.to).getTime())).toBeLessThan(60_000);
  });

  it("rollup is tenant-scoped (no cross-tenant leak)", async () => {
    // Tenant A's series never includes tenant B's 100000-token July row.
    const a = await get(keyA, `?granularity=day&${WINDOW}`);
    const aTotalUsd = a.data.reduce((sum, r) => sum + r.usdCost, 0);
    expect(aTotalUsd).toBeCloseTo(0.045, 6);
    expect(a.data.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(15000);

    // Tenant B sees exactly its own spend — grouped and ungrouped.
    const b = await get(keyB, `?granularity=day&${WINDOW}`);
    expect(b.data.map((r) => [r.bucketStart, r.inputTokens])).toEqual([
      ["2026-07-01T00:00:00.000Z", 100000],
    ]);
    expect(b.data[0].usdCost).toBeCloseTo(0.3, 6);
    const bByAgent = await get(keyB, `?${WINDOW}&groupBy=agent`);
    expect(bByAgent.data.map((r) => r.agentId)).toEqual([agentB]);
  });

  it("malformed params and out-of-policy ranges are 422 invalid_request", async () => {
    const expect422 = async (query: string) => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/tenant/usage${query}`,
        headers: { authorization: `Bearer ${keyA}` },
      });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "invalid_request",
      );
    };
    await expect422("?granularity=week");
    await expect422("?groupBy=model");
    await expect422("?from=not-a-timestamp");
    // from must be strictly before to.
    await expect422("?from=2026-07-02T00:00:00Z&to=2026-07-01T00:00:00Z");
    await expect422("?from=2026-07-01T00:00:00Z&to=2026-07-01T00:00:00Z");
    // Span caps: 366 days (day) / 24 months (month).
    await expect422("?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z");
    await expect422(
      "?granularity=month&from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    );
  });
});
