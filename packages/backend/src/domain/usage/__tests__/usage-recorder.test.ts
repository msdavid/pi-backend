/**
 * UsageRecorder + budget enforcement integration (WP-1.10, §9.7, §6.3).
 *
 * Done-criteria coverage:
 * - `record` → `cumulativeForSession` round-trip (tokens + USD).
 * - unknown-model fallback pricing.
 * - `checkBudget` exceeded on `maxTokens` and `maxUsd`.
 * - per-tenant rollup (`rollupForTenant`) incl. cross-tenant isolation.
 *
 * Uses testcontainers-postgres with real migrations via the shared test runtime.
 * Sessions have FKs to tenants/agents/environments; the helper below stages a
 * minimal fixture with raw SQL (the sessions domain service lands in WP-1.5).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { newId } from "../../tenant/ids.js";
import { PgUsageRecorder } from "../usage-recorder.js";
import { enforceBudget } from "../budget.js";
import { loadPriceTable, FALLBACK_MODEL_KEY } from "../prices.js";
import type { TokenCounts } from "../../ports.js";

/** A session fixture: tenant + agent + environment + session row. */
async function stageSession(pool: Pool, tenantId: string, label: string) {
  const agentId = newId("agent_");
  const envId = newId("env_");
  const sessionId = newId("sess_");
  await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
    tenantId,
    agentId,
    `agent-${label}`,
  ]);
  await query(
    pool,
    `INSERT INTO environments (tenant_id, id, name, type, image, resources, networking)
     VALUES ($1, $2, $3, 'cloud', 'ubuntu:22.04', '{}'::jsonb, '{"mode":"unrestricted"}'::jsonb)`,
    [tenantId, envId, `env-${label}`],
  );
  await query(
    pool,
    `INSERT INTO sessions (tenant_id, id, agent_id, agent_version, environment_id, jsonl_object_key)
     VALUES ($1, $2, $3, 1, $4, $5)`,
    [tenantId, sessionId, agentId, envId, `tenants/${tenantId}/sessions/${sessionId}/log.jsonl`],
  );
  return { sessionId };
}

const TOKENS: TokenCounts = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheCreationInputTokens: 200,
  cacheReadInputTokens: 100,
};

describe("PgUsageRecorder (WP-1.10)", () => {
  let db: TestDb;
  let pool: Pool;
  let recorder: PgUsageRecorder;
  let tenantA: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const tA = await createTenant(pool, { name: "Usage Tenant A" });
    tenantA = tA.id;
    recorder = new PgUsageRecorder({ pool, priceTable: loadPriceTable() });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("record → cumulativeForSession round-trips tokens and USD", async () => {
    const { sessionId } = await stageSession(pool, tenantA, "rt");
    const model = "anthropic/claude-sonnet-4";
    await recorder.record(sessionId, model, TOKENS);
    await recorder.record(sessionId, model, TOKENS);

    const usage = await recorder.cumulativeForSession(sessionId);
    expect(usage.inputTokens).toBe(2_000);
    expect(usage.outputTokens).toBe(1_000);
    expect(usage.cacheCreationInputTokens).toBe(400);
    expect(usage.cacheReadInputTokens).toBe(200);
    expect(usage.totalTokens).toBe(3_600);

    const expectedUsd = recorder.usdCost(model, TOKENS) * 2;
    expect(usage.usd).toBeCloseTo(expectedUsd, 6);
  });

  it("usdCost uses the unknown-model fallback for unmapped models", async () => {
    const { sessionId } = await stageSession(pool, tenantA, "fallback");
    const unknown = "some-provider/exotic-model";
    await recorder.record(sessionId, unknown, TOKENS);
    const usage = await recorder.cumulativeForSession(sessionId);

    const fallback = loadPriceTable()[FALLBACK_MODEL_KEY];
    const expected =
      TOKENS.inputTokens * fallback.inputPerToken +
      TOKENS.outputTokens * fallback.outputPerToken +
      TOKENS.cacheCreationInputTokens * fallback.cacheCreationPerToken +
      TOKENS.cacheReadInputTokens * fallback.cacheReadPerToken;
    expect(usage.usd).toBeCloseTo(expected, 6);
    expect(recorder.usdCost(unknown, TOKENS)).toBeCloseTo(expected, 6);
  });

  it("checkBudget reports exceeded on maxTokens", async () => {
    const { sessionId } = await stageSession(pool, tenantA, "btok");
    await recorder.record(sessionId, "anthropic/claude-sonnet-4", TOKENS); // 1800 tokens
    const check = await recorder.checkBudget(sessionId, { maxTokens: 1_800 });
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_tokens_exceeded");
    // just under the cap is not exceeded
    const under = await recorder.checkBudget(sessionId, { maxTokens: 1_801 });
    expect(under.exceeded).toBe(false);
  });

  it("checkBudget reports exceeded on maxUsd", async () => {
    const { sessionId } = await stageSession(pool, tenantA, "busd");
    await recorder.record(sessionId, "anthropic/claude-sonnet-4", TOKENS);
    const usage = await recorder.cumulativeForSession(sessionId);
    const check = await recorder.checkBudget(sessionId, {
      maxUsd: usage.usd,
    });
    expect(check.exceeded).toBe(true);
    expect(check.reason).toBe("max_usd_exceeded");
  });

  it("enforceBudget returns budget_exhausted stop reason on breach", async () => {
    const { sessionId } = await stageSession(pool, tenantA, "enf");
    await recorder.record(sessionId, "anthropic/claude-sonnet-4", TOKENS);
    const result = await enforceBudget(
      sessionId,
      { maxTokens: 1 },
      recorder,
    );
    expect(result.exceeded).toBe(true);
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.reason).toBe("max_tokens_exceeded");
    // no breach
    const ok = await enforceBudget(
      sessionId,
      { maxTokens: 1_000_000 },
      recorder,
    );
    expect(ok.exceeded).toBe(false);
    expect(ok.stopReason).toBeUndefined();
  });

  it("rollupForTenant aggregates per-tenant with cross-tenant isolation", async () => {
    const tA = await createTenant(pool, { name: "Roll Tenant A" });
    const tB = await createTenant(pool, { name: "Roll Tenant B" });
    const sA = await stageSession(pool, tA.id, "rollA");
    const sB = await stageSession(pool, tB.id, "rollB");
    await recorder.record(sA.sessionId, "anthropic/claude-sonnet-4", TOKENS);
    await recorder.record(sA.sessionId, "openai/gpt-4o", TOKENS);
    await recorder.record(sB.sessionId, "anthropic/claude-sonnet-4", TOKENS);

    const rollA = await recorder.rollupForTenant(tA.id);
    const rollB = await recorder.rollupForTenant(tB.id);
    expect(rollA.inputTokens).toBe(2_000);
    expect(rollA.totalTokens).toBe(3_600);
    expect(rollB.totalTokens).toBe(1_800);

    // tenant A usd = sum across two models, each priced by its own rate
    const expectedA =
      recorder.usdCost("anthropic/claude-sonnet-4", TOKENS) +
      recorder.usdCost("openai/gpt-4o", TOKENS);
    expect(rollA.usd).toBeCloseTo(expectedA, 6);
  });

  it("rollupForTenant respects a time range", async () => {
    const t = await createTenant(pool, { name: "Range Tenant" });
    const s = await stageSession(pool, t.id, "range");
    await recorder.record(s.sessionId, "anthropic/claude-sonnet-4", TOKENS);
    const before = await recorder.rollupForTenant(t.id, {
      to: new Date(Date.now() - 1_000),
    });
    const after = await recorder.rollupForTenant(t.id, {
      from: new Date(Date.now() - 60_000),
    });
    expect(before.totalTokens).toBe(0);
    expect(after.totalTokens).toBeGreaterThan(0);
  });
});
