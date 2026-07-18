/**
 * Postgres `UsageRecorder` (WP-1.10, §9.7, §6.3, §26.2).
 *
 * Records per-model-request token counts to the append-only `usage_records` table
 * (§3.13), derives USD via the per-model price table, and rolls up per-session
 * and per-tenant aggregates for budget enforcement and `GET /v1/tenant`.
 *
 * The {@link UsageRecorder.record} port carries only `sessionId` (no tenant id),
 * so the tenant is resolved from the `sessions` row at record time — the session
 * manager (WP-1.5) guarantees the session exists. Per-session rollups filter on
 * `session_id` alone, which is safe because `sessions.id` is the global PK; the
 * per-tenant rollup routes through {@link tenantScopedQuery} (§27.1).
 */

import {
  tenantScopedQuery,
  query,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import {
  recordTokenUsage,
  SpanAttrs,
} from "../../infra/telemetry/conventions.js";
import type {
  Budget,
  BudgetCheck,
  SessionId,
  TenantId,
  TimeRange,
  TokenCounts,
  Usage,
  UsageRecorder,
} from "../ports.js";
import {
  loadPriceTable,
  priceFor,
  type PriceTable,
} from "./prices.js";
import type { MeteringHook } from "../billing/metering.js";

/** Options for {@link createUsageRecorder}. */
export interface UsageRecorderOptions {
  pool: Pool;
  /** Price table; defaults to {@link loadPriceTable}. */
  priceTable?: PriceTable;
  /**
   * WP-5.3 / WP-C5.2 metering seam (§29.6, §11.4): invoked after each successful
   * `record()` with the tenant id, model, token counts, and derived USD the recorder
   * already resolved. Wire via `MeteringAggregator.ingest` (billing/metering.ts) — a
   * synchronous accumulate; the aggregator flushes time-bucketed events later. The
   * hook must never throw or block usage recording.
   */
  onMetering?: MeteringHook;
}

/** USD rounding to match the `numeric(12,6)` column (§3.13). */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** Sum a list of token-count rows into a {@link Usage} skeleton (no `usd`). */
function sumTokenCounts(rows: TokenCountsSums): Usage {
  const inputTokens = Number(rows.input_tokens ?? 0);
  const outputTokens = Number(rows.output_tokens ?? 0);
  const cacheCreationInputTokens = Number(rows.cache_creation_input_tokens ?? 0);
  const cacheReadInputTokens = Number(rows.cache_read_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    usd: Number(rows.usd_cost ?? 0),
  };
}

/** Raw SUM row shape returned by the rollup queries (pg returns bigint/numeric as strings). */
interface TokenCountsSums {
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_creation_input_tokens: string | number | null;
  cache_read_input_tokens: string | number | null;
  usd_cost: string | number | null;
}

/**
 * Postgres-backed {@link UsageRecorder}. One instance per service (stateless
 * beyond the pool + price table); safe to share across requests.
 */
export class PgUsageRecorder implements UsageRecorder {
  private readonly pool: Pool;
  private readonly prices: PriceTable;
  private readonly onMetering?: MeteringHook;

  constructor(opts: UsageRecorderOptions) {
    this.pool = opts.pool;
    this.prices = opts.priceTable ?? loadPriceTable();
    this.onMetering = opts.onMetering;
  }

  async record(
    sessionId: SessionId,
    model: string,
    tokens: TokenCounts,
  ): Promise<void> {
    // Resolve the tenant from the session row (record() carries no tenant id).
    const { rows } = await query<{ tenant_id: string }>(
      this.pool,
      "SELECT tenant_id FROM sessions WHERE id = $1",
      [sessionId],
    );
    if (rows.length === 0) {
      throw new Error(
        `UsageRecorder.record: session not found: ${sessionId} (cannot attribute tenant)`,
      );
    }
    const tenantId = rows[0].tenant_id;
    const usd = roundUsd(this.usdCost(model, tokens));
    // tenantScopedQuery asserts tenant_id is referenced + bound (§27.1).
    await tenantScopedQuery(
      this.pool,
      { tenantId },
      `INSERT INTO usage_records
         (tenant_id, session_id, model,
          input_tokens, output_tokens,
          cache_creation_input_tokens, cache_read_input_tokens,
          usd_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        sessionId,
        model,
        tokens.inputTokens,
        tokens.outputTokens,
        tokens.cacheCreationInputTokens,
        tokens.cacheReadInputTokens,
        usd,
      ],
    );

    // WP-8.1: the per-tenant token + cost metrics (`pi.tokens.*`, `pi.cost.usd`) are
    // emitted HERE — the one place that has already resolved the tenant, the model, the
    // token counts, and the derived USD. Instruments are no-op until a MeterProvider is
    // registered (see infra/telemetry/otel.ts), so this is safe in tests and local dev.
    recordTokenUsage(
      model,
      {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheCreationInputTokens: tokens.cacheCreationInputTokens,
        cacheReadInputTokens: tokens.cacheReadInputTokens,
        usd,
      },
      { [SpanAttrs.TENANT_ID]: tenantId, [SpanAttrs.SESSION_ID]: sessionId },
    );

    // WP-5.3 / WP-C5.2 metering seam (§29.6, §11.4): hand the request to the metering
    // aggregator. Synchronous accumulate (fire-and-forget); the aggregator buckets it
    // and flushes an aggregated event later — never blocks recording.
    this.onMetering?.({
      tenantId,
      sessionId,
      model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheCreationInputTokens: tokens.cacheCreationInputTokens,
      cacheReadInputTokens: tokens.cacheReadInputTokens,
      usd,
      recordedAt: new Date(),
    });
  }

  usdCost(model: string, tokens: TokenCounts): number {
    const p = priceFor(this.prices, model);
    return (
      tokens.inputTokens * p.inputPerToken +
      tokens.outputTokens * p.outputPerToken +
      tokens.cacheCreationInputTokens * p.cacheCreationPerToken +
      tokens.cacheReadInputTokens * p.cacheReadPerToken
    );
  }

  async cumulativeForSession(sessionId: SessionId): Promise<Usage> {
    // session_id is the global sessions PK, so filtering by it is tenant-safe.
    const { rows } = await query<TokenCountsSums>(
      this.pool,
      `SELECT
         COALESCE(SUM(input_tokens), 0)                AS input_tokens,
         COALESCE(SUM(output_tokens), 0)               AS output_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
         COALESCE(SUM(usd_cost), 0)                    AS usd_cost
       FROM usage_records
       WHERE session_id = $1`,
      [sessionId],
    );
    return sumTokenCounts(rows[0]);
  }

  async checkBudget(sessionId: SessionId, budget: Budget): Promise<BudgetCheck> {
    const usage = await this.cumulativeForSession(sessionId);
    if (budget.maxTokens !== undefined && usage.totalTokens >= budget.maxTokens) {
      return { exceeded: true, reason: "max_tokens_exceeded" };
    }
    if (budget.maxUsd !== undefined && usage.usd >= budget.maxUsd) {
      return { exceeded: true, reason: "max_usd_exceeded" };
    }
    return { exceeded: false };
  }

  async rollupForTenant(tenantId: TenantId, range?: TimeRange): Promise<Usage> {
    const ctx: TenantCtx = { tenantId };
    const params: unknown[] = [tenantId];
    let rangeClause = "";
    if (range?.from) {
      params.push(range.from);
      rangeClause += ` AND recorded_at >= $${params.length}`;
    }
    if (range?.to) {
      params.push(range.to);
      rangeClause += ` AND recorded_at < $${params.length}`;
    }
    const { rows } = await tenantScopedQuery<TokenCountsSums>(
      this.pool,
      ctx,
      `SELECT
         COALESCE(SUM(input_tokens), 0)                AS input_tokens,
         COALESCE(SUM(output_tokens), 0)               AS output_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
         COALESCE(SUM(usd_cost), 0)                    AS usd_cost
       FROM usage_records
       WHERE tenant_id = $1${rangeClause}`,
      params,
    );
    return sumTokenCounts(rows[0]);
  }
}

/** Construct a recorder with the default price table (env-override aware). */
export function createUsageRecorder(opts: UsageRecorderOptions): PgUsageRecorder {
  return new PgUsageRecorder(opts);
}
