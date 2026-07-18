/**
 * `GET /v1/sessions` — `stopReason` filter + `usage.usdCost` rollup (WP-C2.0).
 *
 * HTTP-level coverage over a real Postgres testcontainer + `createApp`, so the
 * assertions exercise the shipped chain (auth → scope guard → route → repo SQL):
 *
 *  - `?stopReason=` returns exactly the matching sessions and combines with
 *    `?status=` (console C§7.5 — global `requires_action` surfacing);
 *  - filter values outside the contracts enums (`?status=bogus`,
 *    `?stopReason=bogus`) are `422 invalid_request`, not a silent empty page;
 *  - `usage.usdCost` on the list and detail payloads equals the
 *    `GET /v1/sessions/:id/usage` rollup for the same session (single joined
 *    query — the values come from real `usage_records` rows written through the
 *    production `PgUsageRecorder`);
 *  - the filter and the rollup are tenant-scoped: one tenant never sees another
 *    tenant's sessions or spend.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
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
import { updateSessionStatus } from "../../domain/session/session-repo.js";
import { createUsageRecorder } from "../../domain/usage/usage-recorder.js";
import type { PriceTable } from "../../domain/usage/prices.js";
import { FakeObjectStore } from "@pi-managed/testkit";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

/** Deterministic per-token rates so the expected USD is exact. */
const PRICES: PriceTable = {
  "unknown-model": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0,
    cacheReadPerToken: 0,
  },
  "test-model": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0,
    cacheReadPerToken: 0,
  },
};

/** 2 × (1000·0.000003 + 500·0.000015) — the seeded spend of `aRequires`. */
const A_REQUIRES_USD = 0.021;
/** 100·0.000003 — the seeded spend of `bRequires`. */
const B_REQUIRES_USD = 0.0003;

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

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

interface SessionWire {
  id: string;
  status: string;
  stopReason: string | null;
  usage: { usdCost?: number };
}

describe("GET /v1/sessions — stopReason filter + usdCost rollup (WP-C2.0)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let keyA: string;
  let keyB: string;
  /** Tenant A: idle + requires_action, with seeded usage_records spend. */
  let aRequires: string;
  /** Tenant A: idle + completed (no spend). */
  let aCompleted: string;
  /** Tenant A: running (stopReason null). */
  let aRunning: string;
  /** Tenant B: idle + requires_action, with its own (smaller) spend. */
  let bRequires: string;

  async function seedTenant(name: string) {
    const t = await createTenant(pool, { name });
    const ctx: TenantCtx = { tenantId: t.id };
    const key = (
      await issueApiKey(pool, ctx, { name: "list-read", scopes: ["read"] })
    ).key;
    const agent = await createAgent(pool, ctx, agentConfig(`list-agent-${name}`));
    const env = await createEnvironment(pool, ctx, {
      name: `list-env-${name}`,
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    return { ctx, key, agentId: agent.id, envId: env.id };
  }

  async function list(key: string, query = ""): Promise<SessionWire[]> {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions${query}`,
      headers: auth(key),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: SessionWire[] }).data;
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

    const a = await seedTenant("Sessions List Tenant A");
    const b = await seedTenant("Sessions List Tenant B");
    keyA = a.key;
    keyB = b.key;

    const mk = async (t: typeof a) =>
      (await createSession(pool, t.ctx, { agent: t.agentId, environmentId: t.envId })).id;
    aRequires = await mk(a);
    aCompleted = await mk(a);
    aRunning = await mk(a);
    bRequires = await mk(b);

    // Drive the stop reasons through the production status writer (R2.8), the
    // same path the runtime uses when a session settles.
    await updateSessionStatus(pool, a.ctx, aRequires, "idle", "requires_action");
    await updateSessionStatus(pool, a.ctx, aCompleted, "idle", "completed");
    await updateSessionStatus(pool, a.ctx, aRunning, "running", null);
    await updateSessionStatus(pool, b.ctx, bRequires, "idle", "requires_action");

    // Seed spend through the production recorder → real `usage_records` rows.
    const recorder = createUsageRecorder({ pool, priceTable: PRICES });
    const tokens = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    await recorder.record(aRequires, "test-model", tokens);
    await recorder.record(aRequires, "test-model", tokens);
    await recorder.record(bRequires, "test-model", {
      ...tokens,
      inputTokens: 100,
      outputTokens: 0,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("?stopReason=requires_action returns exactly the matching sessions", async () => {
    const data = await list(keyA, "?stopReason=requires_action");
    expect(data.map((s) => s.id)).toEqual([aRequires]);
    expect(data[0].stopReason).toBe("requires_action");
  });

  it("stopReason combines with status", async () => {
    const idle = await list(keyA, "?status=idle&stopReason=requires_action");
    expect(idle.map((s) => s.id)).toEqual([aRequires]);
    // A contradictory combination matches nothing.
    const running = await list(keyA, "?status=running&stopReason=requires_action");
    expect(running).toEqual([]);
  });

  it("filter values outside the contracts enums are 422 invalid_request", async () => {
    // Contract drift guard: `SessionListParams` pins closed enums (golden test
    // rejects "bogus"), so the route must reject them too — never a silent
    // empty page.
    for (const query of ["?stopReason=bogus", "?status=bogus"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/sessions${query}`,
        headers: auth(keyA),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_request");
    }
  });

  it("usage.usdCost rollup matches the usage endpoint (list, detail, /usage agree)", async () => {
    const rows = await list(keyA);
    const listRow = rows.find((s) => s.id === aRequires);
    expect(listRow?.usage.usdCost).toBeCloseTo(A_REQUIRES_USD, 6);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/sessions/${aRequires}`,
      headers: auth(keyA),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as SessionWire).usage.usdCost).toBeCloseTo(A_REQUIRES_USD, 6);

    const usage = await app.inject({
      method: "GET",
      url: `/v1/sessions/${aRequires}/usage`,
      headers: auth(keyA),
    });
    expect(usage.statusCode).toBe(200);
    const usdCost = (usage.json() as { usdCost: number }).usdCost;
    expect(usdCost).toBeCloseTo(A_REQUIRES_USD, 6);
    expect(listRow?.usage.usdCost).toBe(usdCost);

    // A session with no usage_records rolls up to exactly 0.
    const noSpend = rows.find((s) => s.id === aCompleted);
    expect(noSpend?.usage.usdCost).toBe(0);
  });

  it("filter and rollup are tenant-scoped (no cross-tenant leak)", async () => {
    // Tenant B's filter sees only its own requires_action session + spend.
    const bData = await list(keyB, "?stopReason=requires_action");
    expect(bData.map((s) => s.id)).toEqual([bRequires]);
    expect(bData[0].usage.usdCost).toBeCloseTo(B_REQUIRES_USD, 6);

    // Tenant A never sees tenant B's session, filtered or not.
    const aAll = await list(keyA);
    expect(aAll.map((s) => s.id)).not.toContain(bRequires);
    const aFiltered = await list(keyA, "?stopReason=requires_action");
    expect(aFiltered.map((s) => s.id)).not.toContain(bRequires);
  });
});
