/**
 * Conversation lens of the `/v1/sessions` family (WP-C4.1; console-spec
 * §10.1 rendering side, `console.md` §5a, journey W5 steps 1–2). Same
 * family as `./sessions.ts`, split out like `./session-events.ts` /
 * `./session-stream.ts` (file-size + 1:1 lens modules).
 *
 * `GET /v1/sessions/:id/messages` is the seed: Pi's post-compaction
 * `session.messages` view — the LLM-context message list, NOT the trace
 * (DP-4: one record, many lenses). Contracts pins the items as `unknown`
 * (`SessionMessages`, "clients must not depend on internal structure"), so
 * the Conversation tab narrows structurally with a raw-JSON fallback, the
 * same stance as the Tree tab.
 *
 * Freshness (honest latency, §10.1): the endpoint reads the session's JSONL
 * object, which the backend syncs to the object store on every
 * `session.status_idle` transition plus a periodic interval while running
 * (`JsonlSync`, default 30 s). So:
 *  - turn boundaries are immediate — `session.status_*` stream frames
 *    invalidate this query (`./session-stream.ts`), and the status_idle sync
 *    lands the finished turn's messages right before the refetch;
 *  - mid-turn content is up to ~30 s behind — callers may poll with
 *    {@link MESSAGES_SYNC_REFRESH_MS} while the session is `running` to ride
 *    the periodic sync (live per-event output is the Trace's job).
 */

import { queryOptions, useQuery } from "@tanstack/react-query";
import { SessionMessages } from "@pi-managed/contracts";

import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { sessionKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

/**
 * Poll interval while a session is `running`: the backend's periodic JSONL
 * sync cadence (`JsonlSync.DEFAULT_SYNC_INTERVAL_MS`) — polling faster
 * cannot observe fresher data, and slower would miss sync points. DP-10's
 * "no polling loops" is honored at rest: the interval applies only while a
 * turn is in flight, where SSE frames carry entries, never message-shaped
 * data.
 */
export const MESSAGES_SYNC_REFRESH_MS = 30_000;

/**
 * `{data: [...]}` envelope of `GET /v1/sessions/:id/messages` — the small
 * bounded-collection shape (api-reference §"Cursor pagination": no
 * `nextCursor` field). Hand-rolled like `SessionOutputsListSchema`
 * (`./sessions.ts`): this package carries no direct zod dependency; the
 * items themselves go through the contracts `SessionMessages` schema.
 */
const SessionMessagesResponse: ResponseSchema<SessionMessages> = {
  parse(input: unknown): SessionMessages {
    const data = (input as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error("session messages: expected { data: [...] }");
    }
    return SessionMessages.parse(data);
  },
};

/** `GET /v1/sessions/:id/messages` — the post-compaction LLM-context
 * message list (empty for a session that has not run a turn). */
export function listSessionMessages(
  id: string,
  client: ConsoleApi = apiClient,
): Promise<SessionMessages> {
  return client.get(
    `/v1/sessions/${encodeURIComponent(id)}/messages`,
    SessionMessagesResponse,
  );
}

export function sessionMessagesOptions(
  id: string,
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: sessionKeys.messages(id),
    queryFn: () => listSessionMessages(id, client),
  });
}

/**
 * The Conversation tab's seed query (§10.1). `refetchInterval` is the
 * caller's running-state poll — pass {@link MESSAGES_SYNC_REFRESH_MS} while
 * the session is `running`, `false` otherwise; turn boundaries refetch via
 * stream invalidation either way (see the module header).
 */
export function useSessionMessages(
  id: string,
  { refetchInterval = false }: { refetchInterval?: number | false } = {},
) {
  return useQuery({
    ...sessionMessagesOptions(id, useApiClient()),
    refetchInterval,
  });
}
