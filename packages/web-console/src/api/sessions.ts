/**
 * `/v1/sessions` family — fetchers + hooks for the phase-1 read surface
 * (WP-C1.5; console-spec §7.2–§7.4 consume these) plus the WP-C2.3
 * Tree/Outputs/Fork surface (§7.3 remaining tabs, journey W6): the JSONL
 * tree read, the idle-only outputs listing, and the fork mutation — and the
 * WP-C2.2 `requires_action` window (`useRequiresActionSessions`, §7.5, over
 * the server-side `?stopReason=` filter). Two same-family modules are split
 * out for file size: the W4 inbound-event mutations live in
 * `./session-events.ts`, and the WP-C2.1 live stream (`useSessionStream`,
 * §8.1–§8.2) in `./session-stream.ts`.
 *
 * Mirrors `contracts/src/session.ts`. Response bodies are validated with the
 * contracts schemas at the seam (C§12.3); the sessions list pages with the
 * standard cursor convention (`./pagination.ts`), entries with the positional
 * `?from=&to=&limit=` slice (api-reference §"GET /v1/sessions/:id/entries").
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
  Session,
  SessionEntry,
  SessionTree,
  SessionUsageResponse,
  type SessionStatus,
  type StopReason,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { sessionKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { cursorPageParams, withQuery } from "./pagination.js";

// Entries carry event-specific payload fields beyond the pinned
// {seq, type, processedAt} — `.loose()` keeps them for the Trace tab
// (api-reference: "{seq, type, ...payload, processedAt}"). The schema value
// is exported for `./session-stream.ts`, which parses stream frames into the
// same wire shape before folding them into the entries caches.
export const SessionEntryWire = SessionEntry.loose();
export type SessionEntryWire = ReturnType<typeof SessionEntryWire.parse>;

const SessionPage = Cursor(Session);
const SessionEntryPage = Cursor(SessionEntryWire);

/** Filters for `GET /v1/sessions` (contracts `SessionListParams`:
 * `?status=&stopReason=&agentId=&environmentId=`, all combinable). */
export interface SessionListFilters {
  limit?: number;
  status?: SessionStatus;
  stopReason?: StopReason;
  agentId?: string;
  environmentId?: string;
}

/** Positional slice params for `GET /v1/sessions/:id/entries`. */
export interface SessionEntriesParams {
  from?: number;
  to?: number;
  limit?: number;
}

/** A downloadable output file reference (api-reference §"GET /v1/sessions/:id/outputs"). */
export interface SessionOutputRef {
  name: string;
}

/** Response of `GET /v1/sessions/:id/outputs` — the name-only minimal slice. */
export interface SessionOutputsList {
  data: SessionOutputRef[];
}

/**
 * Hand-rolled structural validation for the outputs listing: the endpoint has
 * no `@pi-managed/contracts` schema yet (the backend's minimal slice returns
 * name-only refs, `packages/backend/src/domain/file/outputs.ts`), and this
 * package carries no direct zod dependency. Replace with the contracts schema
 * once one lands (contracts is the synchronization artifact, plan rule 2).
 */
const SessionOutputsListSchema: ResponseSchema<SessionOutputsList> = {
  parse(input: unknown): SessionOutputsList {
    const data = (input as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error("session outputs: expected { data: [...] }");
    }
    return {
      data: data.map((item) => {
        const name = (item as { name?: unknown } | null)?.name;
        if (typeof name !== "string") {
          throw new Error("session outputs: expected { name: string } refs");
        }
        return { name };
      }),
    };
  },
};

/**
 * The cookie-authed same-origin download URL for one output file
 * (api-reference §"GET /v1/sessions/:id/outputs/:filename"). Rendered as a
 * plain `<a href>` — the console-session cookie rides every same-origin GET,
 * so no scripted fetch is involved (the response carries no
 * `Content-Disposition`; the anchor's `download` attribute names the file).
 */
export function sessionOutputDownloadUrl(id: string, filename: string): string {
  return `/v1/sessions/${encodeURIComponent(id)}/outputs/${encodeURIComponent(filename)}`;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/sessions` — one page of the cursor-paginated list. */
export function listSessions(
  params: SessionListFilters & { cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<Session>> {
  return client.get(withQuery("/v1/sessions", { ...params }), SessionPage);
}

/** `GET /v1/sessions/:id` — retrieve (status, usage, config). */
export function getSession(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Session> {
  return client.get(`/v1/sessions/${encodeURIComponent(id)}`, Session);
}

/** `GET /v1/sessions/:id/entries` — positional log slice. */
export function listSessionEntries(
  id: string,
  params: SessionEntriesParams = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<SessionEntryWire>> {
  return client.get(
    withQuery(`/v1/sessions/${encodeURIComponent(id)}/entries`, { ...params }),
    SessionEntryPage,
  );
}

/** `GET /v1/sessions/:id/usage` — cumulative token usage + USD cost. */
export function getSessionUsage(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<SessionUsageResponse> {
  return client.get(
    `/v1/sessions/${encodeURIComponent(id)}/usage`,
    SessionUsageResponse,
  );
}

/**
 * `GET /v1/sessions/:id/tree` — the JSONL tree structure (branches, fork
 * points). Deliberately `unknown`: contracts pins `SessionTree = z.unknown()`
 * ("clients must not depend on internal structure"), so the Tree tab renders
 * it best-effort with a raw-JSON fallback.
 */
export function getSessionTree(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<unknown> {
  return client.get(`/v1/sessions/${encodeURIComponent(id)}/tree`, SessionTree);
}

/** `GET /v1/sessions/:id/outputs` — list output files (idle-only: a
 * non-idle session answers `409 session_not_idle`). */
export function listSessionOutputs(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<SessionOutputsList> {
  return client.get(
    `/v1/sessions/${encodeURIComponent(id)}/outputs`,
    SessionOutputsListSchema,
  );
}

/** `POST /v1/sessions/:id/fork` — fork (write scope; W6). The wrapper
 * auto-generates the required `Idempotency-Key`; returns the new session
 * (`forkedFromSessionId` set to the original). */
export function forkSession(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<Session> {
  return client.post(`/v1/sessions/${encodeURIComponent(id)}/fork`, {}, Session);
}

// --- Query options + hooks ----------------------------------------------------

export function sessionsInfiniteOptions(
  filters: SessionListFilters = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: sessionKeys.list(filters),
    queryFn: ({ pageParam }) =>
      listSessions({ ...filters, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Cursor-paginated sessions list (C§7.3). */
export function useSessions(filters: SessionListFilters = {}) {
  return useInfiniteQuery(sessionsInfiniteOptions(filters, useApiClient()));
}

/** First-page window for the §7.5 global requires_action surfaces. */
export const REQUIRES_ACTION_FILTERS: SessionListFilters = {
  stopReason: "requires_action",
  limit: 50,
};

/**
 * Poll interval for {@link useRequiresActionSessions} (WP-C2.2). 30 s: the
 * badge/section must catch a session stopping on a blocking request within a
 * human attention span, and the cost is one single-page list read — while a
 * session detail page is streaming, its `session.status_*` frames invalidate
 * the list queries anyway (`applyStreamFrame`, `./session-stream.ts`), so
 * those updates land immediately and the poll is only the no-stream-open
 * baseline.
 */
export const REQUIRES_ACTION_REFRESH_MS = 30_000;

/**
 * Sessions idle on `stopReason: requires_action` (§7.5 — sidebar badge +
 * Home section; powered by the server-side `?stopReason=` filter, WP-C2.0).
 * Every caller shares one cache entry ({@link REQUIRES_ACTION_FILTERS}), so
 * the badge and the Home section cost a single request between them.
 */
export function useRequiresActionSessions() {
  return useInfiniteQuery({
    ...sessionsInfiniteOptions(REQUIRES_ACTION_FILTERS, useApiClient()),
    refetchInterval: REQUIRES_ACTION_REFRESH_MS,
  });
}

export function sessionOptions(
  id: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: sessionKeys.detail(id),
    queryFn: () => getSession(id, client),
  });
}

export function useSession(id: string) {
  return useQuery(sessionOptions(id, useApiClient()));
}

export function sessionEntriesOptions(
  id: string,
  params: SessionEntriesParams = {},
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: sessionKeys.entries(id, params),
    queryFn: () => listSessionEntries(id, params, client),
  });
}

export function useSessionEntries(id: string, params?: SessionEntriesParams) {
  return useQuery(sessionEntriesOptions(id, params, useApiClient()));
}

export function sessionUsageOptions(
  id: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: sessionKeys.usage(id),
    queryFn: () => getSessionUsage(id, client),
  });
}

export function useSessionUsage(id: string) {
  return useQuery(sessionUsageOptions(id, useApiClient()));
}

export function sessionTreeOptions(id: string, client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: sessionKeys.tree(id),
    queryFn: () => getSessionTree(id, client),
  });
}

/** The JSONL tree (Tree tab, C§7.3). */
export function useSessionTree(id: string) {
  return useQuery(sessionTreeOptions(id, useApiClient()));
}

export function sessionOutputsOptions(
  id: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: sessionKeys.outputs(id),
    queryFn: () => listSessionOutputs(id, client),
  });
}

/** Output files (Outputs tab, C§7.3; idle-only per the API). */
export function useSessionOutputs(id: string) {
  return useQuery(sessionOutputsOptions(id, useApiClient()));
}

/**
 * Fork (W6). On success the new session is seeded into the detail cache (the
 * success notice links straight to it) and the list queries are invalidated —
 * the fork shows up in the sessions list and as a child in Tree tabs (which
 * derive children from the list pages).
 */
export function useForkSession(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => forkSession(id, client),
    onSuccess: (forked) => {
      queryClient.setQueryData(sessionKeys.detail(forked.id), forked);
      void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}

