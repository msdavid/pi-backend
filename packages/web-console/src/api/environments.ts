/**
 * `/v1/environments` family — fetchers + hooks (WP-C3-prep skeleton; the
 * environments management surface, console-spec §9.2 / journey W12, is
 * WP-C3.2).
 *
 * Mirrors `contracts/src/environment.ts` and api-reference §"Environments" +
 * §"Self-hosted work queue". Reads: list (cursor-paginated, `?status=`),
 * detail, `work-stats` (self-hosted queue depth). Writes (admin scope):
 * create, PATCH (not versioned — later sessions pick up the new config),
 * archive, DELETE (hard), worker-key mint, `work-stop` (drain; `force: true`
 * is the explicit second step, §9.2).
 *
 * Endpoints the API does NOT have (verified against api-reference + backend
 * routes — do not invent them):
 *  - no worker-keys LIST route: worker keys are ordinary `api_keys` rows with
 *    the `self_hosted_worker:<envId>` scope marker, so WP-C3.2 lists them by
 *    filtering `GET /v1/api-keys` (see `./api-keys.js` `workerKeyScopeOf`);
 *  - `work-claim` / `work-result` are worker-key-only routes — never called
 *    by the console.
 *
 * The worker-key mint and work-stop responses have no contracts schema yet;
 * they are validated with hand-rolled structural schemas below (same
 * precedent as `SessionOutputsListSchema` in `./sessions.ts`) — replace with
 * contracts schemas once they land (contracts is the synchronization
 * artifact, plan rule 2).
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
  Environment,
  WorkStats,
  type EnvironmentCreate,
  type EnvironmentUpdate,
  type ResourceStatus,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { apiKeyKeys, environmentKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

const EnvironmentPage = Cursor(Environment);

/** Filters for `GET /v1/environments` (`?status=` + pagination). */
export interface EnvironmentListFilters {
  limit?: number;
  status?: ResourceStatus;
}

/**
 * A freshly minted worker key (`POST /v1/environments/:id/worker-keys`,
 * backend `domain/self-hosted/worker-keys.ts` `IssuedWorkerKey`). The raw
 * `key` is shown ONCE — never returned again (§T5 in W12: render once,
 * copy-and-confirm, never store).
 */
export interface IssuedWorkerKey {
  id: string;
  name: string;
  key: string;
  environmentId: string;
  createdAt: string;
}

const IssuedWorkerKeySchema: ResponseSchema<IssuedWorkerKey> = {
  parse(input: unknown): IssuedWorkerKey {
    const v = input as Partial<IssuedWorkerKey> | null;
    if (
      !v ||
      typeof v.id !== "string" ||
      typeof v.name !== "string" ||
      typeof v.key !== "string" ||
      typeof v.environmentId !== "string" ||
      typeof v.createdAt !== "string"
    ) {
      throw new Error("worker key: unexpected response shape");
    }
    return {
      id: v.id,
      name: v.name,
      key: v.key,
      environmentId: v.environmentId,
      createdAt: v.createdAt,
    };
  },
};

/**
 * The stopped work item (`POST /v1/environments/:id/work-stop`, backend
 * `domain/self-hosted/work-queue.ts` `WorkItem` — the console renders only
 * this slice).
 */
export interface WorkStopResult {
  id: string;
  sessionId: string;
  status: string;
  stopRequested: "clean" | "force" | null;
}

const WorkStopResultSchema: ResponseSchema<WorkStopResult> = {
  parse(input: unknown): WorkStopResult {
    const v = input as Partial<WorkStopResult> | null;
    if (
      !v ||
      typeof v.id !== "string" ||
      typeof v.sessionId !== "string" ||
      typeof v.status !== "string"
    ) {
      throw new Error("work-stop: unexpected response shape");
    }
    return {
      id: v.id,
      sessionId: v.sessionId,
      status: v.status,
      stopRequested:
        v.stopRequested === "clean" || v.stopRequested === "force"
          ? v.stopRequested
          : null,
    };
  },
};

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/environments` — one page of the cursor-paginated list. */
export function listEnvironments(
  params: EnvironmentListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<Environment>> {
  return client.get(withQuery("/v1/environments", { ...params }), EnvironmentPage);
}

/** `GET /v1/environments/:id` — retrieve. */
export function getEnvironment(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Environment> {
  return client.get(`/v1/environments/${encodeURIComponent(id)}`, Environment);
}

/** `GET /v1/environments/:id/work-stats` — self-hosted queue depth (§10.4). */
export function getWorkStats(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<WorkStats> {
  return client.get(
    `/v1/environments/${encodeURIComponent(id)}/work-stats`,
    WorkStats,
  );
}

/** `POST /v1/environments` — create (admin). */
export function createEnvironment(
  body: EnvironmentCreate,
  client: ConsoleApi = apiClient,
): Promise<Environment> {
  return client.post("/v1/environments", body, Environment);
}

/** `PATCH /v1/environments/:id` — update (not versioned). */
export function updateEnvironment(
  id: string,
  body: EnvironmentUpdate,
  client: ConsoleApi = apiClient,
): Promise<Environment> {
  return client.patch(
    `/v1/environments/${encodeURIComponent(id)}`,
    body,
    Environment,
  );
}

/** `POST /v1/environments/:id/archive` — no new sessions may reference it. */
export function archiveEnvironment(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Environment> {
  return client.post(
    `/v1/environments/${encodeURIComponent(id)}/archive`,
    {},
    Environment,
  );
}

/** `DELETE /v1/environments/:id` — hard delete (running sessions continue). */
export function deleteEnvironment(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/environments/${encodeURIComponent(id)}`);
}

/** `POST /v1/environments/:id/worker-keys` — mint (secret shown once, W12). */
export function mintWorkerKey(
  id: string,
  body: { name: string },
  client: ConsoleApi = apiClient,
): Promise<IssuedWorkerKey> {
  return client.post(
    `/v1/environments/${encodeURIComponent(id)}/worker-keys`,
    body,
    IssuedWorkerKeySchema,
  );
}

/**
 * `POST /v1/environments/:id/work-stop` — ask the worker handling
 * `sessionId` to stop; `force: true` interrupts immediately (the explicit
 * second step of the §9.2 drain flow).
 */
export function stopWork(
  id: string,
  body: { sessionId: string; force?: boolean },
  client: ConsoleApi = apiClient,
): Promise<WorkStopResult> {
  return client.post(
    `/v1/environments/${encodeURIComponent(id)}/work-stop`,
    body,
    WorkStopResultSchema,
  );
}

// --- Query options + hooks ----------------------------------------------------

export function environmentsInfiniteOptions(
  filters: EnvironmentListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: environmentKeys.list(filters),
    queryFn: ({ pageParam }) =>
      listEnvironments({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated environments list (C§9.2). */
export function useEnvironments(filters: EnvironmentListFilters = {}) {
  return useInfiniteQuery(environmentsInfiniteOptions(filters, useApiClient()));
}

export function environmentOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: environmentKeys.detail(id),
    queryFn: () => getEnvironment(id, client),
  });
}

export function useEnvironment(id: string) {
  return useQuery(environmentOptions(id, useApiClient()));
}

export function workStatsOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: environmentKeys.workStats(id),
    queryFn: () => getWorkStats(id, client),
  });
}

/**
 * Poll interval for {@link useWorkStats} (WP-C3.2). 10 s: §9.2 asks for LIVE
 * queue depth while the detail page is open; the cost is one aggregate read.
 * TanStack pauses interval refetching for backgrounded tabs by default
 * (`refetchIntervalInBackground: false`), so this polls only while visible.
 */
export const WORK_STATS_REFRESH_MS = 10_000;

/** Self-hosted queue depth / oldest-queued / workers-polling, polled live
 * while the page is visible (C§9.2). */
export function useWorkStats(id: string) {
  return useQuery({
    ...workStatsOptions(id, useApiClient()),
    refetchInterval: WORK_STATS_REFRESH_MS,
  });
}

/** Create (admin). Invalidates the list queries on success. */
export function useCreateEnvironment() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EnvironmentCreate) => createEnvironment(body, client),
    onSuccess: (env) => {
      queryClient.setQueryData(environmentKeys.detail(env.id), env);
      void queryClient.invalidateQueries({ queryKey: environmentKeys.lists() });
    },
  });
}

/** PATCH (admin; not versioned — later sessions use the new config). */
export function useUpdateEnvironment(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EnvironmentUpdate) =>
      updateEnvironment(id, body, client),
    onSuccess: (env) => {
      queryClient.setQueryData(environmentKeys.detail(id), env);
      void queryClient.invalidateQueries({ queryKey: environmentKeys.lists() });
    },
  });
}

/** Archive (admin). */
export function useArchiveEnvironment(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => archiveEnvironment(id, client),
    onSuccess: (env) => {
      queryClient.setQueryData(environmentKeys.detail(id), env);
      void queryClient.invalidateQueries({ queryKey: environmentKeys.lists() });
    },
  });
}

/** Hard delete (admin; DP-7 dialog is the caller's job). */
export function useDeleteEnvironment(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteEnvironment(id, client),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: environmentKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: environmentKeys.lists() });
    },
  });
}

/** Mint a worker key (admin). The raw key is in the RESULT only — render
 * once, never cache (the mutation state is dropped on unmount). The RECORD
 * (no key) lands in the `/v1/api-keys` list, so that query is refreshed. */
export function useMintWorkerKey(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => mintWorkerKey(id, body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.lists() }),
  });
}

/** Stop queued/claimed work (admin; W12 drain). */
export function useStopWork(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { sessionId: string; force?: boolean }) =>
      stopWork(id, body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: environmentKeys.workStats(id),
      }),
  });
}
