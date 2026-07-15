/**
 * Scheduled-jobs domain module (WP-2.1 — crons).
 *
 * Cron parser with literal wall-clock DST semantics (§17.2), the job service
 * (CRUD + lifecycle), the failure/run-execution path (§17.4 / §17.6), and the
 * tick loop with exactly-once firing (§17.8).
 *
 * @see docs/api-reference.md §"Scheduled Jobs (Crons)"
 * @see docs/db-schema.md §3.9
 */

export {
  parseCron,
  nextOccurrence,
  instantsForWallClock,
  wallOf,
  validateSchedule,
  jitterMs,
  JITTER_MAX_MS,
  type ParsedCron,
  type WallClock,
} from "./cron.js";

export {
  createJob,
  listJobs,
  getJob,
  fetchJobRow,
  pauseJob,
  unpauseJob,
  archiveJob,
  runJob,
  listRuns,
  toJob,
  MAX_JOBS_PER_TENANT,
  type JobRow,
  type ListJobsOptions,
} from "./job-service.js";

export {
  executeJobRun,
  autoPause,
  type TriggerSessionFn,
  type RunOutcome,
} from "./failures.js";

export {
  CronScheduler,
  startSchedulerLoop,
  enumerateOccurrences,
  DEFAULT_CATCHUP_MS,
  DEFAULT_TICK_INTERVAL_MS,
  type SchedulerDeps,
  type SchedulerLoopHandle,
  type SchedulerLoopOptions,
} from "./tick.js";
