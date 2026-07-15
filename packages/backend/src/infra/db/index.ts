/**
 * Postgres infrastructure barrel (WP-P0.2): pool, tenant-scoped query helper,
 * and the migration runner.
 *
 * See CONVENTIONS.md §3.2 and docs/db-schema.md §1–§9.
 */

export {
  createPool,
  query,
  closePool,
  type TenantCtx,
  type Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "./pool.js";

export {
  tenantScopedQuery,
  tenantScopedAll,
  TenantScopeError,
  TENANT_ID_COLUMN,
} from "./tenant-scoped.js";

export {
  runMigrations,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  type RunMigrationsOptions,
} from "./migrate.js";

/**
 * Readiness probe for a Postgres pool. `SELECT 1` against the pool; reports
 * `up` on success or `down` with the error message on failure. Wired into
 * `createApp` (server.ts) so `/readyz` reflects real DB reachability.
 */
export { dbReadinessCheck } from "./readiness.js";
