/**
 * Inbound session events — `POST /v1/sessions/:id/events` (WP-C2.2;
 * console-spec §7.5, journey W4). The console sends exactly three of the
 * api-reference §"Events & SSE" inbound types:
 *
 *   - `user.message`            — steer: start/continue work (idle-only; a
 *                                 running session answers `409 session_not_idle`);
 *   - `user.interrupt`          — stop mid-execution;
 *   - `user.tool_confirmation`  — answer a blocking `always_ask` tool request
 *                                 (`allow`/`deny`, per blocking event id, §9.5).
 *
 * Split out of `./sessions.ts` purely for file size; same family, same
 * `sessionKeys`. The client wrapper supplies the wire duties: the CSRF header
 * on every mutation (§4.5) and an auto-generated `Idempotency-Key` (the
 * endpoint requires one). Every accepted event answers `202 {accepted: true}`
 * — work proceeds asynchronously and the session's reaction (status flip, new
 * log entries) arrives via the §8 stream / the invalidated queries.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  UserInterruptEvent,
  UserMessageEvent,
  UserToolConfirmationEvent,
} from "@pi-managed/contracts";

import { apiClient, type ConsoleApi, type ResponseSchema } from "./client.js";
import { sessionKeys } from "./keys.js";
import { useApiClient } from "./provider.js";

/** The inbound event bodies the console posts (contracts `InboundEvent` members). */
export type ConsoleSessionEvent =
  | UserMessageEvent
  | UserInterruptEvent
  | UserToolConfirmationEvent;

/** `202` body of every accepted inbound event (api-reference §"Events & SSE"). */
export interface EventAccepted {
  accepted: true;
}

/**
 * Hand-rolled structural validation for the `202` body: the response has no
 * `@pi-managed/contracts` schema yet and this package carries no direct zod
 * dependency (same situation as the outputs listing in `./sessions.ts`).
 */
const EventAcceptedSchema: ResponseSchema<EventAccepted> = {
  parse(input: unknown): EventAccepted {
    const accepted = (input as { accepted?: unknown } | null)?.accepted;
    if (accepted !== true) {
      throw new Error("send event: expected { accepted: true }");
    }
    return { accepted: true };
  },
};

/** `POST /v1/sessions/:id/events` — send one inbound event (write scope). */
export function sendSessionEvent(
  id: string,
  event: ConsoleSessionEvent,
  client: ConsoleApi = apiClient,
): Promise<EventAccepted> {
  return client.post(
    `/v1/sessions/${encodeURIComponent(id)}/events`,
    event,
    EventAcceptedSchema,
  );
}

/**
 * Mutation for the W4 controls (steer / interrupt / confirm). `202` means
 * accepted, not done: on success the session's detail subtree (detail +
 * entries + usage + …) and the list queries (status/stopReason drive the list
 * rows and the §7.5 requires_action surfaces) are invalidated so the UI
 * converges even without a live stream; while one is open, the
 * `session.status_*` frames deliver the same invalidations immediately
 * (`applyStreamFrame`, ./session-stream.ts).
 */
export function useSendSessionEvent(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (event: ConsoleSessionEvent) =>
      sendSessionEvent(id, event, client),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    },
  });
}
