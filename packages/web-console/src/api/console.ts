/**
 * Console-support endpoints (non-/v1) — fetchers + hooks (WP-C1.5).
 *
 * Mirrors `contracts/src/console.ts` (console-spec §3–§4): the public
 * `GET /console/config` and the cookie-backed console session
 * (`POST`/`GET`/`DELETE /console/session`). The API key appears only in the
 * `POST` body (write-only, §4.1); the browser holds an HttpOnly cookie the
 * fetch wrapper rides implicitly (`credentials: "same-origin"`).
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ConsoleConfig,
  ConsoleSessionCreate,
  ConsoleSessionCreateResponse,
  ConsoleSessionInfo,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { consoleKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

// --- Fetchers ---------------------------------------------------------------

/** `GET /console/config` — deployment presentation (public). */
export function fetchConsoleConfig(
  client: ConsoleApi = apiClient,
): Promise<ConsoleConfig> {
  return client.get("/console/config", ConsoleConfig);
}

/** `POST /console/session` — sign in with an API key (sets the cookie). */
export function createConsoleSession(
  body: ConsoleSessionCreate,
  client: ConsoleApi = apiClient,
): Promise<ConsoleSessionCreateResponse> {
  return client.post("/console/session", body, ConsoleSessionCreateResponse);
}

/** `GET /console/session` — current session (app boot); 401 when signed out. */
export function fetchConsoleSession(
  client: ConsoleApi = apiClient,
): Promise<ConsoleSessionInfo> {
  return client.get("/console/session", ConsoleSessionInfo);
}

/** `DELETE /console/session` — sign out (destroys the server-side record). */
export function deleteConsoleSession(
  client: ConsoleApi = apiClient,
): Promise<void> {
  return client.del("/console/session");
}

// --- Query options + hooks ----------------------------------------------------

/** Config never changes for a running backend — fetch once per app load. */
export function consoleConfigOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: consoleKeys.config(),
    queryFn: () => fetchConsoleConfig(client),
    staleTime: Infinity,
  });
}

export function useConsoleConfig() {
  return useQuery(consoleConfigOptions(useApiClient()));
}

/** 401 here means "signed out" — a state, not a transient failure: no retry. */
export function consoleSessionOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: consoleKeys.session(),
    queryFn: () => fetchConsoleSession(client),
    retry: false,
  });
}

export function useConsoleSession() {
  return useQuery(consoleSessionOptions(useApiClient()));
}

/** Sign in: on success the session query is refetched (cookie now set). */
export function useCreateConsoleSession() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConsoleSessionCreate) =>
      createConsoleSession(body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: consoleKeys.session() }),
  });
}

/**
 * Sign out: drop ALL cached server state — it belonged to the signed-in key.
 * `resetQueries` (not `clear`) so active queries refetch: the session query
 * comes back 401 and the app lands on the sign-in screen.
 */
export function useDeleteConsoleSession() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteConsoleSession(client),
    onSuccess: () => queryClient.resetQueries(),
  });
}
