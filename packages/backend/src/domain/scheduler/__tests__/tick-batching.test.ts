/**
 * Scheduler batching tests (§17.8): the tick must resolve every active job's
 * cron cursor in ONE batched query (PERF-6, no per-job N+1) and record a
 * catch-up storm of missed occurrences with BATCHED inserts (ROB-22), not one
 * INSERT per miss.
 *
 * Like the sibling scheduler suites this uses a real testcontainers Postgres
 * (real migrations) + a `FakeClock`, and seeds an `archived` environment so
 * {@link executeJobRun} short-circuits to an `environment_archived` run error
 * before any session is created — assertions stay on `job_runs` rows.
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
import { CronScheduler, SKIPPED_INSERT_CHUNK } from "../tick.js";

const RUNTIME = hasContainerRuntime();

/** Deterministic clock for the tick loop (§17.8). */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

const iso = (s: string): Date => new Date(s);

interface JobRunRow {
  id: string;
  scheduled_at: Date;
  triggered_at: Date | null;
  manual: boolean;
}

describe.skipIf(!RUNTIME)("scheduler batching (§17.8)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantId: string;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");

    const tenant = await createTenant(pool, { name: "Batching Tenant" });
    tenantId = tenant.id;

    // Minimal FK anchors. The environment is archived so executeJobRun records a
    // run error (environment_archived) without creating a session.
    agentId = newId("agent_");
    await query(
      pool,
      `INSERT INTO agents (tenant_id, id, name, current_version, status)
       VALUES ($1, $2, 'batch-agent', 1, 'active')`,
      [tenantId, agentId],
    );
    envId = newId("env_");
    await query(
      pool,
      `INSERT INTO environments
         (tenant_id, id, name, type, image, resources, networking, status)
       VALUES ($1, $2, 'batch-env', 'cloud', 'img:latest',
               '{"cpus":1,"memoryMiB":512}'::jsonb,
               '{"mode":"unrestricted"}'::jsonb, 'archived')`,
      [tenantId, envId],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function seedJob(opts: { cron: string; createdAt: Date }): Promise<string> {
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

  it("PERF-6: resumes each active job from its own cron cursor in one batched sweep", async () => {
    // Two jobs, each with a different prior cron run. The batched
    // `MAX(scheduled_at) GROUP BY job_id` join must return the RIGHT cursor per
    // job, so neither re-fires an already-recorded occurrence.
    const jobA = await seedJob({
      cron: "*/5 * * * *", // every 5 min
      createdAt: iso("2026-03-01T00:00:00Z"),
    });
    const jobB = await seedJob({
      cron: "*/5 * * * *",
      createdAt: iso("2026-03-01T00:00:00Z"),
    });

    // A already fired 00:05; B already fired 00:05 and 00:10 (its cursor is later).
    for (const [job, at] of [
      [jobA, "2026-03-01T00:05:00Z"],
      [jobB, "2026-03-01T00:05:00Z"],
      [jobB, "2026-03-01T00:10:00Z"],
    ] as const) {
      await query(
        pool,
        `INSERT INTO job_runs (tenant_id, id, job_id, scheduled_at, triggered_at, manual)
         VALUES ($1, $2, $3, $4, $4, false)`,
        [tenantId, newId("jr_"), job, iso(at)],
      );
    }

    // Tick at 00:12 with a wide catch-up window so due occurrences fire.
    const scheduler = new CronScheduler({
      pool,
      clock: new FakeClock(iso("2026-03-01T00:12:00Z")),
      catchUpMs: 60 * 60_000,
    });
    await scheduler.tick();

    // A resumes from 00:05 → fires 00:10 only (00:15 is future). B resumes from
    // 00:10 → fires nothing new (00:15 is future). Neither re-fires a prior run.
    const aCron = (await runsFor(jobA)).filter((r) => !r.manual);
    expect(aCron.map((r) => r.scheduled_at.toISOString())).toEqual([
      "2026-03-01T00:05:00.000Z",
      "2026-03-01T00:10:00.000Z",
    ]);
    const bCron = (await runsFor(jobB)).filter((r) => !r.manual);
    expect(bCron.map((r) => r.scheduled_at.toISOString())).toEqual([
      "2026-03-01T00:05:00.000Z",
      "2026-03-01T00:10:00.000Z",
    ]);
  });

  it("ROB-22: records a long catch-up storm as batched skipped rows spanning chunks", async () => {
    // A minute cron reactivated after a long pause. Every occurrence older than
    // the catch-up window is a skipped row — enough to cross the insert-chunk
    // boundary, proving the batched path handles a multi-chunk storm.
    const minutes = SKIPPED_INSERT_CHUNK + 200; // > one chunk of skipped rows
    const createdAt = iso("2026-04-01T00:00:00Z");
    const now = new Date(createdAt.getTime() + minutes * 60_000);
    const jobId = await seedJob({ cron: "* * * * *", createdAt });

    const scheduler = new CronScheduler({
      pool,
      clock: new FakeClock(now),
      catchUpMs: 5 * 60_000, // only the last ~5 occurrences fire; the rest skip
    });
    await scheduler.tick();

    const runs = await runsFor(jobId);
    // Cron occurrences run from 00:01 (first strictly after createdAt) up to now
    // inclusive → `minutes` of them. All recorded exactly once.
    expect(runs).toHaveLength(minutes);

    const skipped = runs.filter((r) => r.triggered_at === null);
    const fired = runs.filter((r) => r.triggered_at !== null);
    // Skipped rows are the misses below the window; they carry no triggered_at.
    expect(skipped.length).toBeGreaterThan(SKIPPED_INSERT_CHUNK);
    // A handful of in-window occurrences fired (execute + triggered_at stamp).
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(skipped.length + fired.length).toBe(minutes);

    // The batched skipped rows advanced the cron cursor: a second tick at the same
    // instant re-enumerates from MAX(scheduled_at) and records nothing new.
    await scheduler.tick();
    expect(await runsFor(jobId)).toHaveLength(minutes);
  }, 60_000); // enumerating > one chunk of minute occurrences is the slow part
});
