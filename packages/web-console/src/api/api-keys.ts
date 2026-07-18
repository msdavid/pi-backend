/**
 * `/v1/api-keys` family — fetchers + hooks (WP-C3-prep skeleton; the API-keys
 * surface, console-spec §9.7 / journeys W9/W13, is WP-C3.4).
 *
 * Mirrors `contracts/src/tenant.ts` (ApiKey schemas) and api-reference
 * §"Tenant / admin". The exact surface (verified against the backend's
 * `api/tenant.ts` — do not invent ops): list (the full set,
 * `nextCursor: null` — no paging), issue (`201`; the raw `key` is shown ONCE
 * and never returned again — the create response is deliberately not
 * idempotency-replayable), revoke (`DELETE`, 204). There is NO
 * `GET /v1/api-keys/:id` retrieve route — detail views read from the list.
 *
 * Worker keys (`self_hosted_worker:<envId>` scope marker) live in the same
 * table and appear in the same list; {@link workerKeyScopeOf} lets WP-C3.2
 * split them out (there is no dedicated worker-keys list route).
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ApiKey,
  ApiKeyCreateResponse,
  Cursor,
  type ApiKeyCreate,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { apiKeyKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

const ApiKeyPage = Cursor(ApiKey);

/** The scope marker binding a worker key to its environment (§10.4). */
const WORKER_SCOPE_PREFIX = "self_hosted_worker:";

/** The environment id a worker key is bound to, or `null` for org keys. */
export function workerKeyScopeOf(key: ApiKey): string | null {
  const marker = (key.scopes ?? []).find((s) =>
    s.startsWith(WORKER_SCOPE_PREFIX),
  );
  return marker ? marker.slice(WORKER_SCOPE_PREFIX.length) : null;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/api-keys` — the full set (records WITHOUT the raw key). */
export function listApiKeys(
  client: ConsoleApi = apiClient,
): Promise<Cursor<ApiKey>> {
  return client.get("/v1/api-keys", ApiKeyPage);
}

/** `POST /v1/api-keys` — issue (admin). `scopes` defaults server-side to
 * `["read"]` (least privilege — §9.7: scopes are an opt-up). The raw `key`
 * in the response is shown once; render-and-confirm, never store. */
export function issueApiKey(
  body: ApiKeyCreate,
  client: ConsoleApi = apiClient,
): Promise<ApiKeyCreateResponse> {
  return client.post("/v1/api-keys", body, ApiKeyCreateResponse);
}

/** `DELETE /v1/api-keys/:id` — revoke; the key immediately stops
 * authenticating (console sessions riding it die on next use). */
export function revokeApiKey(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/api-keys/${encodeURIComponent(id)}`);
}

// --- Query options + hooks ----------------------------------------------------

export function apiKeysOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: apiKeyKeys.list(),
    queryFn: () => listApiKeys(client),
  });
}

/** The tenant's API keys — a small bounded set, one query (C§9.7). */
export function useApiKeys() {
  return useQuery(apiKeysOptions(useApiClient()));
}

/** Issue (admin). The raw key lives ONLY in the mutation result — the list
 * cache is refreshed with the record (which never carries the key). */
export function useIssueApiKey() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiKeyCreate) => issueApiKey(body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.lists() }),
  });
}

/** Revoke (admin; DP-7 dialog names the consequence: everything using the
 * key — CLI, console sessions, workers — stops authenticating). */
export function useRevokeApiKey() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeApiKey(id, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: apiKeyKeys.lists() }),
  });
}
