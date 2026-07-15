/**
 * Job run execution + failure taxonomy (WP-2.1, §17.4 / §17.6).
 *
 * {@link executeJobRun} is the shared run path used by both the scheduled tick
 * loop (§17.8) and the manual `POST /v1/jobs/:id/run` trigger (§17.7). It:
 *  1. Pre-checks the job's agent / environment / vaults — mapping failures to
 *     the §17.4 error taxonomy (`agent_archived`, `environment_archived`,
 *     `vault_not_found`).
 *  2. Creates a session via the session service (`createSession`), mapping a
 *     rate-limit / quota breach to `session_rate_limited` and any other error
 *     to `service_unavailable`.
 *  3. Records `session_id` on success, or `error.type` on failure.
 *  4. On a scheduled (non-manual) failure of an auto-pause-eligible type, pauses
 *     the job with `pausedReason.error.type` mirroring the run's `error.type`
 *     (§17.6). `session_rate_limited` is recorded but NOT retried and NOT
 *     auto-paused — the schedule tries again at the next occurrence (§17.6).
 *
 * The run row must already exist (claimed via the exactly-once insert or
 * created by the manual-run path); this function only updates `session_id` /
 * `error` on it.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { type JobRunError } from "@pi-managed/contracts";
import { isAgentArchived } from "../agent/agent.js";
import { getEnvironment } from "../environment/environment.js";
import { getVault } from "../vault/vault.js";
import { createSession } from "../session/index.js";
import type { JobRow } from "./job-service.js";
import type { WebhookEventSource } from "../webhook/event-source.js";

/** Errors whose scheduled occurrence auto-pauses the job (§17.6). */
const AUTO_PAUSE_ERRORS: ReadonlySet<JobRunError> = new Set([
  "agent_archived",
  "environment_archived",
  "vault_not_found",
]);

/**
 * Hook to dispatch a job's `initialEvents` into the freshly-created session as
 * `user.message` events. The tick loop / manual-run path inject this; the
 * scheduler core never touches the SessionRuntime directly (it lives in the
 * session manager / app composition layer). When omitted, the session is
 * created idle and `session_id` is still recorded.
 */
export type TriggerSessionFn = (
  ctx: TenantCtx,
  sessionId: string,
  initialEvents: unknown[],
) => Promise<void>;

/** Outcome of a run attempt: either a session id (success) or an error type. */
export type RunOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; error: JobRunError };

/** The shared run path — see module doc. Returns the session id and/or error. */
export async function executeJobRun(
  pool: Pool,
  ctx: TenantCtx,
  job: JobRow,
  runId: string,
  manual: boolean,
  triggerSession?: TriggerSessionFn,
  eventSource?: WebhookEventSource,
): Promise<RunOutcome> {
  const outcome = await tryExecute(pool, ctx, job, triggerSession);

  if (outcome.ok) {
    await recordSessionId(pool, ctx, runId, outcome.sessionId);
    // §23.1: fan out the run-succeeded lifecycle event to the tenant's webhooks.
    await eventSource?.emit(ctx.tenantId, "job.run_succeeded");
    return outcome;
  }

  await recordRunError(pool, ctx, runId, outcome.error);
  if (!manual && AUTO_PAUSE_ERRORS.has(outcome.error)) {
    await autoPause(pool, ctx, job.id, outcome.error);
    await eventSource?.emit(ctx.tenantId, "job.paused");
  }
  await eventSource?.emit(ctx.tenantId, "job.run_failed");
  return outcome;
}

/** Attempt the run. Returns the session id on success or an error type. */
async function tryExecute(
  pool: Pool,
  ctx: TenantCtx,
  job: JobRow,
  triggerSession?: TriggerSessionFn,
): Promise<RunOutcome> {
  // --- Pre-checks → §17.4 taxonomy -----------------------------------------
  try {
    if (await isAgentArchived(pool, ctx, job.agent_id)) {
      return { ok: false, error: "agent_archived" };
    }
    const env = await getEnvironment(pool, ctx, job.environment_id);
    if (!env || env.status === "archived") {
      return { ok: false, error: "environment_archived" };
    }
    const vaultIds = job.session_config?.vaultIds ?? [];
    for (const vid of vaultIds) {
      try {
        const v = await getVault(pool, ctx, vid);
        if (v.status === "archived") return { ok: false, error: "vault_not_found" };
      } catch {
        return { ok: false, error: "vault_not_found" };
      }
    }
  } catch {
    return { ok: false, error: "service_unavailable" };
  }

  // --- Create the session (idle) -------------------------------------------
  let sessionId: string;
  try {
    const session = await createSession(pool, ctx, {
      agent: { id: job.agent_id, version: job.agent_version },
      environmentId: job.environment_id,
      resources: job.session_config?.resources,
      vaultIds: job.session_config?.vaultIds,
      budget: job.session_config?.budget,
    });
    sessionId = session.id;
  } catch (err) {
    return { ok: false, error: mapCreateError(err) };
  }

  // --- Dispatch initialEvents (optional) -----------------------------------
  if (triggerSession && Array.isArray(job.initial_events) && job.initial_events.length) {
    try {
      await triggerSession(ctx, sessionId, job.initial_events);
    } catch {
      // Event dispatch failure does not fail the run — the session exists and
      // `session_id` is recorded. The dispatch layer owns its own retries.
    }
  }

  return { ok: true, sessionId };
}

/** Map a thrown error from `createSession` to the run-error taxonomy (§17.4). */
function mapCreateError(err: unknown): JobRunError {
  if (err instanceof ApiError) {
    if (err.code === "resource_archived") {
      // `createSession` throws `resource_archived` for an archived agent OR
      // environment. Disambiguate via the message; default to agent_archived.
      return err.message.includes("environment")
        ? "environment_archived"
        : "agent_archived";
    }
    if (err.code === "rate_limited") return "session_rate_limited";
    if (err.code === "not_found") return "vault_not_found";
  }
  return "service_unavailable";
}

/** Write `session_id` onto a run row (success path). */
async function recordSessionId(
  pool: Pool,
  ctx: TenantCtx,
  runId: string,
  sessionId: string,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    ctx,
    `UPDATE job_runs SET session_id = $3, triggered_at = COALESCE(triggered_at, now())
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, runId, sessionId],
  );
}

/** Write `error` onto a run row (failure path). */
async function recordRunError(
  pool: Pool,
  ctx: TenantCtx,
  runId: string,
  type: JobRunError,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    ctx,
    `UPDATE job_runs SET error = $3::jsonb, triggered_at = COALESCE(triggered_at, now())
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, runId, JSON.stringify({ type })],
  );
}

/**
 * Auto-pause a job with `pausedReason.error.type` mirroring the run error
 * (§17.6). Only transitions `active` → `paused`; an already-paused or archived
 * job is left as-is (the run error is still recorded on the run row).
 */
export async function autoPause(
  pool: Pool,
  ctx: TenantCtx,
  jobId: string,
  type: JobRunError,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    ctx,
    `UPDATE jobs
        SET status = 'paused',
            paused_reason = $3::jsonb,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [ctx.tenantId, jobId, JSON.stringify({ type: "error", error: { type } })],
  );
}
