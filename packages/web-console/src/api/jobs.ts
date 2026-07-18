/**
 * `/v1/jobs` family — fetchers + hooks for the jobs surface (WP-C2.4 reads +
 * manual trigger; WP-C3.5 lifecycle; console-spec §9.4, journeys W7).
 *
 * Mirrors `contracts/src/job.ts`. Reads: list (cursor-paginated, `?status=`
 * filter), detail, runs history. Writes: the manual trigger
 * (`POST /v1/jobs/:id/run`, write scope; api-reference: works while paused,
 * `202 {runId, sessionId?}`) and the §9.4 lifecycle ops — create, pause,
 * unpause, archive (terminal; api-reference §"Scheduled Jobs"). The console
 * gates lifecycle UI at `admin` per console-spec §9.4; the backend remains
 * the sole enforcer (§6.4).
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Cursor,
  Job,
  JobRun,
  JobRunTriggerResponse,
  type JobCreate,
  type JobStatus,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { jobKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

const JobPage = Cursor(Job);
const JobRunPage = Cursor(JobRun);

/** Filters for `GET /v1/jobs` (backend `jobs.ts`: `?status=` + pagination). */
export interface JobListFilters {
  limit?: number;
  status?: JobStatus;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/jobs` — one page of the cursor-paginated list. */
export function listJobs(
  params: JobListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<Job>> {
  return client.get(withQuery("/v1/jobs", { ...params }), JobPage);
}

/** `GET /v1/jobs/:id` — retrieve. */
export function getJob(id: string, client: ConsoleApi = apiClient): Promise<Job> {
  return client.get(`/v1/jobs/${encodeURIComponent(id)}`, Job);
}

/** `GET /v1/jobs/:id/runs` — runs history, newest first, cursor-paginated. */
export function listJobRuns(
  id: string,
  params: { limit?: number; cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<JobRun>> {
  return client.get(
    withQuery(`/v1/jobs/${encodeURIComponent(id)}/runs`, { ...params }),
    JobRunPage,
  );
}

/** `POST /v1/jobs/:id/run` — manual trigger (write scope; works while paused). */
export function triggerJobRun(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<JobRunTriggerResponse> {
  // Empty JSON body: the fetch wrapper auto-generates the required
  // Idempotency-Key for POSTs that carry a body (api-reference §"Scheduled
  // Jobs": `Idempotency-Key` required).
  return client.post(
    `/v1/jobs/${encodeURIComponent(id)}/run`,
    {},
    JobRunTriggerResponse,
  );
}

/**
 * `POST /v1/jobs` — create (§17.1: `initialEvents` must carry a
 * `user.message`; the server validates the schedule, §17.2 — client-side
 * checks in `features/jobs/schedule.ts` are instant feedback only).
 */
export function createJob(
  body: JobCreate,
  client: ConsoleApi = apiClient,
): Promise<Job> {
  return client.post("/v1/jobs", body, Job);
}

/** `POST /v1/jobs/:id/pause` — suppress scheduled triggers (§17.5). */
export function pauseJob(id: string, client: ConsoleApi = apiClient): Promise<Job> {
  return client.post(`/v1/jobs/${encodeURIComponent(id)}/pause`, {}, Job);
}

/** `POST /v1/jobs/:id/unpause` — resume; missed triggers NOT backfilled. */
export function unpauseJob(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Job> {
  return client.post(`/v1/jobs/${encodeURIComponent(id)}/unpause`, {}, Job);
}

/**
 * `POST /v1/jobs/:id/archive` — terminal: the schedule stops and the job
 * disappears from every read (the backend excludes archived rows from the
 * list and 404s detail/runs — `job-service.ts` §17.5). The archived job is
 * returned one last time in this response.
 */
export function archiveJob(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Job> {
  return client.post(`/v1/jobs/${encodeURIComponent(id)}/archive`, {}, Job);
}

// --- Query options + hooks ----------------------------------------------------

export function jobsInfiniteOptions(
  filters: JobListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: jobKeys.list(filters),
    queryFn: ({ pageParam }) => listJobs({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated jobs list (C§9.4). */
export function useJobs(filters: JobListFilters = {}) {
  return useInfiniteQuery(jobsInfiniteOptions(filters, useApiClient()));
}

export function jobOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: jobKeys.detail(id),
    queryFn: () => getJob(id, client),
  });
}

export function useJob(id: string) {
  return useQuery(jobOptions(id, useApiClient()));
}

export function jobRunsInfiniteOptions(
  id: string,
  params: { limit?: number } = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: jobKeys.runs(id, params),
    queryFn: ({ pageParam }) =>
      listJobRuns(id, { ...params, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Runs history for one job (W7: per-run session links). */
export function useJobRuns(id: string, params?: { limit?: number }) {
  return useInfiniteQuery(jobRunsInfiniteOptions(id, params, useApiClient()));
}

export function jobLastRunOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: jobKeys.runs(id, { limit: 1 }),
    queryFn: () => listJobRuns(id, { limit: 1 }, client),
    select: (page: Cursor<JobRun>) => page.data[0] ?? null,
  });
}

/** The newest run only — the list's last-run-outcome column (DP-1). */
export function useJobLastRun(id: string) {
  return useQuery(jobLastRunOptions(id, useApiClient()));
}

/**
 * Manual trigger (W7). On success the job's detail subtree — which includes
 * every runs page — is invalidated so the new run shows up.
 */
export function useTriggerJobRun(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerJobRun(id, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: jobKeys.detail(id) }),
  });
}

/** Create (admin UI gate, §9.4). Invalidates the list queries on success. */
export function useCreateJob() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: JobCreate) => createJob(body, client),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKeys.detail(job.id), job);
      void queryClient.invalidateQueries({ queryKey: jobKeys.lists() });
    },
  });
}

/** Pause (§17.5) — sets `pausedReason: {type: "manual"}`. */
export function usePauseJob(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pauseJob(id, client),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKeys.detail(id), job);
      void queryClient.invalidateQueries({ queryKey: jobKeys.lists() });
    },
  });
}

/** Unpause (§17.5) — missed occurrences are not backfilled. */
export function useUnpauseJob(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unpauseJob(id, client),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKeys.detail(id), job);
      void queryClient.invalidateQueries({ queryKey: jobKeys.lists() });
    },
  });
}

/**
 * Archive (terminal — DP-7 dialog is the caller's job). The job vanishes
 * from all reads afterwards, so the detail subtree is dropped, not patched
 * (same as `useDeleteEnvironment`).
 */
export function useArchiveJob(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => archiveJob(id, client),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: jobKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: jobKeys.lists() });
    },
  });
}
