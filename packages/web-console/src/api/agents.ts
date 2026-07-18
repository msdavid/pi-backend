/**
 * `/v1/agents` family — fetchers + hooks (WP-C3-prep skeleton, consumed by
 * the WP-C3.1 agents management surface in `src/features/agents/` —
 * console-spec §9.1, journeys W10/W16).
 *
 * Mirrors `contracts/src/agent.ts` and api-reference §"Agents". Reads: list
 * (cursor-paginated, `?name=` filter), detail (current-version config
 * expanded), version history (cursor-paginated), one version. Writes (admin
 * scope): create, PATCH (creates a new immutable version — the UI MUST say
 * so, §9.1), archive (terminal; referencing jobs are auto-archived in the
 * same operation — name it in the DP-7 dialog).
 *
 * The API also accepts `?metadata.<key>=` list filters (api-reference); not
 * modeled here — WP-C3.1 can add a metadata filter if its screens need one.
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
  Agent,
  AgentVersion,
  Cursor,
  type AgentCreate,
  type AgentUpdate,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { agentKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

const AgentPage = Cursor(Agent);
const AgentVersionPage = Cursor(AgentVersion);

/** Filters for `GET /v1/agents` (api-reference: `?name=` + pagination). */
export interface AgentListFilters {
  limit?: number;
  name?: string;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/agents` — one page of the cursor-paginated list. */
export function listAgents(
  params: AgentListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<Agent>> {
  return client.get(withQuery("/v1/agents", { ...params }), AgentPage);
}

/** `GET /v1/agents/:id` — retrieve (current-version config expanded). */
export function getAgent(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Agent> {
  return client.get(`/v1/agents/${encodeURIComponent(id)}`, Agent);
}

/** `GET /v1/agents/:id/versions` — version history, newest first. */
export function listAgentVersions(
  id: string,
  params: { limit?: number; cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<AgentVersion>> {
  return client.get(
    withQuery(`/v1/agents/${encodeURIComponent(id)}/versions`, { ...params }),
    AgentVersionPage,
  );
}

/** `GET /v1/agents/:id/versions/:ver` — one version's config blob. */
export function getAgentVersion(
  id: string,
  version: number,
  client: ConsoleApi = apiClient,
): Promise<AgentVersion> {
  return client.get(
    `/v1/agents/${encodeURIComponent(id)}/versions/${version}`,
    AgentVersion,
  );
}

/** `POST /v1/agents` — create (admin; the wrapper adds the Idempotency-Key). */
export function createAgent(
  body: AgentCreate,
  client: ConsoleApi = apiClient,
): Promise<Agent> {
  return client.post("/v1/agents", body, Agent);
}

/** `PATCH /v1/agents/:id` — update; creates a NEW immutable version (§9.1). */
export function updateAgent(
  id: string,
  body: AgentUpdate,
  client: ConsoleApi = apiClient,
): Promise<Agent> {
  return client.patch(`/v1/agents/${encodeURIComponent(id)}`, body, Agent);
}

/** `POST /v1/agents/:id/archive` — terminal; auto-archives referencing jobs. */
export function archiveAgent(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Agent> {
  return client.post(`/v1/agents/${encodeURIComponent(id)}/archive`, {}, Agent);
}

// --- Query options + hooks ----------------------------------------------------

export function agentsInfiniteOptions(
  filters: AgentListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: agentKeys.list(filters),
    queryFn: ({ pageParam }) =>
      listAgents({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated agents list (C§9.1). */
export function useAgents(filters: AgentListFilters = {}) {
  return useInfiniteQuery(agentsInfiniteOptions(filters, useApiClient()));
}

export function agentOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: agentKeys.detail(id),
    queryFn: () => getAgent(id, client),
  });
}

export function useAgent(id: string) {
  return useQuery(agentOptions(id, useApiClient()));
}

export function agentVersionsInfiniteOptions(
  id: string,
  params: { limit?: number } = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: agentKeys.versions(id, params),
    queryFn: ({ pageParam }) =>
      listAgentVersions(id, { ...params, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Version history for one agent (C§9.1 detail). */
export function useAgentVersions(id: string, params?: { limit?: number }) {
  return useInfiniteQuery(
    agentVersionsInfiniteOptions(id, params, useApiClient()),
  );
}

export function agentVersionOptions(
  id: string,
  version: number,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: agentKeys.version(id, version),
    queryFn: () => getAgentVersion(id, version, client),
  });
}

/** One version's config — fetched when the user opens it (DP-2). */
export function useAgentVersion(id: string, version: number) {
  return useQuery(agentVersionOptions(id, version, useApiClient()));
}

/** Create (admin). Invalidates the list queries on success. */
export function useCreateAgent() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentCreate) => createAgent(body, client),
    onSuccess: (agent) => {
      queryClient.setQueryData(agentKeys.detail(agent.id), agent);
      void queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

/**
 * PATCH (admin) — creates a new immutable version, so on success the detail
 * subtree (versions included) and the lists are refreshed.
 */
export function useUpdateAgent(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AgentUpdate) => updateAgent(id, body, client),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}

/** Archive (admin; terminal — DP-7 dialog is the caller's job). */
export function useArchiveAgent(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => archiveAgent(id, client),
    onSuccess: (agent) => {
      queryClient.setQueryData(agentKeys.detail(id), agent);
      void queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
    },
  });
}
