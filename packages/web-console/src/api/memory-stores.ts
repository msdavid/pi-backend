/**
 * `/v1/memory-stores` family — fetchers + hooks for the read surface
 * (WP-C2.4; console-spec §9.5: list + detail + content viewing + version
 * history) plus the version-restore op (WP-C4.0b). Content is retained
 * server-side per version (a version record still carries only
 * `contentSha256` on the wire), so `POST …/versions/:v/restore` copies an
 * old version's content into a NEW head version without a client
 * round-trip (api-reference §"Memory stores"). The other mutations
 * (create/update/delete, version redact) are `write` surfaces not built
 * here yet.
 *
 * Mirrors `contracts/src/memory.ts`. The memory path is a path param
 * (`GET …/memories/:m`) — percent-encoded by the client when it contains `/`
 * (backend `memory-stores.ts` header). Versions belong to the store and
 * survive memory deletion; `?memoryPath=` narrows to one memory's history.
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
  Memory,
  MemorySummary,
  MemoryStore,
  MemoryVersion,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { memoryStoreKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

const MemoryStorePage = Cursor(MemoryStore);
const MemorySummaryPage = Cursor(MemorySummary);
const MemoryVersionPage = Cursor(MemoryVersion);

/** Filters for `GET /v1/memory-stores/:id/versions` (`?memoryPath=`). */
export interface MemoryVersionFilters {
  limit?: number;
  memoryPath?: string;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/memory-stores` — one page of the cursor-paginated list. */
export function listMemoryStores(
  params: { limit?: number; cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<MemoryStore>> {
  return client.get(withQuery("/v1/memory-stores", { ...params }), MemoryStorePage);
}

/** `GET /v1/memory-stores/:id` — retrieve. */
export function getMemoryStore(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<MemoryStore> {
  return client.get(`/v1/memory-stores/${encodeURIComponent(id)}`, MemoryStore);
}

/** `GET /v1/memory-stores/:id/memories` — list memories (no content). */
export function listMemories(
  id: string,
  params: { limit?: number; cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<MemorySummary>> {
  return client.get(
    withQuery(`/v1/memory-stores/${encodeURIComponent(id)}/memories`, {
      ...params,
    }),
    MemorySummaryPage,
  );
}

/** `GET /v1/memory-stores/:id/memories/:m` — retrieve one memory WITH content. */
export function getMemory(
  id: string,
  path: string,
  client: ConsoleApi = apiClient,
): Promise<Memory> {
  return client.get(
    `/v1/memory-stores/${encodeURIComponent(id)}/memories/${encodeURIComponent(path)}`,
    Memory,
  );
}

/** `GET /v1/memory-stores/:id/versions` — version audit trail, newest first. */
export function listMemoryVersions(
  id: string,
  params: MemoryVersionFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<MemoryVersion>> {
  return client.get(
    withQuery(`/v1/memory-stores/${encodeURIComponent(id)}/versions`, {
      ...params,
    }),
    MemoryVersionPage,
  );
}

/** `GET /v1/memory-stores/:id/versions/:v` — retrieve a version (audit fields). */
export function getMemoryVersion(
  id: string,
  versionId: string,
  client: ConsoleApi = apiClient,
): Promise<MemoryVersion> {
  return client.get(
    `/v1/memory-stores/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
    MemoryVersion,
  );
}

/** `POST /v1/memory-stores/:id/versions/:v/restore` — restore (`write`,
 * WP-C4.0): copies the version's content server-side into a NEW version for
 * the same `memoryPath`, which becomes the live head (`201`; an undelete
 * when the path was deleted). Empty body; the client auto-generates the
 * required `Idempotency-Key`. `409 conflict` when the source content is
 * gone (redacted, or a deletion tombstone). */
export function restoreMemoryVersion(
  id: string,
  versionId: string,
  client: ConsoleApi = apiClient,
): Promise<MemoryVersion> {
  return client.post(
    `/v1/memory-stores/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
    {},
    MemoryVersion,
  );
}

// --- Query options + hooks ----------------------------------------------------

export function memoryStoresInfiniteOptions(
  params: { limit?: number } = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: memoryStoreKeys.list(params),
    queryFn: ({ pageParam }) =>
      listMemoryStores({ ...params, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated memory-stores list (C§9.5). */
export function useMemoryStores(params: { limit?: number } = {}) {
  return useInfiniteQuery(memoryStoresInfiniteOptions(params, useApiClient()));
}

export function memoryStoreOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: memoryStoreKeys.detail(id),
    queryFn: () => getMemoryStore(id, client),
  });
}

export function useMemoryStore(id: string) {
  return useQuery(memoryStoreOptions(id, useApiClient()));
}

export function memoriesInfiniteOptions(
  id: string,
  params: { limit?: number } = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: memoryStoreKeys.memories(id, params),
    queryFn: ({ pageParam }) =>
      listMemories(id, { ...params, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

export function useMemories(id: string, params?: { limit?: number }) {
  return useInfiniteQuery(memoriesInfiniteOptions(id, params, useApiClient()));
}

export function memoryOptions(
  id: string,
  path: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: memoryStoreKeys.memory(id, path),
    queryFn: () => getMemory(id, path, client),
  });
}

/** One memory's content — fetched only when the user opens it (DP-2). */
export function useMemory(id: string, path: string) {
  return useQuery(memoryOptions(id, path, useApiClient()));
}

export function memoryVersionsInfiniteOptions(
  id: string,
  filters: MemoryVersionFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: memoryStoreKeys.versions(id, filters),
    queryFn: ({ pageParam }) =>
      listMemoryVersions(id, { ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

export function useMemoryVersions(id: string, filters?: MemoryVersionFilters) {
  return useInfiniteQuery(
    memoryVersionsInfiniteOptions(id, filters, useApiClient()),
  );
}

export function memoryVersionOptions(
  id: string,
  versionId: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: memoryStoreKeys.version(id, versionId),
    queryFn: () => getMemoryVersion(id, versionId, client),
  });
}

export function useMemoryVersion(id: string, versionId: string) {
  return useQuery(memoryVersionOptions(id, versionId, useApiClient()));
}

/** Restore a version into a new live head (write scope, WP-C4.0b). Success
 * seeds the created version's detail cache, then invalidates the whole
 * store subtree — the versions list gained a head AND the memory's live
 * content changed (`memories` summaries + any cached `memory` content). */
export function useRestoreMemoryVersion(storeId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      restoreMemoryVersion(storeId, versionId, client),
    onSuccess: (created) => {
      queryClient.setQueryData(
        memoryStoreKeys.version(storeId, created.id),
        created,
      );
      void queryClient.invalidateQueries({
        queryKey: memoryStoreKeys.detail(storeId),
      });
    },
  });
}
