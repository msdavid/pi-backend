/**
 * Migration runner (WP-P0.2) — a thin wrapper over node-pg-migrate.
 *
 * Migrations are forward-only SQL files in `packages/backend/migrations/`. Each
 * file is a single `.sql` document with `-- Up Migration` and `-- Down
 * Migration` sections (node-pg-migrate parses these). Production runs only the
 * `up` direction (§3.2, db-schema.md §9); `down` is provided for the up/down
 * clean test and local development.
 *
 * The migrations directory is resolved relative to this compiled module so the
 * same path works in `src/` (dev, via vitest/ts-node) and `dist/` (built):
 * `dist/infra/db/migrate.js` → `../../../migrations` → `packages/backend/migrations`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runner as runPgMigrations,
} from "node-pg-migrate";
import type { MigrationDirection } from "node-pg-migrate/dist/types";


/** Table node-pg-migrate uses to record applied migrations. */
export const MIGRATIONS_TABLE = "pgmigrations";

/**
 * Absolute path to the migrations directory, resolved from this module's
 * location so it is correct regardless of the process `cwd()`.
 */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

export interface RunMigrationsOptions {
  /** Migration direction. Defaults to `'up'` (forward-only in prod, §3.2). */
  direction?: MigrationDirection;
  /** Override the migrations directory (tests). Defaults to {@link MIGRATIONS_DIR}. */
  dir?: string;
  /** Limit the number of migrations applied (passed through to node-pg-migrate). */
  count?: number;
}

/**
 * Run database migrations.
 *
 * @param dbUrl Postgres connection string (e.g. `config.dbUrl`).
 * @param direction `'up'` (default) or `'down'`. Prod never calls `'down'`.
 * @param opts Optional `dir`/`count` overrides.
 */
export async function runMigrations(
  dbUrl: string,
  direction: MigrationDirection = "up",
  opts: RunMigrationsOptions = {},
): Promise<void> {
  await runPgMigrations({
    databaseUrl: dbUrl,
    dir: opts.dir ?? MIGRATIONS_DIR,
    direction,
    migrationsTable: MIGRATIONS_TABLE,
    schema: "public",
    createSchema: true,
    createMigrationsSchema: true,
    // node-pg-migrate defaults `count` to 1 for `down` (only the last migration)
    // and Infinity for `up`. We want "all" for both directions unless the caller
    // passes an explicit count, so default `down` to Infinity.
    count: opts.count ?? (direction === "down" ? Number.POSITIVE_INFINITY : undefined),
    // Silence node-pg-migrate's console logger; callers route migration output
    // through the service logger if desired.
    log: () => {},
  });
}
