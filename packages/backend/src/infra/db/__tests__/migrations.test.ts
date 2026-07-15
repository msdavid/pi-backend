/**
 * Migration up/down clean test (WP-P0.2).
 *
 * Verifies forward-only migrations apply cleanly (every table any migration
 * creates exists) and roll back cleanly (every one of those tables is gone) via
 * `information_schema`. The down-migration assertion is only as strong as
 * `TABLES` below: a down migration that leaks a table NOT in this list would
 * pass silently, so `TABLES` must track every `CREATE TABLE` across
 * `migrations/*.sql`, not just the original schema.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, closePool, query, runMigrations } from "../index.js";
import { startPostgres, type TestDb } from "./test-runtime.js";

const runtime = startPostgres();

describe("migrations up/down", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await runtime;
  }, 120_000);

  afterAll(async () => {
    if (db) await db.container.stop();
  });

  // Every table created by migrations/*.sql (001-033), in dependency/creation
  // order. IMPORTANT: when a new migration adds a `CREATE TABLE`, add its name
  // here too — this list is what makes the down-migration round-trip test
  // below actually catch a leaked table, not just the up-migration test.
  const TABLES = [
    // 001-020: original schema (docs/db-schema.md §3).
    "tenants",
    "api_keys",
    "agents",
    "agent_versions",
    "environments",
    "sessions",
    "vaults",
    "vault_credentials",
    "memory_stores",
    "memory_versions",
    "files",
    "skills",
    "skill_versions",
    "jobs",
    "job_runs",
    "webhooks",
    "webhook_deliveries",
    "session_outcomes",
    "session_threads",
    "usage_records",
    // 021+: added after the original schema.
    "idempotency_keys", // 021_idempotency_keys.sql
    "self_hosted_work_queue", // 023_self_hosted_work_queue.sql
    "sandbox_hosts", // 024_sandbox_hosts.sql
    "sandbox_host_placements", // 024_sandbox_hosts.sql
    "onboarding_signups", // 025_onboarding.sql
    "rate_limit_buckets", // 027_rate_limit_buckets.sql
    "session_events", // 030_session_events.sql
    "tenant_quota_counters", // 031_tenant_quota_counters.sql
  ];

  async function existingTables(pool: Parameters<typeof query>[0]): Promise<string[]> {
    const { rows } = await query<{ table_name: string }>(
      pool,
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    return rows.map((r) => r.table_name);
  }

  it("applies all migrations up", async () => {
    const pool = createPool({ connectionString: db.connectionString });
    try {
      await runMigrations(db.connectionString, "up");
      const tables = new Set(await existingTables(pool));
      for (const t of TABLES) {
        expect(tables.has(t), `missing table: ${t}`).toBe(true);
      }
      // The migrations ledger table exists too.
      expect(tables.has("pgmigrations")).toBe(true);
    } finally {
      await closePool(pool);
    }
  }, 120_000);

  it("rolls all migrations down cleanly (tables gone)", async () => {
    const pool = createPool({ connectionString: db.connectionString });
    try {
      await runMigrations(db.connectionString, "down");
      const tables = new Set(await existingTables(pool));
      for (const t of TABLES) {
        expect(tables.has(t), `table still present after down: ${t}`).toBe(false);
      }
    } finally {
      await closePool(pool);
    }
  }, 120_000);
});
