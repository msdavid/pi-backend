/**
 * Scheduler correctness tests (R5.3, §17.8): cron-cursor isolation from manual
 * runs, and at-least-once recovery of claimed-but-untriggered rows.
 *
 * Both use a real testcontainers-Postgres (real migrations) plus a `FakeClock`
 * so the tick loop is driven deterministically. The seeded environment is
 * `archived`, so {@link executeJobRun} short-circuits to an `environment_archived`
 * run error before any session is created — we assert only on `job_runs` rows,
 * keeping the tests independent of the session/sandbox layer.
 *
 * Skips without a container runtime (see {@link hasContainerRuntime}).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { newId } from "../../tenant/ids.js";
import type { Clock } from "../../ports.js";
import { CronScheduler } from "../tick.js";

const RUNTIME = hasContainerRuntime();

/** Deterministic clock for the tick loop (§17.8). */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
}

const iso = (s: string): Date => new Date(s);

interface JobRunRow {
  id: string;
  scheduled_at: Date;
  triggered_at: Date | null;
  manual: boolean;
}

describe.skipIf(!RUNTIME)("scheduler correctness (R5.3, §17.8)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantId: string;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");

    const tenant = await createTenant(pool, { name: "Scheduler Tenant" });
    tenantId = tenant.id;

    // Minimal FK anchors. The environment is archived so executeJobRun records a
    // run error without creating a session (see module doc).
    agentId = newId("agent_");
    await query(
      pool,
      `INSERT INTO agents (tenant_id, id, name, current_version, status)
       VALUES ($1, $2, 'sched-agent', 1, 'active')`,
      [tenantId, agentId],
    );
    envId = newId("env_");
    await query(
      pool,
      `INSERT INTO environments
         (tenant_id, id, name, type, image, resources, networking, status)
       VALUES ($1, $2, 'sched-env', 'cloud', 'img:latest',
               '{"cpus":1,"memoryMiB":512}'::jsonb,
               '{"mode":"unrestricted"}'::jsonb, 'archived')`,
      [tenantId, envId],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  /** Seed a job row directly (bypasses job-service; peer-owned). */
  async function seedJob(opts: {
    cron: string;
    createdAt: Date;
  }): Promise<string> {
    const jobId = newId("job_");
    await query(
      pool,
      `INSERT INTO jobs
         (tenant_id, id, name, agent_id, agent_version, environment_id,
          initial_events, schedule_cron, schedule_tz, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, '[]'::jsonb, $6, 'UTC', $7, $7)`,
      [tenantId, jobId, jobId, agentId, envId, opts.cron, opts.createdAt],
    );
    return jobId;
  }

  async function runsFor(jobId: string): Promise<JobRunRow[]> {
    const { rows } = await query<JobRunRow>(
      pool,
      `SELECT id, scheduled_at, triggered_at, manual
         FROM job_runs WHERE job_id = $1 ORDER BY scheduled_at`,
      [jobId],
    );
    return rows;
  }

  it("a manual run does not swallow a still-due cron occurrence", async () => {
    // Every 5 minutes; created at 00:00 → occurrences at 00:05, 00:10, …
    const jobId = await seedJob({
      cron: "*/5 * * * *",
      createdAt: iso("2026-01-01T00:00:00Z"),
    });

    // A manual run at 00:07 — later than the still-due 00:05 occurrence. If the
    // cron cursor counted manual runs, MAX(scheduled_at)=00:07 would push the
    // cursor past 00:05 and swallow it.
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual)
       VALUES ($1, $2, $3, $4, now(), true)`,
      [tenantId, newId("jr_"), jobId, iso("2026-01-01T00:07:00Z")],
    );

    const clock = new FakeClock(iso("2026-01-01T00:08:00Z"));
    // Wide catch-up window so 00:05 fires (rather than being recorded skipped).
    const scheduler = new CronScheduler({ pool, clock, catchUpMs: 60 * 60_000 });
    await scheduler.tick();

    const runs = await runsFor(jobId);
    const cron = runs.filter((r) => !r.manual);
    expect(cron).toHaveLength(1);
    expect(cron[0].scheduled_at.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    // Fired: triggered_at stamped after the (failed) execute path.
    expect(cron[0].triggered_at).not.toBeNull();
    // The manual row is still present and untouched.
    expect(runs.filter((r) => r.manual)).toHaveLength(1);
  });

  it("re-fires a claimed-but-untriggered row on the next tick", async () => {
    // Schedule that never comes due in our window, so processJob fires nothing
    // and the recovery scan is the only path that can touch the stale row.
    const jobId = await seedJob({
      cron: "0 0 1 1 *", // 00:00 on Jan 1, yearly
      createdAt: iso("2026-06-01T00:00:00Z"),
    });

    // A row claimed by a crashed earlier tick: manual=false, triggered_at NULL,
    // scheduled_at within the catch-up window of `now`.
    const runId = newId("jr_");
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual)
       VALUES ($1, $2, $3, $4, NULL, false)`,
      [tenantId, runId, jobId, iso("2026-06-15T12:00:00Z")],
    );

    const clock = new FakeClock(iso("2026-06-15T12:02:00Z"));
    const scheduler = new CronScheduler({ pool, clock, catchUpMs: 5 * 60_000 });
    await scheduler.tick();

    const { rows } = await query<JobRunRow>(
      pool,
      `SELECT id, scheduled_at, triggered_at, manual
         FROM job_runs WHERE id = $1`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    // Recovery re-fired it → triggered_at is now stamped.
    expect(rows[0].triggered_at).not.toBeNull();
  });
});
