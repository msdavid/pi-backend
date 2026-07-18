/**
 * `/v1/webhooks` family — fetchers + hooks (WP-C3-prep skeleton; the
 * webhooks surface, console-spec §9.8 / journey W13, is WP-C3.4).
 *
 * Mirrors `contracts/src/webhook.ts` and api-reference §"Webhooks". The
 * exact surface (verified against the backend's `api/webhooks.ts` — do not
 * invent ops): register (`201`; the `whsec_` signing secret is returned ONLY
 * here), list + retrieve (never the secret), delete, test-delivery
 * (`POST …/test` → `{delivered, responseCode?}`).
 *
 * NO enable/disable endpoint exists (verified): auto-disable is server-side
 * (~20 consecutive failures / private-IP / redirect) and surfaces as
 * `disabledReason` on the resource; the documented re-enable path is manual
 * — today that means delete + re-register (which mints a NEW signing
 * secret). WP-C3.4 must surface the auto-disabled state with exactly that
 * path (§9.8) — flagged to the orchestrator as a spec/API gap if an in-place
 * re-enable is wanted instead.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Cursor,
  Webhook,
  WebhookCreateResponse,
  WebhookTestResponse,
  type WebhookCreate,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { webhookKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

const WebhookPage = Cursor(Webhook);

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/webhooks` — the full set (`nextCursor` is always `null`). */
export function listWebhooks(
  client: ConsoleApi = apiClient,
): Promise<Cursor<Webhook>> {
  return client.get("/v1/webhooks", WebhookPage);
}

/** `GET /v1/webhooks/:id` — retrieve (never returns the signing secret). */
export function getWebhook(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Webhook> {
  return client.get(`/v1/webhooks/${encodeURIComponent(id)}`, Webhook);
}

/** `POST /v1/webhooks` — register (admin). The `whsec_` signing secret is in
 * THIS response only — show once, copy-and-confirm, never store (§9.8). */
export function registerWebhook(
  body: WebhookCreate,
  client: ConsoleApi = apiClient,
): Promise<WebhookCreateResponse> {
  return client.post("/v1/webhooks", body, WebhookCreateResponse);
}

/** `DELETE /v1/webhooks/:id` — delete (204). */
export function deleteWebhook(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del(`/v1/webhooks/${encodeURIComponent(id)}`);
}

/** `POST /v1/webhooks/:id/test` — send a test event; reports whether the
 * endpoint acknowledged it (and the response code when a request was made). */
export function testWebhook(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<WebhookTestResponse> {
  return client.post(
    `/v1/webhooks/${encodeURIComponent(id)}/test`,
    {},
    WebhookTestResponse,
  );
}

// --- Query options + hooks ----------------------------------------------------

export function webhooksOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: webhookKeys.list(),
    queryFn: () => listWebhooks(client),
  });
}

/** The tenant's webhook endpoints — a small bounded set, one query (C§9.8). */
export function useWebhooks() {
  return useQuery(webhooksOptions(useApiClient()));
}

export function webhookOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: webhookKeys.detail(id),
    queryFn: () => getWebhook(id, client),
  });
}

export function useWebhook(id: string) {
  return useQuery(webhookOptions(id, useApiClient()));
}

/** Register (admin). The signing secret lives ONLY in the mutation result. */
export function useRegisterWebhook() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: WebhookCreate) => registerWebhook(body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: webhookKeys.lists() }),
  });
}

/** Delete (admin; DP-7 — deleting also discards the signing secret). */
export function useDeleteWebhook() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWebhook(id, client),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: webhookKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: webhookKeys.lists() });
    },
  });
}

/** Test delivery (admin). No cache to update — the result renders inline. */
export function useTestWebhook(id: string) {
  const client = useApiClient();
  return useMutation({ mutationFn: () => testWebhook(id, client) });
}
