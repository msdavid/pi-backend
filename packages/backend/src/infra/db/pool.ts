/**
 * Postgres connection pool.
 *
 * A thin wrapper over `pg.Pool` so the rest of the service never instantiates
 * `pg` directly: every DB-touching module receives a `Pool` (or a helper built
 * on one) and queries stay explicit and auditable (§27.1 — row-level tenant
 * filtering must be auditable; no heavyweight ORM).
 *
 * Conventions (CONVENTIONS.md "Technology decisions", docs/db-schema.md §2):
 * - `pg` + node-pg-migrate, forward-only SQL migrations.
 * - Every tenant-scoped table has `tenant_id`; the {@link TenantCtx} type is the
 *   compile-time anchor the {@link tenantScoped} helper (see `tenant-scoped.ts`)
 *   uses to make omitting the filter impossible.
 */

import pg, {
  type Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export type { Pool, PoolConfig, QueryResult, QueryResultRow } from "pg";

/**
 * Tenant context — the required first argument to every tenant-scoped query.
 * Carrying `tenantId` here (rather than as a loose string parameter) is what
 * makes a tenant-scoped call impossible to write without a tenant (§27.1).
 *
 * `scopes` carries the API-key scopes resolved by {@link verifyApiKey} and is
 * what the {@link requireScope} route guard (R0.1) enforces. Request contexts
 * always carry real scopes (an admin key → `["admin"]`, least-privilege keys →
 * `["read"]`/`["write"]`, self-hosted worker keys → `["self_hosted_worker:<envId>"]`).
 * Internal/system contexts (background loops, migrations, cross-tenant system
 * queries) never traverse the HTTP scope guard, so they may omit `scopes`
 * (treated as no scopes); when they need an explicit privilege they pass
 * `["admin"]`.
 */
export interface TenantCtx {
  tenantId: string;
  scopes?: string[];
}

/**
 * Create a {@link pg.Pool} from a standard `pg` config (typically
 * `{ connectionString: config.dbUrl }`).
 *
 * The composition root passes the operational knobs (PERF-1): `max` (pool size),
 * `connectionTimeoutMillis` (acquire timeout — `pg`'s default `0` queues forever), and
 * `statement_timeout` (server-side per-query cap, forwarded to every backing connection).
 * All are plain `pg` {@link PoolConfig} fields; this wrapper exists so nothing else in the
 * service instantiates `pg` directly.
 *
 * The caller owns the pool's lifecycle (`.end()` on shutdown). See
 * {@link closePool}.
 */
export function createPool(config: PoolConfig): Pool {
  const pool = new pg.Pool(config);
  // `pg` emits `error` on IDLE pooled clients when the server drops them —
  // a restart, a failover, or `pg_terminate_backend` (`57P01`). An `error` event with no
  // listener is fatal to the Node process, so without this a routine Postgres restart
  // takes the backend down with it. The pool discards the dead client on its own and
  // stays usable, and an error on a CHECKED-OUT client still rejects that client's own
  // query, so nothing is being swallowed that a caller would otherwise see.
  pool.on("error", () => {});
  return pool;
}

/**
 * Run a SQL string with positional params against `pool`.
 *
 * Prefer {@link tenantScopedQuery} for any tenant-scoped table: it asserts the
 * SQL references `tenant_id` before it can execute. This raw helper is for
 * non-tenant-scoped DDL/migrations or cross-tenant system queries only.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(sql, params as unknown[]);
}

/** Drain and close a pool. Resolves when all connections are released. */
export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
