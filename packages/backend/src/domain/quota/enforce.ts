/**
 * Quota enforcement (WP-4.4, §27.3).
 *
 * {@link getCurrentUsage} rolls up the seven per-tenant usage dimensions from
 * Postgres (concurrent sessions/sandboxes, jobs, vault credentials, memory
 * stores, file storage, monthly token spend). {@link checkQuota} compares one
 * dimension against the tenant's {@link QuotaPlan} and returns whether creating
 * one more unit (or spending `delta` more bytes/USD) would exceed the limit.
 *
 * Called at resource-creating endpoints by the quota middleware
 * (`api/middleware/quota.ts`) and by the scheduler (manual/triggered job runs).
 * Exceed → `429` + `code: rate_limited` (api-reference §"Rate limiting":
 * quota-exceeded conditions use the same status as short-window throttling).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { tenantScopedClientQuery } from "../../infra/db/tenant-scoped.js";
import { ApiError } from "../errors.js";
import type { TenantId } from "../ports.js";
import { createUsageRecorder } from "../usage/usage-recorder.js";
import type { QuotaPlan } from "./plans.js";
import { getQuotaPlanForTenant } from "./tiers.js";

/**
 * Current per-tenant usage. Wire shape matches `GET /v1/tenant` `quotaUsage`
 * (api-reference §"Tenant / admin"). Field naming follows the wire, not the
 * plan: e.g. `vaultSize` is the count of active credentials (compared against
 * `QuotaPlan.maxVaultCredentials`), `memorySize` the count of active memory
 * stores (compared against `maxMemoryStores`).
 */
export interface QuotaUsage {
  concurrentSessions: number;
  concurrentSandboxes: number;
  jobs: number;
  vaultSize: number;
  memorySize: number;
  fileStorage: number;
  tokenSpendUsd: number;
}

/** A resource dimension being checked (named after the {@link QuotaPlan} field). */
export type QuotaResource =
  | "concurrentSessions"
  | "concurrentSandboxes"
  | "maxJobs"
  | "maxVaultCredentials"
  | "maxMemoryStores"
  | "maxFileStorageBytes"
  | "monthlyTokenSpendUsd";

/** Result of a quota check. */
export interface QuotaCheck {
  exceeded: boolean;
  resource: QuotaResource;
  limit: number;
  current: number;
}

/** Optional incremental delta for a resource about to be created/spent. */
export interface QuotaCheckOptions {
  /** Bytes to add to current file storage (upload checks). */
  fileStorageDelta?: number;
  /** USD to add to current monthly spend (model-request checks). */
  tokenSpendDelta?: number;
}

/** Maps a {@link QuotaResource} → the matching {@link QuotaPlan} field. */
const RESOURCE_TO_PLAN: Record<QuotaResource, keyof QuotaPlan> = {
  concurrentSessions: "concurrentSessions",
  concurrentSandboxes: "concurrentSandboxes",
  maxJobs: "maxJobs",
  maxVaultCredentials: "maxVaultCredentials",
  maxMemoryStores: "maxMemoryStores",
  maxFileStorageBytes: "maxFileStorageBytes",
  monthlyTokenSpendUsd: "monthlyTokenSpendUsd",
};

/** The start of the current UTC calendar month (for monthly token-spend rollup). */
function monthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Count row shape (pg returns `count` as string). */
interface CountRow {
  count: string;
}

/** Sum row shape (pg returns `bigint` SUM as string). */
interface SumRow {
  total: string | null;
}

/** Run a tenant-scoped `COUNT(*)` and return it as a number. */
async function scopedCount(
  pool: Pool,
  tenantId: TenantId,
  sql: string,
): Promise<number> {
  const { rows } = await tenantScopedQuery<CountRow>(pool, { tenantId }, sql, [
    tenantId,
  ]);
  return Number(rows[0].count);
}

// --- Per-dimension usage queries ------------------------------------------
// Each computes exactly one usage dimension so {@link checkQuota} can query only
// the dimension it enforces (PERF-7) instead of rolling up all seven. Concurrent
// sessions = active (non-terminated) sessions; concurrent sandboxes = live
// (running/rescheduling) sessions — an idle session has a checkpointed (stopped)
// sandbox but still occupies a session slot.

const usageConcurrentSessions = (pool: Pool, tenantId: TenantId) =>
  scopedCount(
    pool,
    tenantId,
    `SELECT COUNT(*) AS count FROM sessions
      WHERE tenant_id = $1 AND status IN ('idle','running','rescheduling')`,
  );

const usageConcurrentSandboxes = (pool: Pool, tenantId: TenantId) =>
  scopedCount(
    pool,
    tenantId,
    `SELECT COUNT(*) AS count FROM sessions
      WHERE tenant_id = $1 AND status IN ('running','rescheduling')`,
  );

const usageJobs = (pool: Pool, tenantId: TenantId) =>
  scopedCount(
    pool,
    tenantId,
    `SELECT COUNT(*) AS count FROM jobs
      WHERE tenant_id = $1 AND status <> 'archived'`,
  );

const usageVault = (pool: Pool, tenantId: TenantId) =>
  scopedCount(
    pool,
    tenantId,
    `SELECT COUNT(*) AS count FROM vault_credentials
      WHERE tenant_id = $1 AND status = 'active'`,
  );

const usageMemory = (pool: Pool, tenantId: TenantId) =>
  scopedCount(
    pool,
    tenantId,
    `SELECT COUNT(*) AS count FROM memory_stores
      WHERE tenant_id = $1 AND status = 'active'`,
  );

async function usageFileStorage(pool: Pool, tenantId: TenantId): Promise<number> {
  const { rows } = await tenantScopedQuery<SumRow>(
    pool,
    { tenantId },
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM files WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0].total ?? 0);
}

/** Month-to-date token spend (USD) via the WP-1.10 usage recorder rollup. */
async function usageTokenSpend(pool: Pool, tenantId: TenantId): Promise<number> {
  const usage = await createUsageRecorder({ pool }).rollupForTenant(tenantId, {
    from: monthStart(),
  });
  return usage.usd;
}

/**
 * Current usage for a single {@link QuotaResource} — the one dimension a
 * {@link checkQuota}/reservation actually needs (PERF-7). Running one query per
 * check, rather than the full {@link getCurrentUsage} rollup, keeps the hot
 * create/upload path to a single aggregate.
 */
export async function currentUsageForResource(
  pool: Pool,
  tenantId: TenantId,
  resource: QuotaResource,
): Promise<number> {
  switch (resource) {
    case "concurrentSessions":
      return usageConcurrentSessions(pool, tenantId);
    case "concurrentSandboxes":
      return usageConcurrentSandboxes(pool, tenantId);
    case "maxJobs":
      return usageJobs(pool, tenantId);
    case "maxVaultCredentials":
      return usageVault(pool, tenantId);
    case "maxMemoryStores":
      return usageMemory(pool, tenantId);
    case "maxFileStorageBytes":
      return usageFileStorage(pool, tenantId);
    case "monthlyTokenSpendUsd":
      return usageTokenSpend(pool, tenantId);
  }
}

/**
 * Roll up current per-tenant usage across all seven dimensions, in parallel. All
 * queries are tenant-scoped via {@link tenantScopedQuery} (§27.1). Used by the
 * `GET /v1/tenant` `quotaUsage` surface, which needs every dimension at once;
 * the enforcement path uses {@link currentUsageForResource} instead (PERF-7).
 */
export async function getCurrentUsage(
  pool: Pool,
  tenantId: TenantId,
): Promise<QuotaUsage> {
  const [
    concurrentSessions,
    concurrentSandboxes,
    jobs,
    vaultSize,
    memorySize,
    fileStorage,
    tokenSpendUsd,
  ] = await Promise.all([
    usageConcurrentSessions(pool, tenantId),
    usageConcurrentSandboxes(pool, tenantId),
    usageJobs(pool, tenantId),
    usageVault(pool, tenantId),
    usageMemory(pool, tenantId),
    usageFileStorage(pool, tenantId),
    usageTokenSpend(pool, tenantId),
  ]);

  return {
    concurrentSessions,
    concurrentSandboxes,
    jobs,
    vaultSize,
    memorySize,
    fileStorage,
    tokenSpendUsd,
  };
}

/**
 * Amount-based (delta) quota dimensions: a magnitude compared against a ceiling,
 * not a unit count. File storage is `SUM(size_bytes)`; monthly token spend is a
 * `SUM(usd_cost)` rollup. Their exceed test is `current + delta > limit` — a
 * resource landing exactly on the limit is admitted (ROB-20; `>=` made the limit
 * unreachable). Count dimensions keep `current >= limit` (at the limit, one more
 * unit overflows).
 */
export type AmountResource = "maxFileStorageBytes" | "monthlyTokenSpendUsd";

/** Whether `resource` is an amount/delta dimension (vs a unit count). */
function isAmountResource(resource: QuotaResource): resource is AmountResource {
  return (
    resource === "maxFileStorageBytes" || resource === "monthlyTokenSpendUsd"
  );
}

/**
 * Check whether creating one more unit of `resource` (or spending `delta` more
 * bytes/USD) would exceed the tenant's plan limit. Queries only the dimension
 * being checked (PERF-7), not the full {@link getCurrentUsage} rollup.
 *
 * For count-based resources, `exceeded = current >= limit` (a tenant at its
 * limit cannot create another). For amount-based (bytes/USD) resources, `delta`
 * is added to the current total and the test is strict — `current + delta >
 * limit` — so a resource that lands exactly on the limit is admitted (ROB-20).
 */
export async function checkQuota(
  pool: Pool,
  tenantId: TenantId,
  resource: QuotaResource,
  opts: QuotaCheckOptions = {},
): Promise<QuotaCheck> {
  const plan = await getQuotaPlanForTenant(pool, tenantId);
  const limit = plan[RESOURCE_TO_PLAN[resource]];
  let current = await currentUsageForResource(pool, tenantId, resource);
  if (resource === "maxFileStorageBytes" && opts.fileStorageDelta) {
    current += opts.fileStorageDelta;
  }
  if (resource === "monthlyTokenSpendUsd" && opts.tokenSpendDelta) {
    current += opts.tokenSpendDelta;
  }
  const exceeded = isAmountResource(resource)
    ? current > limit
    : current >= limit;
  return { exceeded, resource, limit, current };
}

// ---------------------------------------------------------------------------
// Transactional counter enforcement (R5.2, §27.3)
// ---------------------------------------------------------------------------

/**
 * The count-based quota dimensions enforced by the transactional counter
 * (`tenant_quota_counters`, migration 031) rather than the racy pre-flight
 * {@link checkQuota} COUNT. These are the create/delete-lifecycle resources: a
 * unit is reserved at creation and released on deletion/termination.
 *
 * `maxFileStorageBytes` (a `SUM(size_bytes)`) and `monthlyTokenSpendUsd` (a
 * usage rollup) are NOT counters — they stay on {@link checkQuota}.
 * `concurrentSandboxes` is a live runtime-state derivation (running/rescheduling
 * sessions), not a create-time count, so it is also excluded.
 */
export type CounterResource =
  | "concurrentSessions"
  | "maxJobs"
  | "maxVaultCredentials"
  | "maxMemoryStores";

/**
 * Build the 429 the create paths throw when a reservation would exceed the plan
 * limit. Shape matches the quota error the middleware emits for file storage
 * (`code: rate_limited`, `details: {resource, limit, current}`), so both quota
 * surfaces are indistinguishable to a client (api-reference §"Rate limiting").
 */
function quotaExceeded(
  resource: QuotaResource,
  limit: number,
  current: number,
): ApiError {
  return new ApiError(
    429,
    "rate_limited",
    `Quota exceeded for ${resource}: ${current}/${limit}.`,
    { resource, limit, current },
  );
}

/**
 * Atomically reserve one unit of a count-based quota `resource` for a tenant
 * (R5.2). Runs the counter upsert inside its own `BEGIN … COMMIT`:
 *
 * ```
 * INSERT INTO tenant_quota_counters (tenant_id, resource, count) VALUES (…, 1)
 * ON CONFLICT (tenant_id, resource) DO UPDATE SET count = count + 1
 * RETURNING count
 * ```
 *
 * The row-level lock on `(tenant_id, resource)` serializes concurrent
 * reservations, so each caller observes a distinct post-increment `count`. If
 * the new count exceeds the plan limit the transaction is **rolled back**
 * (undoing the increment) and a `429 rate_limited` is thrown — so N concurrent
 * creates admit **exactly `limit`**, never more (the pre-flight COUNT let all N
 * pass). On success the increment is committed.
 *
 * The caller MUST {@link releaseQuota} if the subsequent resource insert fails
 * (compensation) and on resource deletion/termination, or the slot leaks.
 */
export async function reserveQuota(
  pool: Pool,
  tenantCtx: TenantCtx,
  resource: CounterResource,
): Promise<void> {
  const plan = await getQuotaPlanForTenant(pool, tenantCtx.tenantId);
  const limit = plan[RESOURCE_TO_PLAN[resource]];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await tenantScopedClientQuery<{ count: string }>(
      client,
      tenantCtx,
      `INSERT INTO tenant_quota_counters (tenant_id, resource, count)
            VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, resource)
       DO UPDATE SET count = tenant_quota_counters.count + 1
         RETURNING count`,
      [tenantCtx.tenantId, resource],
    );
    const count = Number(rows[0].count);
    if (count > limit) {
      // Over the limit: undo this increment so the counter reflects reality,
      // then reject. `current` is the committed usage (this attempt rolled back).
      await client.query("ROLLBACK");
      throw quotaExceeded(resource, limit, count - 1);
    }
    await client.query("COMMIT");
  } catch (err) {
    // A quota rejection has already rolled back above; only unexpected errors
    // (e.g. a lost connection) need the defensive rollback here.
    if (!(err instanceof ApiError)) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically release one previously-reserved unit of `resource` (decrement,
 * floored at 0). Called on resource deletion/termination and as compensation
 * when a reserved create fails before its row is durably inserted. A no-op if no
 * counter row exists yet (nothing was reserved).
 */
export async function releaseQuota(
  pool: Pool,
  tenantCtx: TenantCtx,
  resource: CounterResource,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE tenant_quota_counters
        SET count = GREATEST(count - 1, 0)
      WHERE tenant_id = $1 AND resource = $2`,
    [tenantCtx.tenantId, resource],
  );
}

// ---------------------------------------------------------------------------
// Transactional amount enforcement — file storage & token spend (ROB-15, §27.3)
// ---------------------------------------------------------------------------

/**
 * USD is stored in the (integer) `count` column as micro-dollars so token spend
 * shares the `bigint` counter with byte-valued file storage. Byte resources use
 * a scale of 1; the value stored for `monthlyTokenSpendUsd` is `usd * 1e6`.
 */
const USD_MICROS = 1_000_000;

/** `YYYY-MM` for the current UTC month (the monthly token-spend period key). */
function monthKey(): string {
  const d = monthStart();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Counter identity for an amount resource: the `resource` key stored in
 * `tenant_quota_counters` and the integer scale applied to the amount/limit.
 *
 * File storage keys on the bare resource name (a lifetime byte total). Monthly
 * token spend keys on `monthlyTokenSpendUsd:<YYYY-MM>` so each calendar month is
 * a fresh row that starts at zero — the counter resets without a scheduled job —
 * and stores micro-dollars so the fractional USD fits the `bigint` column.
 */
function amountCounter(resource: AmountResource): {
  key: string;
  scale: number;
} {
  return resource === "monthlyTokenSpendUsd"
    ? { key: `monthlyTokenSpendUsd:${monthKey()}`, scale: USD_MICROS }
    : { key: resource, scale: 1 };
}

/**
 * Atomically reserve `amount` (bytes for `maxFileStorageBytes`, USD for
 * `monthlyTokenSpendUsd`) against the tenant's plan limit (ROB-15). A single
 * guarded upsert increments the counter **only if it stays within the limit**:
 *
 * ```
 * INSERT INTO tenant_quota_counters AS c (tenant_id, resource, count)
 * SELECT $tenant, $key, $delta   WHERE $delta <= $limit          -- guards first insert
 * ON CONFLICT (tenant_id, resource)
 * DO UPDATE SET count = c.count + $delta   WHERE c.count + $delta <= $limit
 * RETURNING count
 * ```
 *
 * The row lock on `(tenant_id, resource)` serializes concurrent reservations, so
 * N concurrent uploads/spends admit **exactly up to `limit`**, never more — the
 * pre-flight `SUM` let all N pass (the TOCTOU this fixes). Landing exactly on the
 * limit is admitted (`<= limit`); over the limit the `WHERE` suppresses the write
 * and the statement returns **no row**, so no rollback is needed and a `429
 * rate_limited` is thrown. A non-positive `amount` is a no-op.
 *
 * The caller MUST {@link releaseQuotaDelta} on deletion (file storage) and as
 * compensation if the reserved resource fails to persist, or the amount leaks
 * until {@link reconcileQuotaCounter} corrects it.
 */
export async function reserveQuotaDelta(
  pool: Pool,
  tenantCtx: TenantCtx,
  resource: AmountResource,
  amount: number,
): Promise<void> {
  if (!(amount > 0)) return; // nothing to reserve (0 / NaN / negative)
  const plan = await getQuotaPlanForTenant(pool, tenantCtx.tenantId);
  const { key, scale } = amountCounter(resource);
  const delta = Math.round(amount * scale);
  const limit = Math.round(plan[RESOURCE_TO_PLAN[resource]] * scale);

  const { rows } = await tenantScopedQuery<{ count: string }>(
    pool,
    tenantCtx,
    `INSERT INTO tenant_quota_counters AS c (tenant_id, resource, count)
          SELECT $1, $2, $3::bigint WHERE $3::bigint <= $4::bigint
     ON CONFLICT (tenant_id, resource)
     DO UPDATE SET count = c.count + $3::bigint
           WHERE c.count + $3::bigint <= $4::bigint
       RETURNING count`,
    [tenantCtx.tenantId, key, delta, limit],
  );
  if (rows.length === 0) {
    // The guard suppressed the write: this reservation would exceed the limit.
    // Read the committed value for the error detail (unscaled back to the wire).
    const { rows: cur } = await tenantScopedQuery<{ count: string }>(
      pool,
      tenantCtx,
      `SELECT count FROM tenant_quota_counters WHERE tenant_id = $1 AND resource = $2`,
      [tenantCtx.tenantId, key],
    );
    const current = Number(cur[0]?.count ?? 0) / scale;
    throw quotaExceeded(resource, plan[RESOURCE_TO_PLAN[resource]], current);
  }
}

/**
 * Release `amount` (bytes / USD) previously reserved via {@link reserveQuotaDelta}
 * — on file deletion and as compensation for a failed reserve — decrementing the
 * counter, floored at 0. A no-op if no counter row exists. For token spend this
 * targets the current month's period row; releasing spend is unusual (it is a
 * rollup, not a lifecycle resource) but is supported for symmetry/compensation.
 */
export async function releaseQuotaDelta(
  pool: Pool,
  tenantCtx: TenantCtx,
  resource: AmountResource,
  amount: number,
): Promise<void> {
  if (!(amount > 0)) return;
  const { key, scale } = amountCounter(resource);
  const delta = Math.round(amount * scale);
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE tenant_quota_counters
        SET count = GREATEST(count - $3::bigint, 0)
      WHERE tenant_id = $1 AND resource = $2`,
    [tenantCtx.tenantId, key, delta],
  );
}

// ---------------------------------------------------------------------------
// Counter reconciliation (ROB-20)
// ---------------------------------------------------------------------------

/**
 * Resources whose enforcement is backed by a `tenant_quota_counters` row and can
 * therefore drift from the source-of-truth tables — the four lifecycle counters
 * plus the two amount dimensions. `concurrentSandboxes` is excluded (a live
 * runtime derivation, never counter-backed).
 */
export type ReconcilableResource = CounterResource | AmountResource;

/** Outcome of a reconcile pass: the counter value before and after correction. */
export interface ReconcileResult {
  resource: ReconcilableResource;
  before: number;
  after: number;
  /** Signed drift that was corrected (`after - before`), in wire units. */
  drift: number;
}

/**
 * Recompute a counter from the source-of-truth table and overwrite it with the
 * true value, returning the drift corrected (ROB-20).
 *
 * The counters accumulate drift because they are mutated outside the
 * source-of-truth transaction: a reserve that commits before its resource row is
 * durably inserted leaks on a crash (no compensation runs), a `Content-Length`
 * reservation over-counts the real stored bytes, and a missed
 * {@link releaseQuotaDelta}/{@link releaseQuota} strands a slot. Left alone the
 * counter only ratchets up, eventually rejecting a tenant that is under its real
 * usage. This resets it to the actual `COUNT`/`SUM`, matching the predicates
 * {@link getCurrentUsage} uses for display so enforcement and display agree.
 *
 * Intended to be driven by an operator or a periodic reconcile loop, per tenant
 * per resource. Safe to run concurrently with live traffic: the final `UPDATE`
 * takes the row lock, so it serializes against in-flight reservations; a
 * reservation that commits during the pass is folded in on the next run.
 */
export async function reconcileQuotaCounter(
  pool: Pool,
  tenantId: TenantId,
  resource: ReconcilableResource,
): Promise<ReconcileResult> {
  const tenantCtx: TenantCtx = { tenantId };
  // Source-of-truth value in wire units, and the counter row key + scale.
  const truth = await reconcileTruth(pool, tenantId, resource);
  const { key, scale } = isAmountResource(resource)
    ? amountCounter(resource)
    : { key: resource, scale: 1 };
  const scaled = Math.round(truth * scale);

  const { rows } = await tenantScopedQuery<{ before: string | null }>(
    pool,
    tenantCtx,
    `WITH prev AS (
       SELECT count FROM tenant_quota_counters
        WHERE tenant_id = $1 AND resource = $2
     ),
     upsert AS (
       INSERT INTO tenant_quota_counters (tenant_id, resource, count)
            VALUES ($1, $2, $3::bigint)
       ON CONFLICT (tenant_id, resource)
       DO UPDATE SET count = EXCLUDED.count
     )
     SELECT (SELECT count FROM prev) AS before`,
    [tenantId, key, scaled],
  );
  const before = Number(rows[0]?.before ?? 0) / scale;
  return { resource, before, after: truth, drift: truth - before };
}

/** Source-of-truth (`COUNT`/`SUM`) for a reconcilable resource, in wire units. */
function reconcileTruth(
  pool: Pool,
  tenantId: TenantId,
  resource: ReconcilableResource,
): Promise<number> {
  switch (resource) {
    case "concurrentSessions":
      return usageConcurrentSessions(pool, tenantId);
    case "maxJobs":
      return usageJobs(pool, tenantId);
    case "maxVaultCredentials":
      return usageVault(pool, tenantId);
    case "maxMemoryStores":
      return usageMemory(pool, tenantId);
    case "maxFileStorageBytes":
      return usageFileStorage(pool, tenantId);
    case "monthlyTokenSpendUsd":
      return usageTokenSpend(pool, tenantId);
  }
}
