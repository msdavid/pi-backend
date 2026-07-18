/**
 * `/v1/jobs` family of the {@link FakeConsoleApi} (state lives on the main
 * class; this module holds the makers + route handling — see `wire.ts`).
 */
import type { Job, JobCreate, JobRun } from "@pi-managed/contracts";

import { notFound, pageOf } from "./wire.js";

/** A full wire-shaped job with overridable fields (contracts `Job`). */
export function makeJob(overrides: Partial<Job> & { id: string }): Job {
  return {
    name: "nightly-test-run",
    status: "active",
    agent: "agent_01TESTAGENT",
    environmentId: "env_01TESTENV",
    schedule: { cron: "0 7 * * 1-5", tz: "UTC" },
    oneShot: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A full wire-shaped job run with overridable fields (contracts `JobRun`). */
export function makeJobRun(
  overrides: Partial<JobRun> & { id: string },
): JobRun {
  return {
    scheduledAt: "2026-07-02T07:00:00.000Z",
    triggeredAt: "2026-07-02T07:00:05.000Z",
    sessionId: "sess_01RUNSESSION",
    manual: false,
    createdAt: "2026-07-02T07:00:05.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the jobs family reads/writes. */
export interface JobsState {
  jobs: Job[];
  jobRuns: Map<string, JobRun[]>;
  triggerSessionId: string;
  addJobRun(jobId: string, overrides: Partial<JobRun> & { id: string }): JobRun;
}

/**
 * `GET /v1/jobs*` — returns the wire body, or `undefined` if unmatched.
 * Archived jobs are invisible on every read, like the real backend
 * (`job-service.ts` §17.5: the list always excludes them, detail and runs
 * 404 — pinned by `jobs-lifecycle.contract.test.ts`).
 */
export function jobsGet(
  state: JobsState,
  pathname: string,
  params: URLSearchParams,
): unknown | undefined {
  if (pathname === "/v1/jobs") {
    const status = params.get("status");
    const matches = state.jobs.filter(
      (j) => j.status !== "archived" && (!status || j.status === status),
    );
    return pageOf(matches, params);
  }
  const match = pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(runs))?$/);
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]!);
  const found = state.jobs.find((j) => j.id === id);
  if (!found || found.status === "archived") throw notFound(id);
  if (match[2] === "runs") return pageOf(state.jobRuns.get(id) ?? [], params);
  return found;
}

/**
 * `POST /v1/jobs*` — create, lifecycle (pause/unpause/archive, WP-C3.5) and
 * the manual trigger; `undefined` if unmatched.
 */
export function jobsPost(
  state: JobsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  if (pathname === "/v1/jobs") {
    const create = body as JobCreate;
    const job = makeJob({
      id: `job_01TESTNEW${state.jobs.length + 1}`,
      name: create.name,
      agent: create.agent,
      environmentId: create.environmentId,
      schedule: create.schedule,
      oneShot: create.oneShot ?? false,
      ...(create.sessionConfig ? { sessionConfig: create.sessionConfig } : {}),
      ...(create.metadata ? { metadata: create.metadata } : {}),
    });
    state.jobs.push(job);
    return job;
  }
  const match = pathname.match(
    /^\/v1\/jobs\/([^/]+)\/(run|pause|unpause|archive)$/,
  );
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]!);
  const action = match[2]!;
  const job = state.jobs.find((j) => j.id === id);
  // The real API 404s missing jobs everywhere and archived jobs on run/pause;
  // the UI never reaches unpause/archive on an archived job (controls hidden),
  // so the fake folds those into 404 too.
  if (!job || (job.status === "archived" && action !== "archive")) {
    throw notFound(id);
  }
  if (action === "pause") {
    job.status = "paused";
    job.pausedReason = { type: "manual" };
    return job;
  }
  if (action === "unpause") {
    job.status = "active";
    delete job.pausedReason;
    return job;
  }
  if (action === "archive") {
    // Idempotent, like the backend (§17.5); pausedReason is cleared.
    job.status = "archived";
    delete job.pausedReason;
    return job;
  }
  const now = "2026-07-15T12:00:00.000Z";
  const record = state.addJobRun(id, {
    id: `jr_TEST${(state.jobRuns.get(id)?.length ?? 0) + 1}`,
    scheduledAt: now,
    triggeredAt: now,
    sessionId: state.triggerSessionId,
    manual: true,
    createdAt: now,
  });
  return { runId: record.id, sessionId: record.sessionId };
}
