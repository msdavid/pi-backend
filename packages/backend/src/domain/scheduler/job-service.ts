/**
 * Scheduled-job domain service (WP-2.1, §17).
 *
 * CRUD + lifecycle for `jobs` (docs/db-schema.md §3.9). Every request-scoped
 * query routes through {@link tenantScopedQuery} so cross-tenant access is
 * impossible by construction (§27.1). The 1,000-job-per-tenant limit (§17.3) is
 * enforced here at creation.
 *
 * Lifecycle (§17.5): `active` ⇄ `paused` (no backfill on resume); `archived`
 * is terminal/immutable. Auto-archive when the job's agent is archived is
 * enforced on archive (§17.5). Manual `runJob` works while paused (§17.7) and
 * delegates the actual session creation to {@link executeJobRun} (failures.ts).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { newId } from "../tenant/ids.js";
import { isAgentArchived, getAgent, getVersion } from "../agent/agent.js";
import { getEnvironment } from "../environment/environment.js";
import { reserveQuota, releaseQuota } from "../quota/index.js";
import {
  JobCreate,
  type Budget,
  type Job,
  type JobRun,
  type JobRunError,
  type JobStatus,
  type PausedReason,
  type SessionAgentField,
} from "@pi-managed/contracts";
import { validateSchedule } from "./cron.js";
import { executeJobRun, type TriggerSessionFn } from "./failures.js";

/** Max jobs per tenant (§17.3). Enforced at creation; archived jobs excluded. */
export const MAX_JOBS_PER_TENANT = 1000;

// ---------------------------------------------------------------------------
// Row shape & mapping
// ---------------------------------------------------------------------------

/** `jobs` row (snake_case; jsonb columns arrive as parsed objects). */
export interface JobRow {
  tenant_id: string;
  id: string;
  name: string;
  agent_id: string;
  agent_version: number;
  environment_id: string;
  initial_events: unknown[];
  session_config: {
    resources?: string[];
    vaultIds?: string[];
    budget?: Budget;
  };
  schedule_cron: string;
  schedule_tz: string;
  one_shot: boolean;
  status: string;
  paused_reason: PausedReason | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: Date): string => d.toISOString();

/** Build the wire `Job` resource from a db row. */
export function toJob(row: JobRow): Job {
  const job: Job = {
    id: row.id,
    name: row.name,
    status: row.status as JobStatus,
    agent: { id: row.agent_id, version: row.agent_version } as SessionAgentField,
    environmentId: row.environment_id,
    schedule: { cron: row.schedule_cron, tz: row.schedule_tz },
    oneShot: row.one_shot,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.paused_reason) job.pausedReason = row.paused_reason;
  if (row.session_config) job.sessionConfig = row.session_config;
  return job;
}

/** `job_runs` row. */
interface JobRunRow {
  id: string;
  scheduled_at: Date;
  triggered_at: Date | null;
  session_id: string | null;
  manual: boolean;
  error: { type: JobRunError } | null;
  created_at: Date;
}

/** Build the wire `JobRun` resource from a db row. */
function toRun(row: JobRunRow): JobRun {
  const run: JobRun = {
    id: row.id,
    scheduledAt: iso(row.scheduled_at),
    manual: row.manual,
    createdAt: iso(row.created_at),
  };
  if (row.triggered_at) run.triggeredAt = iso(row.triggered_at);
  if (row.session_id) run.sessionId = row.session_id;
  if (row.error) run.error = row.error;
  return run;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Resolve the 3-form `agent` field to a pinned agent id + version (§6.3). */
function resolveAgentField(
  raw: SessionAgentField,
  tenantCtx: TenantCtx,
  pool: Pool,
): Promise<{ agentId: string; version: number }> {
  if (typeof raw === "string") {
    return resolveVersion(pool, tenantCtx, raw, undefined);
  }
  if ("version" in raw) {
    return resolveVersion(pool, tenantCtx, raw.id, raw.version);
  }
  // Overrides form — jobs do not persist per-session overrides (no column),
  // so reject with 422 rather than silently dropping them.
  throw new ApiError(
    422,
    "invalid_request",
    "job agent field does not support overrides; use a bare id or {id, version}",
  );
}

/** Resolve + validate the pinned agent version (404 absent, 422 archived). */
async function resolveVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  agentId: string,
  version: number | undefined,
): Promise<{ agentId: string; version: number }> {
  const agent = await getAgent(pool, tenantCtx, agentId);
  if (await isAgentArchived(pool, tenantCtx, agentId)) {
    throw new ApiError(422, "resource_archived", `agent is archived: ${agentId}`);
  }
  if (version !== undefined) {
    await getVersion(pool, tenantCtx, agentId, version);
    return { agentId, version };
  }
  return { agentId, version: agent.currentVersion };
}

/**
 * Create a job under `tenantCtx`. Validates the agent (not archived), the
 * environment (not archived), the cron + timezone, and the 1,000-job limit.
 * `initialEvents` must contain at least one `user.message` event (§17.1).
 */
export async function createJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: unknown,
): Promise<Job> {
  const parsed = JobCreate.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid job create: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;

  // initialEvents must include a user.message (§17.1).
  const hasMessage = data.initialEvents.some((e) => e.type === "user.message");
  if (!hasMessage) {
    throw new ApiError(
      422,
      "invalid_request",
      "initialEvents must contain at least one user.message event (§17.1)",
    );
  }

  // Cron + tz validation (throws → 422).
  try {
    validateSchedule(data.schedule.cron, data.schedule.tz);
  } catch (e) {
    throw new ApiError(422, "invalid_request", (e as Error).message);
  }

  // Agent (404 absent, 422 archived) + version pin.
  const { agentId, version: agentVersion } = await resolveAgentField(
    data.agent,
    tenantCtx,
    pool,
  );

  // Environment (404 absent, 422 archived).
  const env = await getEnvironment(pool, tenantCtx, data.environmentId);
  if (!env) {
    throw new ApiError(404, "not_found", `environment not found: ${data.environmentId}`);
  }
  if (env.status === "archived") {
    throw new ApiError(422, "resource_archived", `environment is archived: ${data.environmentId}`);
  }

  // Per-tenant job limit (§17.3, §27.3). Enforced transactionally via the
  // quota counter (R5.2): reserve one slot atomically (429 if over the plan
  // limit — enterprise tops out at MAX_JOBS_PER_TENANT), then insert. The racy
  // pre-flight COUNT let N concurrent creates all pass; the counter's row lock
  // admits exactly `limit`. Archived jobs release their slot (see archiveJob).
  await reserveQuota(pool, tenantCtx, "maxJobs");

  const id = newId("job_");
  const sessionConfig = data.sessionConfig ?? {};
  let inserted: JobRow[];
  try {
    ({ rows: inserted } = await tenantScopedQuery<JobRow>(
      pool,
      tenantCtx,
      `INSERT INTO jobs
         (tenant_id, id, name, agent_id, agent_version, environment_id,
          initial_events, session_config, schedule_cron, schedule_tz, one_shot,
          status, paused_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11,
               'active', NULL)
       RETURNING *`,
      [
        tenantCtx.tenantId,
        id,
        data.name,
        agentId,
        agentVersion,
        data.environmentId,
        JSON.stringify(data.initialEvents),
        JSON.stringify(sessionConfig),
        data.schedule.cron,
        data.schedule.tz,
        data.oneShot ?? false,
      ],
    ));
  } catch (err) {
    await releaseQuota(pool, tenantCtx, "maxJobs").catch(() => {});
    throw err;
  }
  return toJob(inserted[0]);
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export interface ListJobsOptions {
  limit: number;
  cursor?: string;
  status?: JobStatus;
}

function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid job list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/** List jobs for `tenantCtx`, newest first, cursor-paginated. */
export async function listJobs(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListJobsOptions,
): Promise<{ data: Job[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantCtx.tenantId];
  const where: string[] = ["status <> 'archived'"];
  let n = 1;
  if (opts.status) {
    where.push(`status = $${++n}`);
    params.push(opts.status);
  }
  if (opts.cursor) {
    const { createdAt, id } = decodeListCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `SELECT * FROM jobs
      WHERE tenant_id = $1 AND ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(
          JSON.stringify({
            createdAt: iso(page[page.length - 1].created_at),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toJob), nextCursor };
}

/** Fetch a job as the wire resource; `null` if absent / cross-tenant / archived. */
export async function getJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Job | null> {
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  const row = rows[0];
  if (!row || row.status === "archived") return null;
  return toJob(row);
}

/** Fetch a raw job row (internal — used by the tick loop). */
export async function fetchJobRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<JobRow | null> {
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle: pause / unpause / archive
// ---------------------------------------------------------------------------

/**
 * Pause a job (§17.5). Sets `pausedReason: {type: "manual"}`. Suppresses
 * scheduled triggers; running sessions continue; manual `run` still allowed.
 * Idempotent on an already-(manually)-paused job. `409` if archived.
 */
export async function pauseJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Job> {
  const existing = await fetchJobRow(pool, tenantCtx, id);
  if (!existing || existing.status === "archived") {
    throw new ApiError(404, "not_found", `job not found: ${id}`);
  }
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `UPDATE jobs
        SET status = 'paused', paused_reason = $3::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
      RETURNING *`,
    [tenantCtx.tenantId, id, JSON.stringify({ type: "manual" })],
  );
  return toJob(rows[0]);
}

/**
 * Resume a job (§17.5). Missed triggers are NOT backfilled. Idempotent on an
 * already-active job. `404` if absent; `409` if archived (terminal).
 */
export async function unpauseJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Job> {
  const existing = await fetchJobRow(pool, tenantCtx, id);
  if (!existing) {
    throw new ApiError(404, "not_found", `job not found: ${id}`);
  }
  if (existing.status === "archived") {
    throw new ApiError(409, "conflict", `archived jobs are immutable: ${id}`);
  }
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `UPDATE jobs
        SET status = 'active', paused_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'paused'
      RETURNING *`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ? toJob(rows[0]) : toJob(existing);
}

/**
 * Archive a job (terminal, immutable, §17.5). If the job's agent has been
 * archived, the job is auto-archived in the same operation and no run is
 * recorded. Idempotent on an already-archived job.
 */
export async function archiveJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Job> {
  const existing = await fetchJobRow(pool, tenantCtx, id);
  if (!existing) {
    throw new ApiError(404, "not_found", `job not found: ${id}`);
  }
  if (existing.status === "archived") {
    return toJob(existing);
  }
  const { rows } = await tenantScopedQuery<JobRow>(
    pool,
    tenantCtx,
    `UPDATE jobs
        SET status = 'archived', paused_reason = NULL, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'
      RETURNING *`,
    [tenantCtx.tenantId, id],
  );
  // Archiving a live job frees its quota slot (R5.2 counter decrement). Only
  // release when this call performed the transition (rows[0] present), not when
  // a concurrent archive won the race.
  if (rows[0]) {
    await releaseQuota(pool, tenantCtx, "maxJobs").catch(() => {});
  }
  return toJob(rows[0]);
}

// ---------------------------------------------------------------------------
// Manual run (§17.7) + list runs
// ---------------------------------------------------------------------------

/**
 * Manually trigger a job run (§17.7). Works while paused (and active). Creates
 * a run row marked `manual=true`, then runs the shared execution path. Returns
 * `{runId, sessionId?}` — `sessionId` is absent when the run failed (the run
 * row carries the `error`). `404` if absent; `409` if archived.
 */
export async function runJob(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  triggerSession?: TriggerSessionFn,
): Promise<{ runId: string; sessionId?: string }> {
  const job = await fetchJobRow(pool, tenantCtx, id);
  if (!job || job.status === "archived") {
    throw new ApiError(404, "not_found", `job not found: ${id}`);
  }
  const now = new Date();
  const runId = newId("jr_");
  // Manual runs use the trigger time as scheduled_at (no cron occurrence). The
  // exactly-once unique key is (job_id, scheduled_at); manual runs pass a
  // fresh timestamp so concurrent manual triggers do not collide.
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `INSERT INTO job_runs (tenant_id, id, job_id, scheduled_at, triggered_at, manual)
     VALUES ($1, $2, $3, $4, $4, true)`,
    [tenantCtx.tenantId, runId, id, now],
  );
  const outcome = await executeJobRun(
    pool,
    tenantCtx,
    job,
    runId,
    true,
    triggerSession,
  );
  return outcome.ok
    ? { runId, sessionId: outcome.sessionId }
    : { runId };
}

/** List runs for a job, newest-first, cursor-paginated. */
export async function listRuns(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  opts: { limit: number; cursor?: string },
): Promise<{ data: JobRun[]; nextCursor: string | null }> {
  // Confirm the job exists + is visible to the tenant (404 otherwise).
  const job = await fetchJobRow(pool, tenantCtx, id);
  if (!job || job.status === "archived") {
    throw new ApiError(404, "not_found", `job not found: ${id}`);
  }
  const params: unknown[] = [tenantCtx.tenantId, id];
  const where: string[] = ["tenant_id = $1", "job_id = $2"];
  let n = 2;
  if (opts.cursor) {
    const json = Buffer.from(opts.cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { scheduledAt?: string; id?: string };
    if (!parsed.scheduledAt || !parsed.id) {
      throw new ApiError(400, "invalid_request", "invalid job runs cursor");
    }
    where.push(`(scheduled_at, id) < ($${++n}, $${++n})`);
    params.push(parsed.scheduledAt, parsed.id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<JobRunRow>(
    pool,
    tenantCtx,
    `SELECT * FROM job_runs
      WHERE ${where.join(" AND ")}
      ORDER BY scheduled_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(
          JSON.stringify({
            scheduledAt: iso(page[page.length - 1].scheduled_at),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toRun), nextCursor };
}
