/**
 * The cron tick loop (WP-2.1, §17.8).
 *
 * {@link CronScheduler.tick} computes due jobs and claims each occurrence via
 * `INSERT INTO job_runs … ON CONFLICT (job_id, scheduled_at) DO NOTHING` — the
 * Postgres unique constraint is the exactly-once invariant, so a crashed /
 * restarted scheduler or a second control-plane node cannot double-fire.
 *
 * Catch-up window (default 5 min, §17.8): occurrences missed while the loop was
 * down, within the window, fire late; older misses are recorded as skipped runs
 * (rows with `triggered_at = NULL`, no session, no error). On a successful
 * claim the shared {@link executeJobRun} path creates a session and records
 * `session_id` (or `error.type` on failure, with auto-pause per §17.6).
 *
 * Claim/execute ordering is at-least-once (§17.8): the claim INSERT stamps
 * `claimed_at` but leaves `triggered_at = NULL`, {@link executeJobRun} runs, then
 * `triggered_at` is stamped. A crash between claim and stamp leaves a
 * claimed-but-untriggered row; every tick begins with a recovery scan
 * ({@link CronScheduler.recoverUntriggered}) that re-fires such rows
 * (`triggered_at IS NULL AND manual = false`) still within the catch-up window —
 * skipped rows sit below the window and are never touched. Recovery re-claims
 * each row with an atomic CAS on `claimed_at` (lease {@link CLAIM_LEASE_MS},
 * compared against the DB clock so app↔DB skew cannot mis-size it) so a second
 * node running recovery — or an in-flight fresh claim — cannot double-fire the
 * same occurrence. The executing node renews its claim every
 * {@link CLAIM_HEARTBEAT_MS} while the run is in flight, so even a run that
 * outlasts the lease is never mistaken for a crashed node's stale claim.
 *
 * The cron cursor ({@link CronScheduler.listActiveJobs}, one batched
 * `MAX(scheduled_at) GROUP BY job_id` — not a per-job query) filters
 * `manual = false` so a manual run (§17.7) at an arbitrary time cannot poison the
 * cron cadence by advancing the cursor past a still-due occurrence.
 *
 * The clock is injectable ({@link Clock}) so DST skip/double-fire and catch-up
 * are tested deterministically. The scheduler queries `jobs` across tenants
 * (a privileged system query — NOT request-scoped — so it uses the raw `query`
 * helper, not `tenantScopedQuery`); per-tenant isolation is restored for the
 * session-creation call, which receives a `{tenantId}` context.
 */

import { query, type Pool, type TenantCtx } from "../../infra/db/index.js";
import {
  recordJobRun,
  SpanAttrs,
  SpanNames,
  withSpan,
} from "../../infra/telemetry/conventions.js";
import type { Clock, Scheduler } from "../ports.js";
import { newId } from "../tenant/ids.js";
import { nextOccurrence, jitterMs } from "./cron.js";
import { executeJobRun, type TriggerSessionFn } from "./failures.js";
import type { JobRow } from "./job-service.js";
import type { WebhookEventSource } from "../webhook/event-source.js";

/** Default catch-up window: 5 minutes (§17.8). */
export const DEFAULT_CATCHUP_MS = 5 * 60_000;

/** Default tick interval: 1 minute (§17.8). */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

/**
 * Recovery claim lease (§17.8). A run is claimed (`claimed_at` stamped) by the
 * node executing it; the recovery scan only re-fires a still-untriggered run
 * whose claim is older than this lease, so an in-flight fresh claim from another
 * node is never stolen (the cross-node double-fire fix), while a genuinely stale
 * claim (a node that crashed mid-execute) is reclaimed on a later tick.
 *
 * The lease is NOT sized to bound a whole execution — `executeJobRun` creates a
 * session and dispatches events and can exceed a tick interval — so the executing
 * node renews its claim (`claimed_at = now()`) every {@link CLAIM_HEARTBEAT_MS}
 * while the run is in flight ({@link CronScheduler.startClaimHeartbeat}). A live
 * node therefore keeps `claimed_at` within the lease no matter how long the run
 * takes; only a node that has actually died (its heartbeat stopped) lets the
 * lease expire, at which point recovery reclaims the row. One tick interval keeps
 * that reclaim prompt and well inside the catch-up window.
 */
export const CLAIM_LEASE_MS = DEFAULT_TICK_INTERVAL_MS;

/**
 * Claim heartbeat period (§17.8): how often the executing node renews
 * `claimed_at` while a run is in flight. A third of the lease, so a live node
 * renews twice over before the lease could expire — leaving no window in which a
 * healthy in-flight claim looks stale to another node's recovery scan.
 */
export const CLAIM_HEARTBEAT_MS = Math.floor(CLAIM_LEASE_MS / 3);

export interface SchedulerDeps {
  pool: Pool;
  /** Injectable clock (§17.8) — `FakeClock` in tests. */
  clock: Clock;
  /** Catch-up window in ms (default 5 min). Occurrences older than `now - catchUpMs` are skipped. */
  catchUpMs?: number;
  /** Optional hook to dispatch `initialEvents` into the created session. */
  triggerSession?: TriggerSessionFn;
  /** Optional webhook event source — fires `job.run_*` / `job.paused` (§23.1). */
  eventSource?: WebhookEventSource;
}

/**
 * Cron-driven scheduler. Implements the {@link Scheduler} port (§17.8).
 * Stateless between ticks — all durability lives in Postgres.
 */
export class CronScheduler implements Scheduler {
  private readonly catchUpMs: number;
  constructor(private readonly deps: SchedulerDeps) {
    this.catchUpMs = deps.catchUpMs ?? DEFAULT_CATCHUP_MS;
  }

  /**
   * Advance one tick: compute due jobs, claim and fire them (§17.8).
   *
   * Wrapped in the `pi.scheduler.tick` span (WP-8.1); each job run it fires opens a
   * child `pi.job.run` span, so one trace shows the whole sweep. Instrumentation is
   * observational only — the per-job `catch` below still swallows exactly what it did.
   */
  async tick(): Promise<void> {
    return withSpan(SpanNames.SCHEDULER_TICK, async (span) => {
      const now = this.deps.clock.now();
      await this.recoverUntriggered(now);
      const jobs = await this.listActiveJobs();
      span.setAttribute("pi.scheduler.active_jobs", jobs.length);
      for (const job of jobs) {
        try {
          await this.processJob(job, job.last_scheduled_at, now);
        } catch {
          // A single job must not abort the whole tick. The error is already
          // recorded on the run row by executeJobRun when applicable; here we
          // simply continue to the next job.
        }
      }
    });
  }

  /**
   * All active (non-paused, non-archived) jobs across all tenants, each with its
   * cron cursor (`last_scheduled_at`) resolved in the SAME query — one batched
   * `LEFT JOIN` against `MAX(scheduled_at)` grouped by job, NOT a per-job
   * `SELECT MAX(...)` (which was N+1: 10k+ round trips per tick at scale, a tick
   * that could outlast its interval).
   *
   * The subquery filters `manual = false`: manual runs (§17.7) fire at arbitrary
   * times and must not advance the cron cursor, or a manual run past a still-due
   * occurrence would swallow it (§17.8). `job_id` is globally unique (the join
   * key), so each job's aggregate is tenant-correct without an explicit
   * `tenant_id` predicate.
   */
  private async listActiveJobs(): Promise<
    Array<JobRow & { last_scheduled_at: Date | null }>
  > {
    const { rows } = await query<JobRow & { last_scheduled_at: Date | null }>(
      this.deps.pool,
      `SELECT j.*, m.max_scheduled AS last_scheduled_at
         FROM jobs j
         LEFT JOIN (
           SELECT job_id, MAX(scheduled_at) AS max_scheduled
             FROM job_runs
            WHERE manual = false
            GROUP BY job_id
         ) m ON m.job_id = j.id
        WHERE j.status = 'active'`,
      [],
    );
    return rows;
  }

  /** Enumerate this job's occurrences since its last recorded one, up to `now`. */
  private async processJob(
    job: JobRow,
    last: Date | null,
    now: Date,
  ): Promise<void> {
    const from = last ?? job.created_at;
    const occurrences = enumerateOccurrences(
      job.schedule_cron,
      job.schedule_tz,
      from,
      now,
    );
    const windowStart = now.getTime() - this.catchUpMs;
    // In-window occurrences fire one at a time (each creates a session); misses
    // beyond the window are collected and recorded in one batched insert (§17.8)
    // — a long-paused minute cron can miss tens of thousands at once.
    const skipped: Date[] = [];
    for (const occ of occurrences) {
      if (occ.getTime() >= windowStart) {
        await this.fireOccurrence(job, occ);
      } else {
        skipped.push(occ);
      }
    }
    await this.recordSkipped(job, skipped);
  }

  /**
   * Claim + fire a single occurrence (exactly-once via ON CONFLICT, §17.8). The
   * claim stamps `claimed_at` (so the recovery scan's lease excludes this
   * in-flight row) but leaves `triggered_at = NULL`; {@link executeClaimedRun}
   * runs the shared path and stamps `triggered_at` afterwards (at-least-once).
   */
  private async fireOccurrence(job: JobRow, occ: Date): Promise<void> {
    const runId = newId("jr_");
    // systemQuery: privileged cross-tenant write from the scheduler sweep. It is
    // NOT request-scoped, so it uses the raw `query` helper — but it binds the
    // job's own tenant_id explicitly ($1) so the inserted row is tenant-correct.
    const { rows } = await query<{ id: string }>(
      this.deps.pool,
      `INSERT INTO job_runs (tenant_id, id, job_id, scheduled_at, manual, claimed_at)
       VALUES ($1, $2, $3, $4, false, now())
       ON CONFLICT (job_id, scheduled_at) DO NOTHING
       RETURNING id`,
      [job.tenant_id, runId, job.id, occ],
    );
    if (!rows[0]) return; // another loop/node already claimed this occurrence
    await this.executeClaimedRun(job, rows[0].id);
  }

  /**
   * Run the shared execute path for an already-claimed run row, then stamp
   * `triggered_at` (at-least-once, §17.8). Shared by {@link fireOccurrence} and
   * the {@link recoverUntriggered} recovery scan.
   */
  private async executeClaimedRun(job: JobRow, runId: string): Promise<void> {
    const ctx: TenantCtx = { tenantId: job.tenant_id };
    // Renew the claim while the (potentially long) run path is in flight, so a
    // slow session creation cannot let the lease expire and another node's
    // recovery re-fire this occurrence (the cross-node double-fire fix, §17.8).
    const heartbeat = this.startClaimHeartbeat(runId);
    try {
      // `pi.job.run` (WP-8.1). `executeJobRun` already REPORTS failure by return value
      // (it never throws for a §17.4 taxonomy error), so the span/metric read that value
      // rather than a rejection — a paused/failed run is a `failed` outcome, not an error
      // span. An infrastructure throw still propagates untouched to the caller's catch.
      const outcome = await withSpan(
        SpanNames.JOB_RUN,
        async (span) => {
          span.setAttributes({
            [SpanAttrs.JOB_ID]: job.id,
            [SpanAttrs.TENANT_ID]: job.tenant_id,
          });
          const result = await executeJobRun(
            this.deps.pool,
            ctx,
            job,
            runId,
            false,
            this.deps.triggerSession,
            this.deps.eventSource,
          );
          span.setAttribute(SpanAttrs.OUTCOME, result.ok ? "succeeded" : "failed");
          if (result.ok) {
            span.setAttribute(SpanAttrs.SESSION_ID, result.sessionId);
          } else {
            span.setAttribute("pi.job.error", result.error);
          }
          return result;
        },
      );
      recordJobRun(outcome.ok ? "succeeded" : "failed", {
        [SpanAttrs.JOB_ID]: job.id,
        [SpanAttrs.TENANT_ID]: job.tenant_id,
      });
      // Stamp triggered_at only after the run path completed — a crash before here
      // leaves the row untriggered for the recovery scan to re-fire.
      await query(
        this.deps.pool,
        `UPDATE job_runs SET triggered_at = now() WHERE id = $1`,
        [runId],
      );
      // One-shot jobs fire once then archive (§14.4, §17.8).
      if (job.one_shot) {
        // systemQuery: privileged scheduler write, keyed by the globally-unique
        // job id (not request-scoped, so raw `query`); the job was read from this
        // same cross-tenant sweep.
        await query(
          this.deps.pool,
          `UPDATE jobs SET status = 'archived', updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [job.id],
        );
      }
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Start renewing an in-flight run's claim (§17.8). Every {@link
   * CLAIM_HEARTBEAT_MS} it stamps `claimed_at = now()` (DB clock) on the still-
   * untriggered row, so the recovery lease never expires while this node is alive
   * and executing — however long the run path takes. The interval is `unref`'d so
   * it never keeps the process alive, and renewal is a no-op once `triggered_at`
   * is set. {@link executeClaimedRun} always stops it in a `finally`.
   */
  private startClaimHeartbeat(runId: string): { stop(): void } {
    const timer = setInterval(() => {
      void query(
        this.deps.pool,
        `UPDATE job_runs SET claimed_at = now()
          WHERE id = $1 AND triggered_at IS NULL`,
        [runId],
      ).catch(() => {
        // A missed renewal is safe: the lease simply shortens for one period. The
        // next beat retries; a persistent failure means this node is unhealthy and
        // the lease SHOULD expire so recovery takes over.
      });
    }, CLAIM_HEARTBEAT_MS);
    timer.unref?.();
    return {
      stop(): void {
        clearInterval(timer);
      },
    };
  }

  /**
   * Recovery scan (§17.8): re-fire rows claimed by an earlier tick that crashed
   * before stamping `triggered_at`. Only rows still inside the catch-up window
   * are eligible — skipped rows (recorded by {@link recordSkipped}) are always
   * below the window, so they are never re-fired.
   *
   * Cross-node safety: each candidate is re-claimed with an atomic CAS
   * (`UPDATE … SET claimed_at = now() WHERE … RETURNING id`) before it runs, so
   * only the node whose UPDATE returns a row executes it — two nodes recovering
   * at once cannot double-fire. A fresh claim from an in-flight {@link
   * fireOccurrence} (or another recovery pass) is excluded by the lease
   * ({@link CLAIM_LEASE_MS}); only a genuinely stale claim is reclaimed.
   *
   * The lease is compared against the DATABASE clock — `claimed_at < now() -
   * lease`, evaluated in SQL — not against `this.deps.clock.now()`. `claimed_at`
   * is always stamped with the DB's `now()` (both here and in {@link
   * fireOccurrence}), so a comparison threshold from the app clock would let any
   * app↔DB skew shorten or lengthen the effective lease and, at worst, steal a
   * fresh in-flight claim. The catch-up window (`scheduled_at >= windowStart`)
   * stays on the injectable clock because `scheduled_at` is an app-clock cron
   * occurrence.
   */
  private async recoverUntriggered(now: Date): Promise<void> {
    const windowStart = new Date(now.getTime() - this.catchUpMs);
    const leaseSecs = CLAIM_LEASE_MS / 1000;
    // systemQuery: privileged cross-tenant read (raw `query`); joins each stale
    // run to its job so the shared execute path has the full job row. Candidate =
    // untriggered cron run, inside the catch-up window, never claimed or claimed
    // longer than the lease ago (a fresh in-flight claim is deliberately excluded).
    const { rows } = await query<JobRow & { run_id: string }>(
      this.deps.pool,
      `SELECT j.*, r.id AS run_id
         FROM job_runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE r.triggered_at IS NULL
          AND r.manual = false
          AND r.scheduled_at >= $1
          AND (r.claimed_at IS NULL
               OR r.claimed_at < now() - make_interval(secs => $2::double precision))`,
      [windowStart, leaseSecs],
    );
    for (const row of rows) {
      const { run_id: runId, ...job } = row;
      // Atomic CAS claim: only the node whose UPDATE returns a row re-fires this
      // occurrence. A concurrent recovery pass — or a fireOccurrence that has
      // since claimed/stamped the row — finds the guard no longer holds and gets
      // no row back, so it skips. This is what makes recovery at-most-once.
      const { rows: claimed } = await query<{ id: string }>(
        this.deps.pool,
        `UPDATE job_runs SET claimed_at = now()
          WHERE id = $1
            AND triggered_at IS NULL
            AND (claimed_at IS NULL
                 OR claimed_at < now() - make_interval(secs => $2::double precision))
          RETURNING id`,
        [runId, leaseSecs],
      );
      if (!claimed[0]) continue; // another node claimed/completed it first
      try {
        await this.executeClaimedRun(job as JobRow, runId);
      } catch {
        // This node's execute threw (infra error) before stamping triggered_at.
        // Release our claim so the next tick retries promptly (still within the
        // window); safe because the CAS gave us exclusive ownership — no other
        // node ran this occurrence.
        await query(
          this.deps.pool,
          `UPDATE job_runs SET claimed_at = NULL
            WHERE id = $1 AND triggered_at IS NULL`,
          [runId],
        );
      }
    }
  }

  /**
   * Record missed (beyond catch-up) occurrences as skipped runs (§17.8), in one
   * batched multi-row insert per chunk instead of one INSERT per occurrence — a
   * long-paused minute cron can miss tens of thousands at once, and per-row
   * inserts made a single tick issue tens of thousands of round trips.
   *
   * Chunked at {@link SKIPPED_INSERT_CHUNK} rows (4 params each) to stay well
   * under Postgres' 65535-parameter cap. `ON CONFLICT (job_id, scheduled_at) DO
   * NOTHING` keeps the exactly-once semantics identical to the per-row path.
   */
  private async recordSkipped(job: JobRow, occurrences: Date[]): Promise<void> {
    if (occurrences.length === 0) return;
    for (let i = 0; i < occurrences.length; i += SKIPPED_INSERT_CHUNK) {
      const chunk = occurrences.slice(i, i + SKIPPED_INSERT_CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const occ of chunk) {
        const b = params.length;
        values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, false)`);
        params.push(job.tenant_id, newId("jr_"), job.id, occ);
      }
      // systemQuery: privileged cross-tenant write from the scheduler sweep (raw
      // `query`, not request-scoped); binds the job's own tenant_id explicitly.
      await query(
        this.deps.pool,
        `INSERT INTO job_runs (tenant_id, id, job_id, scheduled_at, manual)
         VALUES ${values.join(", ")}
         ON CONFLICT (job_id, scheduled_at) DO NOTHING`,
        params,
      );
    }
  }
}

/**
 * Rows per batched skipped-run insert. Each row binds 4 params; 5,000 rows =
 * 20,000 params, comfortably under Postgres' 65,535-parameter statement cap.
 */
export const SKIPPED_INSERT_CHUNK = 5000;

/**
 * Enumerate every occurrence of `cron` in `tz` strictly after `from` up to and
 * including `until`. Bounded by a guard to avoid runaway loops on pathological
 * input (the caller passes `until` = now, so this is at most a few thousand
 * for a long catch-up gap on a minute cron).
 */
export function enumerateOccurrences(
  cron: string,
  tz: string,
  from: Date,
  until: Date,
): Date[] {
  const out: Date[] = [];
  const untilMs = until.getTime();
  let cur = nextOccurrence(cron, tz, from);
  let guard = 0;
  while (cur && cur.getTime() <= untilMs && guard < 100_000) {
    out.push(cur);
    cur = nextOccurrence(cron, tz, cur);
    guard++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Production loop (setInterval + jitter)
// ---------------------------------------------------------------------------

export interface SchedulerLoopHandle {
  /** Stop the loop (clears the pending timer). Idempotent. */
  stop(): void;
}

export interface SchedulerLoopOptions extends SchedulerDeps {
  /** Tick interval in ms (default 60s, §17.8). */
  intervalMs?: number;
  /** Max jitter added to each interval (≤10s, §17.2). 0 disables. */
  jitterMaxMs?: number;
}

/**
 * Start a background tick loop. Ticks every `intervalMs` (+ up to
 * `jitterMaxMs`); the timer is `unref`'d so it never keeps the process alive
 * on its own. Returns a handle to stop the loop (graceful shutdown).
 */
export function startSchedulerLoop(
  opts: SchedulerLoopOptions,
): SchedulerLoopHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const scheduler = new CronScheduler(opts);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    const jitter = opts.jitterMaxMs ? jitterMs(opts.jitterMaxMs) : 0;
    timer = setTimeout(runOnce, intervalMs + jitter);
    // unref so the timer doesn't block process exit / tests.
    timer.unref?.();
  };

  const runOnce = async (): Promise<void> => {
    try {
      await scheduler.tick();
    } catch {
      // Swallow — a tick failure must not kill the loop. Postgres is the
      // source of truth; the next tick resumes from the last recorded run.
    }
    scheduleNext();
  };

  scheduleNext();
  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
