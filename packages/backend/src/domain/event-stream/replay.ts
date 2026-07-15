/**
 * @pi-managed/backend — SSE replay (WP-1.7, §9.3 "Reconnect & replay"; R4.4).
 *
 * On reconnect the client sends `Last-Event-ID: <seq>` (standard SSE). The backend
 * replays persisted events with sequence position **greater than** the `Last-Event-ID`,
 * so buffered events are **gap-free across drops** without a separate history call.
 *
 * Key invariants:
 * - Replay reads the `session_events` projection (R4.1) through the {@link EventsReader}
 *   seam — NEVER a live runtime. Reading a session's history must not provision a sandbox,
 *   and must work for a completed / archived session (R4.4).
 * - Deltas (`event_start`/`event_delta`) are **never** replayed — they are stream-only and
 *   live on the single connection that opted in.
 * - A first connect (no `Last-Event-ID`) replays the FULL persisted history from position 0
 *   (i.e. serves the `session_events` projection) before the live tail attaches — no
 *   persisted event can ever be missed just because a subscriber connects after it was
 *   emitted. An optional `fromPosition` bounds that replay (e.g. the `?from=` query param)
 *   for a client that wants to skip a long history; it is ignored once `Last-Event-ID` is
 *   present, which always takes precedence.
 */

import type { EntryRange, SessionEntry, SessionId, TenantId } from "../ports.js";
import type { SseFrame } from "./sse-encoder.js";
import { entryWireData } from "./wire.js";

/** Result of a replay pass: the frames to flush + the next live sequence position. */
export interface ReplayResult {
  /** Persisted-event frames (each carries its SSE `id` = sequence position). */
  frames: SseFrame[];
  /** The next sequence position for live events that follow the replay. */
  nextSeq: number;
}

/**
 * Default replay page size (PERF-3). The projection read is paged so a session with a long
 * history never materializes the whole thing in memory at once — the stream writes each
 * page's frames (respecting backpressure) before fetching the next.
 */
export const DEFAULT_REPLAY_PAGE_SIZE = 500;

/**
 * The read side of the one event universe (R4.1 / R4.4): a positional reader over the
 * `session_events` projection. Implemented by the `SessionManager`
 * (`readEvents` / `readEventsHead` → the pool-backed `SessionEventsStore`), which queries
 * Postgres directly and therefore provisions nothing.
 */
export interface EventsReader {
  /**
   * Positional slice of a session's persisted events (`start` inclusive, `end` exclusive;
   * `limit` caps the count).
   */
  readEvents(
    tenantId: TenantId,
    sessionId: SessionId,
    range?: EntryRange,
  ): Promise<SessionEntry[]>;
  /** The next position the projection would assign (0 when empty) — the stream head. */
  readEventsHead(sessionId: SessionId): Promise<number>;
}

/** The session a replay targets. */
export interface ReplayTarget {
  tenantId: TenantId;
  sessionId: SessionId;
}

/**
 * Build the replay frames for a connect. When `lastEventId` is provided, reads persisted
 * events with `position > lastEventId` (gap-free reconnect). When absent (first connect),
 * reads persisted events from `fromPosition` (default `0`, i.e. the full history) — the
 * projection is gap-free by construction, so this is how a first-time subscriber can never
 * miss an event that was persisted before it connected.
 */
export async function replayFromLastEventId(
  events: EventsReader,
  target: ReplayTarget,
  lastEventId: number | undefined,
  fromPosition?: number,
): Promise<ReplayResult> {
  // Collect the paged generator. Kept for callers/tests that want the whole replay at once;
  // the streaming path (`pipeSessionStream`) consumes {@link replayFrames} page-by-page.
  const gen = replayFrames(events, target, lastEventId, fromPosition);
  const frames: SseFrame[] = [];
  let step = await gen.next();
  while (!step.done) {
    frames.push(step.value);
    step = await gen.next();
  }
  return { frames, nextSeq: step.value };
}

/**
 * Paged replay generator (PERF-3): yields persisted-event frames one page at a time and
 * RETURNS the next live sequence position when exhausted. The caller writes each frame as it
 * arrives (respecting backpressure) so a long history is never materialized all at once.
 * Same window semantics as {@link replayFromLastEventId} (`Last-Event-ID` wins over
 * `fromPosition`; a first connect replays from `fromPosition ?? 0`).
 */
export async function* replayFrames(
  events: EventsReader,
  target: ReplayTarget,
  lastEventId: number | undefined,
  fromPosition?: number,
  pageSize: number = DEFAULT_REPLAY_PAGE_SIZE,
): AsyncGenerator<SseFrame, number, void> {
  let start = lastEventId !== undefined ? lastEventId + 1 : (fromPosition ?? 0);
  let lastPosition: number | undefined;
  for (;;) {
    const entries = await events.readEvents(target.tenantId, target.sessionId, {
      start,
      limit: pageSize,
    });
    for (const entry of entries) {
      lastPosition = entry.position;
      yield { id: entry.position, event: entry.type, data: entryWireData(entry) };
    }
    // A short page is the last page — the projection has nothing more past it.
    if (entries.length < pageSize) break;
    start = entries[entries.length - 1].position + 1;
  }

  if (lastPosition !== undefined) return lastPosition + 1;
  // Nothing replayed: continue right after the cursor, else from the projection head so live
  // events keep the same numbering.
  if (lastEventId !== undefined) return lastEventId + 1;
  return await events.readEventsHead(target.sessionId);
}
