/**
 * Live session stream → Query-cache integration (WP-C2.1; console-spec
 * §8.1–§8.2, W3). Same `/v1/sessions` family as `./sessions.ts`, split out
 * for file size (like `./session-events.ts`).
 *
 * `useSessionStream` live-tails `GET /v1/sessions/:id/stream` (transport:
 * `./stream.ts`) and folds every frame into the SAME Query caches the
 * regular queries fill — entries + detail + usage — no parallel state store
 * (§8.2). It is mounted ONCE per viewed session by the session-detail page
 * (`src/features/sessions/session-detail.lazy.tsx`), independent of which
 * tab is active, so the §8.3 ambient title/favicon stays fresh off the
 * Trace tab.
 *
 * No-missed-events rule (§8.1): frames that arrive while the initial
 * entries query is still in flight cannot be patched into a cache that has
 * no data yet — they are buffered per (QueryClient, session) and flushed
 * through the same seq-dedupe upsert path the moment an entries query for
 * the session resolves, so nothing is dropped and nothing duplicates.
 */

import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Cursor, type Session, type SessionStatus } from "@pi-managed/contracts";

import type { ConsoleApi } from "./client.js";
import { sessionKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { SessionEntryWire } from "./sessions.js";
import {
  streamSessionEvents,
  type SessionStreamImpl,
  type SessionStreamPhase,
  type SessionStreamer,
  type SseFrame,
} from "./stream.js";

/**
 * `terminated` is the state machine's only terminal status (§6.3:
 * idle → running → rescheduling → terminated) — every other status can still
 * produce events, so live views keep tailing (W3/W4: an idle session with
 * `stopReason: requires_action` must stream its resumption).
 */
export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === "terminated";
}

/**
 * Synthetic per-subscriber lag notice (backend `STREAM_LAGGED`, R4.3). It
 * carries no SSE id on purpose; the client closes the gap by refetching.
 */
const STREAM_LAGGED_EVENT = "session.stream_lagged";

/** Every cached entries page of a session, whatever its slice params. */
function entriesQueryPrefix(sessionId: string): readonly unknown[] {
  return [...sessionKeys.detail(sessionId), "entries"];
}

/** Whether `queryKey` is an entries query of `sessionId` (prefix match). */
function isEntriesQueryKey(
  queryKey: readonly unknown[],
  sessionId: string,
): boolean {
  const prefix = entriesQueryPrefix(sessionId);
  return (
    queryKey.length >= prefix.length &&
    prefix.every((part, i) => queryKey[i] === part)
  );
}

/** At least one entries page of `sessionId` holds fetched data. */
function hasEntriesData(queryClient: QueryClient, sessionId: string): boolean {
  return queryClient
    .getQueriesData<Cursor<SessionEntryWire>>({
      queryKey: entriesQueryPrefix(sessionId),
    })
    .some(([, page]) => page !== undefined);
}

// --- Pending-entries buffer (no-missed-events, §8.1) -------------------------

/**
 * Entries parsed from frames that arrived while NO entries page of their
 * session had data yet (initial query still in flight): `setQueriesData`
 * over an empty cache is a no-op, so without buffering those frames would
 * leave a permanent hole in the Trace until an unrelated invalidation.
 * Keyed per QueryClient (tests run many side by side) → session id →
 * seq → entry (a Map dedupes replayed frames by seq while buffered).
 */
const pendingEntryBuffers = new WeakMap<
  QueryClient,
  Map<string, Map<number, SessionEntryWire>>
>();

function pendingBufferOf(
  queryClient: QueryClient,
  sessionId: string,
): Map<number, SessionEntryWire> {
  let bySession = pendingEntryBuffers.get(queryClient);
  if (!bySession) {
    bySession = new Map();
    pendingEntryBuffers.set(queryClient, bySession);
  }
  let buffer = bySession.get(sessionId);
  if (!buffer) {
    buffer = new Map();
    bySession.set(sessionId, buffer);
  }
  return buffer;
}

/** Drop `sessionId`'s buffer (stream teardown — on the next mount the
 * stream resumes from the highest CACHED seq, so the replay re-delivers
 * anything that was still buffered; nothing is lost). */
function dropPendingEntries(queryClient: QueryClient, sessionId: string): void {
  pendingEntryBuffers.get(queryClient)?.delete(sessionId);
}

/**
 * Upsert every buffered entry of `sessionId` into the (now non-empty)
 * entries caches, oldest seq first, then clear the buffer. Race-safe by
 * construction: the buffer is detached BEFORE the upserts apply, and frame
 * delivery is synchronous — a frame arriving after the flush started finds
 * the cache non-empty and takes the direct upsert path (deduped by seq),
 * never a stale buffer.
 */
function flushPendingEntries(
  queryClient: QueryClient,
  sessionId: string,
): void {
  const buffer = pendingEntryBuffers.get(queryClient)?.get(sessionId);
  if (!buffer || buffer.size === 0) return;
  if (!hasEntriesData(queryClient, sessionId)) return;
  dropPendingEntries(queryClient, sessionId);
  const entries = [...buffer.values()].sort((a, b) => a.seq - b.seq);
  queryClient.setQueriesData<Cursor<SessionEntryWire>>(
    { queryKey: entriesQueryPrefix(sessionId) },
    (page) => {
      if (!page) return page;
      let next = page;
      for (const entry of entries) next = upsertEntry(next, entry);
      return next;
    },
  );
}

/**
 * Fold one stream frame into the Query caches (§8.2 — invalidation/patch,
 * no parallel store):
 *
 * - position-carrying frames upsert into every cached entries page by `seq`
 *   (the SSE `id` IS the entry `seq` — one position ladder, api-reference
 *   §"SSE wire format"), so a replayed frame never duplicates an entry the
 *   regular entries query already fetched; while NO entries page has data
 *   yet (initial query in flight) the entry is buffered instead and flushed
 *   when the query resolves (see {@link flushPendingEntries});
 * - `session.status_*` frames invalidate the session detail (status /
 *   stopReason changed), its usage (the turn's cost landed), the list
 *   queries (status/stopReason drive the list rows and the §7.5
 *   requires_action badge — WP-C2.2), and the conversation messages
 *   (WP-C4.1 — the backend syncs the JSONL the `/messages` read serves on
 *   every status_idle transition, so the refetch lands the finished turn);
 * - a lag notice (no id) invalidates the entries queries — the refetch
 *   closes the dropped gap;
 * - delta frames (no id; never opted into by the console) are ignored.
 */
export function applyStreamFrame(
  queryClient: QueryClient,
  sessionId: string,
  frame: SseFrame,
): void {
  if (frame.event === STREAM_LAGGED_EVENT) {
    void queryClient.invalidateQueries({
      queryKey: entriesQueryPrefix(sessionId),
    });
    return;
  }
  if (frame.id === undefined) return;

  let entry: SessionEntryWire;
  try {
    const data =
      frame.data !== null && typeof frame.data === "object" ? frame.data : {};
    entry = SessionEntryWire.parse({ ...data, seq: frame.id });
  } catch {
    // A frame the contracts schema rejects: fall back to a refetch rather
    // than dropping the update on the floor.
    void queryClient.invalidateQueries({
      queryKey: entriesQueryPrefix(sessionId),
    });
    return;
  }

  if (hasEntriesData(queryClient, sessionId)) {
    queryClient.setQueriesData<Cursor<SessionEntryWire>>(
      { queryKey: entriesQueryPrefix(sessionId) },
      (page) => (page ? upsertEntry(page, entry) : page),
    );
  } else {
    pendingBufferOf(queryClient, sessionId).set(entry.seq, entry);
  }

  if (frame.event.startsWith("session.status")) {
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.detail(sessionId),
      exact: true,
    });
    void queryClient.invalidateQueries({ queryKey: sessionKeys.usage(sessionId) });
    void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    void queryClient.invalidateQueries({
      queryKey: sessionKeys.messages(sessionId),
    });
  }
}

/** Insert/replace by `seq`, keeping the page sorted; no-op on identical data
 * (a full-history replay re-delivers what the entries query already has). */
function upsertEntry(
  page: Cursor<SessionEntryWire>,
  entry: SessionEntryWire,
): Cursor<SessionEntryWire> {
  const existing = page.data.find((e) => e.seq === entry.seq);
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(entry)) return page;
    return {
      ...page,
      data: page.data.map((e) => (e.seq === entry.seq ? entry : e)),
    };
  }
  return { ...page, data: [...page.data, entry].sort((a, b) => a.seq - b.seq) };
}

/** Highest entry `seq` already cached — the stream resumes right after it
 * (replaying a long history the Trace tab already fetched would be waste). */
function latestCachedSeq(
  queryClient: QueryClient,
  sessionId: string,
): number | undefined {
  let max: number | undefined;
  const pages = queryClient.getQueriesData<Cursor<SessionEntryWire>>({
    queryKey: entriesQueryPrefix(sessionId),
  });
  for (const [, page] of pages) {
    for (const e of page?.data ?? []) {
      if (max === undefined || e.seq > max) max = e.seq;
    }
  }
  return max;
}

/**
 * The stream transport for the injected client: a client that implements the
 * optional {@link SessionStreamer} capability (the `FakeConsoleApi`
 * collaborator in UI tests) supplies it; otherwise the real fetch-streaming
 * `streamSessionEvents` (same-origin, cookie-authed — production). The
 * production `ConsoleApiClient` deliberately has no `streamSession` method:
 * the SSE transport is not part of the request/response client surface.
 */
function streamImplOf(api: ConsoleApi): SessionStreamImpl {
  const capability = (api as Partial<SessionStreamer>).streamSession;
  return capability ? capability.bind(api) : streamSessionEvents;
}

export interface UseSessionStreamResult {
  /** `idle` when not streaming (disabled); otherwise the transport phase. */
  phase: "idle" | SessionStreamPhase;
}

/**
 * Live-tail a session's event stream into the Query caches (§8.1–§8.2, W3).
 * While `enabled`, frames append/patch the entries + detail + usage caches
 * via {@link applyStreamFrame}; pass `enabled: false` once the session is
 * terminal ({@link isTerminalSessionStatus}) — or unmount — to stop. The
 * returned `phase` drives the Trace tab's live / polling / ended indicator.
 *
 * Mount ONE instance per viewed session (the session-detail page owns it);
 * a second concurrent mount would open a second wire connection and double
 * every invalidation.
 */
export function useSessionStream(
  sessionId: string,
  { enabled }: { enabled: boolean },
): UseSessionStreamResult {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<"idle" | SessionStreamPhase>("idle");

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // Frames buffered while the initial entries query was in flight are
    // flushed the moment any entries query of this session resolves (the
    // flush's own setQueriesData re-fires this event with an empty buffer —
    // a no-op, so no recursion).
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        isEntriesQueryKey(event.query.queryKey, sessionId)
      ) {
        flushPendingEntries(queryClient, sessionId);
      }
    });
    const stream = streamImplOf(api);
    const streamOpts: Parameters<SessionStreamImpl>[2] = {
      signal: controller.signal,
      // Cold-wake observability (F1): the backend closes an idle session's
      // stream cleanly once its history is replayed (no live runtime). Treat
      // that as terminal ONLY when the cached status actually is — otherwise
      // the transport reconnects at an idle cadence so a later wake (this
      // browser's composer OR a CLI `/remote:resume`) is observed, not missed.
      shouldReconnectOnClose: () => {
        const status = queryClient.getQueryData<Session>(
          sessionKeys.detail(sessionId),
        )?.status;
        return status === undefined || !isTerminalSessionStatus(status);
      },
    };
    const resumeFrom = latestCachedSeq(queryClient, sessionId);
    if (resumeFrom !== undefined) streamOpts.lastEventId = resumeFrom;
    void stream(
      sessionId,
      {
        onFrame: (frame) => applyStreamFrame(queryClient, sessionId, frame),
        onPhase: setPhase,
      },
      streamOpts,
    ).catch(() => {
      // The transport never rejects on wire trouble (reconnect/polling absorb
      // it); anything else is unexpected — surface as "ended", the regular
      // entries query is still in charge.
      if (!controller.signal.aborted) setPhase("ended");
    });
    return () => {
      controller.abort();
      unsubscribe();
      dropPendingEntries(queryClient, sessionId);
      setPhase("idle");
    };
  }, [api, queryClient, sessionId, enabled]);

  return { phase };
}
