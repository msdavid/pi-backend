/**
 * `tenantScoped` — the load-bearing tenant-isolation helper (WP-P0.2).
 *
 * Makes omitting the `tenant_id` filter on a tenant-scoped query impossible by
 * construction (docs/db-schema.md §1.2, §27.1):
 *
 * - **Compile-time:** the 2nd argument is {@link TenantCtx} (a `{tenantId}`
 *   object), so a caller cannot invoke the helper without a tenant context.
 * - **Runtime:** the helper asserts the SQL text references the literal column
 *   `tenant_id` AND that the tenant's id value is present in the params. A
 *   query that names the column but forgets to bind the value, or that omits
 *   the column entirely, throws {@link TenantScopeError} before it can run.
 *
 * The guard is deliberately conservative: it must be possible to *audit* that
 * every tenant-scoped query filters on `tenant_id`. Cross-tenant access is
 * impossible by construction (§27.1).
 */

import {
  type Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { type TenantCtx } from "./pool.js";

/** Column name every tenant-scoped table filters on (§2). */
export const TENANT_ID_COLUMN = "tenant_id";

/**
 * Thrown when a query routed through {@link tenantScopedQuery} is not actually
 * scoped by `tenant_id`. Maps to a 500-class internal error (a programming
 * fault, never a client condition) — callers should treat it as a bug.
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

/** `tenant_id` reference, as a word boundary so `tenants.x_tenant_id` won't match. */
const TENANT_ID_REF = /\btenant_id\b/i;

/** A bare, un-quoted SQL identifier (table/column name) — no whitespace, punctuation, or quotes. */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Extract the positional placeholders (`$N`) that a `tenant_id` predicate binds:
 * `tenant_id = $1`, `tenant_id = ANY($2)`, `tenant_id IN ($3, …)`, and alias-qualified
 * forms (`s.tenant_id = $1`). Returns the 1-based placeholder indices. An empty result
 * means no recognizable `tenant_id = $N` predicate (e.g. a subquery/function form),
 * which the caller treats as the fall-back case.
 */
const TENANT_ID_BIND = /\btenant_id\b\s*(?:=|in)\s*\(?\s*(?:any\s*\(\s*)?\$(\d+)/gi;
function tenantIdFilterPlaceholders(sql: string): number[] {
  const out: number[] = [];
  TENANT_ID_BIND.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TENANT_ID_BIND.exec(sql)) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * Runtime scoping assertion. The SQL must reference `tenant_id`, AND the caller's
 * `tenantCtx.tenantId` must be bound to the `tenant_id` *predicate* — not merely
 * present somewhere in the params (R-audit SEC-10: the old `params.includes` check
 * passed a query that named `tenant_id` but bound the id to an unrelated column).
 *
 * When the `tenant_id = $N` / `= ANY($N)` / `IN ($N…)` predicate is recognizable we
 * verify the value is bound to *that* placeholder; for unusual predicate forms the
 * extractor can't parse (subquery, function) we fall back to the coarse presence
 * check so legitimate queries keep working. This is belt-and-suspenders over the
 * Postgres row-level-security policies (migration — see `ENABLE ROW LEVEL SECURITY`)
 * which are the authoritative backstop; the app-layer guard keeps every tenant-scoped
 * query auditable and catches a mis-bind before it reaches the database.
 */
function assertTenantScoped(
  sql: string,
  params: unknown[],
  tenantCtx: TenantCtx,
): void {
  if (!TENANT_ID_REF.test(sql)) {
    throw new TenantScopeError(
      `tenant-scoped query does not reference '${TENANT_ID_COLUMN}' in its SQL; ` +
        `every tenant-scoped query MUST filter on ${TENANT_ID_COLUMN} (§27.1). ` +
        `Use tenantScopedAll() for ad-hoc reads or add "WHERE ${TENANT_ID_COLUMN} = $N" ` +
        `to your SQL. Offending SQL: ${sql}`,
    );
  }
  const filterPlaceholders = tenantIdFilterPlaceholders(sql);
  if (filterPlaceholders.length > 0) {
    const boundToFilter = filterPlaceholders.some(
      (idx) => params[idx - 1] === tenantCtx.tenantId,
    );
    if (!boundToFilter) {
      throw new TenantScopeError(
        `tenant-scoped query filters on '${TENANT_ID_COLUMN}' but none of the bound ` +
          `predicate placeholders (${filterPlaceholders
            .map((i) => "$" + i)
            .join(", ")}) carry the caller's tenantId (${tenantCtx.tenantId}); the ` +
          `filter value must be bound to the tenant_id predicate (§27.1). ` +
          `Offending SQL: ${sql}`,
      );
    }
    return;
  }
  // No recognizable `tenant_id = $N` predicate (subquery/function form): fall back to
  // the coarse presence check so unusual-but-legitimate queries keep working.
  if (!params.includes(tenantCtx.tenantId)) {
    throw new TenantScopeError(
      `tenant-scoped query references '${TENANT_ID_COLUMN}' but the params do not ` +
        `include the tenant_id binding (tenantId=${tenantCtx.tenantId}); the filter ` +
        `value must be bound as a parameter (§27.1). Offending SQL: ${sql}`,
    );
  }
}

/**
 * Execute a tenant-scoped query. The 2nd argument (`tenantCtx`) is required at
 * compile time; the SQL must reference `tenant_id` and bind the tenant's id at
 * runtime, else {@link TenantScopeError} is thrown before execution.
 *
 * Placeholders are positional (`$1`, `$2`, …) per `pg` convention. The caller is
 * responsible for binding `tenantCtx.tenantId` to the placeholder that filters
 * `tenant_id`; for ad-hoc reads, {@link tenantScopedAll} builds this for you.
 *
 * @example
 *   const { rows } = await tenantScopedQuery<{ name: string }>(
 *     pool,
 *     { tenantId },
 *     "SELECT name FROM agents WHERE tenant_id = $1 AND status = $2",
 *     [tenantId, "active"],
 *   );
 */
export async function tenantScopedQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantCtx: TenantCtx,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  assertTenantScoped(sql, params, tenantCtx);
  // RLS backstop (SEC-10): run inside a transaction with `app.current_tenant` SET LOCAL,
  // so the row-level-security policies (migration 040) pin this query to the caller's
  // tenant at the database — even if the SQL itself were mis-scoped. `SET LOCAL` auto-
  // resets on COMMIT/ROLLBACK, so a pooled connection can never leak a stale tenant to
  // the next borrower. The app-layer assertion above remains the primary guard.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [
      tenantCtx.tenantId,
    ]);
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a tenant-scoped query on an already-acquired {@link PoolClient} (rather
 * than the pool). Same runtime scoping assertion as {@link tenantScopedQuery} —
 * the SQL must reference `tenant_id` and the params must bind the caller's
 * tenant id, else {@link TenantScopeError} is thrown before execution.
 *
 * Needed when a tenant-scoped statement must run on a specific connection inside
 * an open transaction (`BEGIN … FOR UPDATE SKIP LOCKED … COMMIT`), where the
 * `SELECT`/`UPDATE` must share the transaction of the enclosing `client` — see
 * {@link work-queue.claim}.
 */
export async function tenantScopedClientQuery<
  T extends QueryResultRow = QueryResultRow,
>(
  client: PoolClient,
  tenantCtx: TenantCtx,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  assertTenantScoped(sql, params, tenantCtx);
  // RLS backstop (SEC-10): pin the tenant on the caller's OPEN transaction. `SET LOCAL`
  // is scoped to that transaction and resets on its COMMIT/ROLLBACK.
  await client.query("SELECT set_config('app.current_tenant', $1, true)", [
    tenantCtx.tenantId,
  ]);
  return client.query<T>(sql, params);
}

/**
 * Read all rows of a tenant-scoped table for `tenantCtx`, optionally narrowed by
 * an extra `WHERE` fragment. The `tenant_id = $1` filter is always prepended, so
 * the caller cannot forget it.
 *
 * `extraWhere` (if given) is AND-ed inside the `WHERE`; its placeholders MUST
 * start at `$2` (since `$1` is the tenant id) and its values go in `extraParams`.
 *
 * @example
 *   const active = await tenantScopedAll<{ name: string }>(
 *     pool, { tenantId }, "agents", "status = $2", ["active"],
 *   );
 */
export async function tenantScopedAll<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantCtx: TenantCtx,
  table: string,
  extraWhere?: string,
  extraParams: unknown[] = [],
): Promise<T[]> {
  // `table` and `extraWhere` are interpolated (SQL identifiers can't be parameterized),
  // so they MUST be compile-time constants — never caller/user input (R-audit SEC-14).
  // Enforce that `table` is a bare identifier to slam the door on any accidental
  // injection path.
  if (!IDENTIFIER_RE.test(table)) {
    throw new TenantScopeError(
      `tenantScopedAll: table name ${JSON.stringify(table)} is not a bare SQL identifier ` +
        `([a-z_][a-z0-9_]*); table names must be compile-time constants (§27.1).`,
    );
  }
  const where = extraWhere
    ? `WHERE "${TENANT_ID_COLUMN}" = $1 AND (${extraWhere})`
    : `WHERE "${TENANT_ID_COLUMN}" = $1`;
  const sql = `SELECT * FROM "${table}" ${where}`;
  const params = [tenantCtx.tenantId, ...extraParams];
  const result = await tenantScopedQuery<T>(pool, tenantCtx, sql, params);
  return result.rows;
}
