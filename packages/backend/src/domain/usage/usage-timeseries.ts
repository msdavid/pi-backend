/**
 * Tenant usage-over-time rollup (WP-C3.0, console spec §11.5).
 *
 * Aggregates the append-only `usage_records` table (§3.13) into UTC-aligned
 * day/month calendar buckets for `GET /v1/tenant/usage` — consumed by the
 * console tenant dashboard (C§9.9) and the billing views (C§11.8). Optional
 * grouping joins `sessions` for `agent_id` / `metadata->>'userId'` attribution
 * (§26.2) — `usage_records` itself carries only (tenant, session, model).
 *
 * The range policy (defaults + span caps, documented in api-reference
 * §"GET /v1/tenant/usage") lives next to the query so the two cannot drift:
 * the response is unpaginated, so the bounded span is what bounds it. The
 * aggregation is a range scan over `idx_usage_records_tenant_recorded`
 * (tenant_id, recorded_at) — no new index needed.
 */

import { tenantScopedQuery, type Pool, type TenantCtx } from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type {
  TenantUsageBucket,
  TenantUsageGranularity,
  TenantUsageGroupBy,
} from "@pi-managed/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default span when `from` is omitted: 30 days (`day`) / 365 days (`month`). */
const DEFAULT_SPAN_MS: Record<TenantUsageGranularity, number> = {
  day: 30 * DAY_MS,
  month: 365 * DAY_MS,
};

/** Max span: 366 days (`day`) / 24 months (`month`) — api-reference §"GET /v1/tenant/usage". */
const MAX_SPAN_MS: Record<TenantUsageGranularity, number> = {
  day: 366 * DAY_MS,
  month: 732 * DAY_MS,
};

const MAX_SPAN_LABEL: Record<TenantUsageGranularity, string> = {
  day: "366 days",
  month: "24 months",
};

/**
 * Resolve the effective `[from, to)` bounds from the (optional) query params:
 * `to` defaults to now, `from` to `to` − {@link DEFAULT_SPAN_MS}. Throws
 * `422 invalid_request` on an empty/inverted range or a span beyond
 * {@link MAX_SPAN_MS}.
 */
export function resolveTenantUsageRange(
  granularity: TenantUsageGranularity,
  fromParam?: string,
  toParam?: string,
): { from: Date; to: Date } {
  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - DEFAULT_SPAN_MS[granularity]);
  if (from.getTime() >= to.getTime()) {
    throw new ApiError(422, "invalid_request", "`from` must be strictly before `to`");
  }
  if (to.getTime() - from.getTime() > MAX_SPAN_MS[granularity]) {
    throw new ApiError(
      422,
      "invalid_request",
      `usage range too large: max ${MAX_SPAN_LABEL[granularity]} for granularity=${granularity}`,
    );
  }
  return { from, to };
}

export interface TenantUsageTimeseriesOptions {
  granularity: TenantUsageGranularity;
  /** Inclusive lower bound on `recorded_at`. */
  from: Date;
  /** Exclusive upper bound on `recorded_at`. */
  to: Date;
  groupBy?: TenantUsageGroupBy;
}

/** Raw aggregate row (pg returns SUM(bigint)/numeric as strings). */
interface BucketRow {
  bucket_start: Date;
  group_key?: string | null;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_creation_input_tokens: string | number;
  cache_read_input_tokens: string | number;
  usd_cost: string | number;
}

/**
 * Time-bucketed usage rollup for one tenant. Buckets are UTC calendar
 * days/months (`date_trunc(…, 'UTC')` — explicit zone, so the result is
 * independent of the server timezone); empty buckets are omitted. Rows sort by
 * `bucketStart` ascending, then group key (`NULL` userId last).
 */
export async function getTenantUsageTimeseries(
  pool: Pool,
  ctx: TenantCtx,
  opts: TenantUsageTimeseriesOptions,
): Promise<TenantUsageBucket[]> {
  // The join re-binds `s.tenant_id = ur.tenant_id` so a (hypothetically)
  // cross-tenant session row can never contribute attribution.
  const groupExpr =
    opts.groupBy === "agent"
      ? "s.agent_id"
      : opts.groupBy === "user"
        ? "s.metadata->>'userId'"
        : null;
  const { rows } = await tenantScopedQuery<BucketRow>(
    pool,
    ctx,
    `SELECT
       date_trunc($2, ur.recorded_at, 'UTC')            AS bucket_start,
       ${groupExpr ? `${groupExpr} AS group_key,` : ""}
       COALESCE(SUM(ur.input_tokens), 0)                AS input_tokens,
       COALESCE(SUM(ur.output_tokens), 0)               AS output_tokens,
       COALESCE(SUM(ur.cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
       COALESCE(SUM(ur.cache_read_input_tokens), 0)     AS cache_read_input_tokens,
       COALESCE(SUM(ur.usd_cost), 0)                    AS usd_cost
     FROM usage_records ur
     ${groupExpr ? "JOIN sessions s ON s.id = ur.session_id AND s.tenant_id = ur.tenant_id" : ""}
     WHERE ur.tenant_id = $1
       AND ur.recorded_at >= $3
       AND ur.recorded_at <  $4
     GROUP BY 1${groupExpr ? ", 2" : ""}
     ORDER BY 1${groupExpr ? ", 2" : ""}`,
    [ctx.tenantId, opts.granularity, opts.from, opts.to],
  );
  return rows.map((row) => {
    const bucket: TenantUsageBucket = {
      bucketStart: row.bucket_start.toISOString(),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheCreationInputTokens: Number(row.cache_creation_input_tokens),
      cacheReadInputTokens: Number(row.cache_read_input_tokens),
      usdCost: Number(row.usd_cost),
    };
    if (opts.groupBy === "agent") bucket.agentId = row.group_key as string;
    if (opts.groupBy === "user") bucket.userId = row.group_key ?? null;
    return bucket;
  });
}
