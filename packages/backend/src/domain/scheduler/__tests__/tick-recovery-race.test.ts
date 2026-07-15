/**
 * Scheduler recovery concurrency test (§17.8): the recovery scan must re-fire a
 * claimed-but-untriggered occurrence AT MOST ONCE even when two nodes run their
 * recovery pass at the same instant.
 *
 * Before the fix, `recoverUntriggered` was a plain SELECT of untriggered rows
 * followed immediately by execute, with no claim/CAS — so two concurrent ticks
 * both saw the same stale row and executed it, creating two sessions for one
 * occurrence. This test drives that exact race (two `CronScheduler`s sharing one
 * pool, `tick()`ed via `Promise.all`) and asserts the occurrence fires exactly
 * once. It FAILS against the unclaimed recovery code and PASSES after the CAS
 * claim (migration 034 `claimed_at`).
 *
 * Like the sibling `tick-manual-cursor` suite it uses a real testcontainers
 * Postgres (real migrations) + a `FakeClock`, and seeds an `archived` environment
 * so {@link executeJobRun} short-circuits to an `environment_archived` run error
 * before any session is created. Double execution is therefore counted via the
 * webhook event source: each execute of an auto-pause-eligible failure emits one
 * `job.run_failed` — so the emit count is the execution count.
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
import type { Clock, TenantId } from "../../ports.js";
import type { WebhookEventSource } from "../../webhook/event-source.js";
import type { WebhookEventType } from "@pi-managed/contracts";
import { CronScheduler } from "../tick.js";

const RUNTIME = hasContainerRuntime();

/** Deterministic clock for the tick loop (§17.8). */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

/** Counts webhook emits per type — each execute emits one `job.run_failed`. */
class CountingEventSource implements WebhookEventSource {
  readonly counts = new Map<string, number>();
  async emit(_tenantId: TenantId, type: WebhookEventType): Promise<void> {
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1);
  }
  count(type: WebhookEventType): number {
    return this.counts.get(type) ?? 0;
  }
}

const iso = (s: string): Date => new Date(s);

describe.skipIf(!RUNTIME)("scheduler recovery concurrency (§17.8)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantId: string;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");

    const tenant = await createTenant(pool, { name: "Recovery Race Tenant" });
    tenantId = tenant.id;

    // Minimal FK anchors. The environment is archived so executeJobRun records a
    // run error (environment_archived) without creating a session.
    agentId = newId("agent_");
    await query(
      pool,
      `INSERT INTO agents (tenant_id, id, name, current_version, status)
       VALUES ($1, $2, 'race-agent', 1, 'active')`,
      [tenantId, agentId],
    );
    envId = newId("env_");
    await query(
      pool,
      `INSERT INTO environments
         (tenant_id, id, name, type, image, resources, networking, status)
       VALUES ($1, $2, 'race-env', 'cloud', 'img:latest',
               '{"cpus":1,"memoryMiB":512}'::jsonb,
               '{"mode":"unrestricted"}'::jsonb, 'archived')`,
      [tenantId, envId],
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  /** Seed a job whose cron never comes due in-window, so only recovery fires. */
  async function seedInertJob(): Promise<string> {
    const jobId = newId("job_");
    await query(
      pool,
      `INSERT INTO jobs
         (tenant_id, id, name, agent_id, agent_version, environment_id,
          initial_events, schedule_cron, schedule_tz, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, '[]'::jsonb, '0 0 1 1 *', 'UTC', $6, $6)`,
      [tenantId, jobId, jobId, agentId, envId, iso("2026-06-01T00:00:00Z")],
    );
    return jobId;
  }

  it("two concurrent recovery passes fire a stale occurrence exactly once", async () => {
    const jobId = await seedInertJob();

    // A row claimed by a crashed earlier tick: manual=false, triggered_at NULL,
    // claimed_at NULL, scheduled_at within the catch-up window of `now`.
    const runId = newId("jr_");
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual)
       VALUES ($1, $2, $3, $4, NULL, false)`,
      [tenantId, runId, jobId, iso("2026-06-15T12:00:00Z")],
    );

    const now = iso("2026-06-15T12:02:00Z");
    const events = new CountingEventSource();
    // Several schedulers sharing one pool = many control-plane nodes ticking at
    // once. Post-fix the recovery CAS admits exactly one winner regardless of
    // node count, so this is the concurrency guarantee (a reliable pre-fix
    // failure — recovery executing a row it did not exclusively claim — is
    // captured deterministically by the fresh-vs-stale test below, since real
    // execution timing lets the racing ticks serialize by chance).
    const opts = { pool, clock: new FakeClock(now), catchUpMs: 5 * 60_000, eventSource: events };
    const nodes = Array.from({ length: 8 }, () => new CronScheduler(opts));

    await Promise.all(nodes.map((n) => n.tick()));

    // Exactly one execution: one `job.run_failed` emit (double-fire would be two).
    expect(events.count("job.run_failed")).toBe(1);

    const { rows } = await query<{ triggered_at: Date | null }>(
      pool,
      `SELECT triggered_at FROM job_runs WHERE id = $1`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].triggered_at).not.toBeNull();

    // No duplicate run row was created for the occurrence.
    const { rows: all } = await query<{ n: string }>(
      pool,
      `SELECT count(*) AS n FROM job_runs WHERE job_id = $1`,
      [jobId],
    );
    expect(Number(all[0].n)).toBe(1);
  });

  it("recovery skips a fresh in-flight claim but reclaims a stale one", async () => {
    const jobId = await seedInertJob();
    const now = iso("2026-07-01T00:10:00Z");

    // The lease is compared against the DB clock (skew fix, §17.8), so claimed_at
    // is seeded with DB-clock expressions (now() / now() - 2 min), decoupled from
    // the FakeClock — exactly as production writes it. scheduled_at stays in the
    // FakeClock catch-up window (windowStart = now - 5 min = 00:05:00).

    // A fresh claim (fireOccurrence in-flight on another node): claimed_at = DB
    // now(), triggered_at NULL. Recovery must NOT steal it (would double-fire).
    const fresh = newId("jr_");
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual, claimed_at)
       VALUES ($1, $2, $3, $4, NULL, false, now())`,
      [tenantId, fresh, jobId, iso("2026-07-01T00:09:30Z")],
    );
    // A stale claim (crashed mid-execute, older than the 60s lease): reclaimed.
    const stale = newId("jr_");
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual, claimed_at)
       VALUES ($1, $2, $3, $4, NULL, false, now() - interval '2 minutes')`,
      [tenantId, stale, jobId, iso("2026-07-01T00:08:00Z")],
    );

    const events = new CountingEventSource();
    const scheduler = new CronScheduler({
      pool,
      clock: new FakeClock(now),
      catchUpMs: 5 * 60_000,
      eventSource: events,
    });
    await scheduler.tick();

    // Only the stale row was recovered → exactly one execute.
    expect(events.count("job.run_failed")).toBe(1);

    const freshRow = await query<{ triggered_at: Date | null }>(
      pool,
      `SELECT triggered_at FROM job_runs WHERE id = $1`,
      [fresh],
    );
    expect(freshRow.rows[0].triggered_at).toBeNull(); // untouched
    const staleRow = await query<{ triggered_at: Date | null }>(
      pool,
      `SELECT triggered_at FROM job_runs WHERE id = $1`,
      [stale],
    );
    expect(staleRow.rows[0].triggered_at).not.toBeNull(); // re-fired
  });

  it("does not steal a fresh claim when the app clock runs far ahead of the DB (skew)", async () => {
    const jobId = await seedInertJob();
    // The scheduler's clock is years ahead of the DB wall clock. Under the old
    // app-clock lease (`claimed_at < clock.now() - lease`) a claim stamped with DB
    // now() looks ancient and gets stolen — a cross-node double-fire born purely of
    // skew. The lease now lives in SQL against DB now(), so a fresh claim survives.
    const now = iso("2032-01-01T00:10:00Z");

    const fresh = newId("jr_");
    await query(
      pool,
      `INSERT INTO job_runs
         (tenant_id, id, job_id, scheduled_at, triggered_at, manual, claimed_at)
       VALUES ($1, $2, $3, $4, NULL, false, now())`,
      // scheduled_at in the FakeClock catch-up window (now - 5 min = 00:05:00).
      [tenantId, fresh, jobId, iso("2032-01-01T00:09:30Z")],
    );

    const events = new CountingEventSource();
    const scheduler = new CronScheduler({
      pool,
      clock: new FakeClock(now),
      catchUpMs: 5 * 60_000,
      eventSource: events,
    });
    await scheduler.tick();

    // The fresh claim was NOT recovered despite the huge app↔DB skew.
    expect(events.count("job.run_failed")).toBe(0);
    const freshRow = await query<{ triggered_at: Date | null }>(
      pool,
      `SELECT triggered_at FROM job_runs WHERE id = $1`,
      [fresh],
    );
    expect(freshRow.rows[0].triggered_at).toBeNull(); // untouched
  });
});
