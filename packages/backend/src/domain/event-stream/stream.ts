/**
 * @pi-managed/backend — Session stream handler (WP-1.7, §"GET /stream"; R4.2–R4.4).
 *
 * Wires the `session_events` projection (history) + the runtime `subscribe()`
 * AsyncIterable (live tail) → SSE frames on a writable stream (the hijacked Fastify
 * reply). Pipeline:
 *
 * 1. Subscribe to the live tail FIRST when a runtime is already active
 *    ({@link SessionStreamSource.runtime}) — so an event emitted while replay is in flight
 *    is buffered by this subscriber instead of falling into the gap between the projection
 *    read and `subscribe()` (R4.2). A completed/archived session has no runtime: the stream
 *    is history-only and ends after the replay. A read NEVER boots a VM (R4.4).
 * 2. Replay persisted events via the {@link EventsReader} (the projection, R4.1) — never
 *    from a live runtime. With `Last-Event-ID`, replay resumes right after it (gap-free
 *    reconnect); without one (first connect), replay serves the FULL persisted history from
 *    position 0 (or the optional `fromPosition`) so no persisted event is missed just
 *    because the subscriber connected late. Live events already covered by the replay
 *    window are deduped by position when the tail is drained.
 * 3. For each live event, run the delta reconciler (opt-in) and write
 *    `event_start`/`event_delta` (no SSE id) then the buffered event, whose SSE `id` is
 *    the event's projection {@link PositionedOutboundEvent.position} (§9.3).
 * 4. On client disconnect (AbortSignal), break the loop and release the iterator — which
 *    detaches this subscriber from the runtime's fan-out (R4.2).
 *
 * `processedAt` on persisted events: live events use the runtime's `createdAt` (the event
 * is being processed now); replayed entries use the persisted timestamp (see `wire.ts`).
 * `processedAt: null` is reserved for queued inbound events that have not yet been handled
 * — those are not delivered on the live outbound stream.
 *
 * **Lag (R4.3):** a subscriber that cannot keep up has its oldest events dropped by the
 * runtime, which then yields a synthetic {@link STREAM_LAGGED} event. It is forwarded
 * WITHOUT an SSE `id` on purpose: the client's `Last-Event-ID` must stay at the last event
 * it actually received, so its re-fetch from the projection starts exactly at the gap
 * (`fromPosition` names the first dropped position explicitly).
 */

import type { Logger } from "pino";
import type { Writable } from "node:stream";
import type {
  OutboundEvent,
  SessionId,
  SessionRuntime,
  TenantId,
} from "../ports.js";
import { encodeSseFrame, type SseFrame } from "./sse-encoder.js";
import { replayFrames, type EventsReader } from "./replay.js";
import { reconcileDeltas, type EventDeltaSet } from "./deltas.js";

/**
 * Synthetic event type emitted to a subscriber whose buffer overflowed (R4.3). Carries
 * `{ fromPosition }` — the projection position of the oldest dropped event — so the client
 * re-fetches the gap from the projection (`GET /v1/sessions/:id/events`). Never persisted:
 * lag is per-subscriber, not part of the one event universe (R4.1).
 */
export const STREAM_LAGGED = "session.stream_lagged";

/**
 * An {@link OutboundEvent} carrying its projection position — the SSE `id` (§9.3, R4.2).
 * The runtime stamps every emitted event with the position its `session_events` append
 * assigns, so a live frame and its replayed twin carry the SAME id even when a lagging
 * subscriber dropped events in between. Synthetic stream events ({@link STREAM_LAGGED})
 * carry no position.
 */
export interface PositionedOutboundEvent extends OutboundEvent {
  readonly position?: number;
}

/**
 * Where a stream reads from (R4.4): history ALWAYS from the projection; the live tail only
 * from an already-active runtime.
 */
export interface SessionStreamSource {
  /** The `session_events` projection reader (history + head). */
  events: EventsReader;
  tenantId: TenantId;
  sessionId: SessionId;
  /**
   * The active runtime, when one is already in memory. Absent ⇒ history-only stream —
   * reading a cold / completed / archived session must never provision a sandbox (R4.4).
   */
  runtime?: SessionRuntime;
}

/** Options for {@link pipeSessionStream}. */
export interface PipeSessionStreamOptions {
  /** `Last-Event-ID` header value (sequence position) for reconnect replay. */
  lastEventId?: number;
  /**
   * Optional starting position for a first-connect replay (`?from=`, e.g. to skip a long
   * history). Only used when `lastEventId` is absent; ignored otherwise. Defaults to `0`
   * (the full history).
   */
  fromPosition?: number;
  /** Opted-in event types for delta previews. */
  eventDeltas: EventDeltaSet;
  /** Abort signal (client disconnect); when aborted, the stream stops. */
  signal?: AbortSignal;
  /** Optional logger for surfacing stream errors. */
  logger?: Logger;
}

/** Write a single SSE frame, respecting backpressure (await `drain` if needed). */
function writeFrame(out: Writable, frame: SseFrame): Promise<void> {
  return new Promise((resolve) => {
    const ok = out.write(encodeSseFrame(frame));
    if (ok) resolve();
    else out.once("drain", () => resolve());
  });
}

/**
 * Pipe a session's event stream to `out`: replay from the projection, then the live tail
 * (only when a runtime is already active). Resolves when the live iterator ends or the
 * client disconnects. Never throws to the caller — errors are logged and the stream closes.
 */
export async function pipeSessionStream(
  source: SessionStreamSource,
  opts: PipeSessionStreamOptions,
  out: Writable,
): Promise<void> {
  if (out.destroyed) return;

  // 1. Subscribe to the live tail BEFORE replaying (R4.2 race fix). If we replayed first
  //    and subscribed second, any event emitted in the window between the projection read
  //    and `subscribe()` would be in neither surface — a silent gap in a stream documented
  //    as gap-free. Subscribing first buffers those events; we then dedupe them against the
  //    replay window by position. A read of a cold/completed session has no runtime, so it
  //    stays history-only and never wakes a VM (R4.4).
  const iter = source.runtime?.subscribe()[Symbol.asyncIterator]();
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    void iter?.return?.();
  };
  if (iter) opts.signal?.addEventListener("abort", onAbort);

  try {
    // 2. Replay persisted events from the projection (gap-free, delta-free, no VM wake),
    //    PAGED (PERF-3): frames are written page-by-page as the generator yields them, so a
    //    long history never materializes all at once. Inside the try so a projection-read
    //    error is logged and the (hijacked) stream closes cleanly rather than throwing into
    //    an already-committed HTTP response.
    const replay = replayFrames(
      source.events,
      { tenantId: source.tenantId, sessionId: source.sessionId },
      opts.lastEventId,
      opts.fromPosition,
    );
    let step = await replay.next();
    while (!step.done) {
      if (opts.signal?.aborted || out.destroyed) {
        await replay.return(0);
        return;
      }
      await writeFrame(out, step.value);
      step = await replay.next();
    }
    const nextSeq = step.value;

    // 3. Live tail — ONLY for an already-active runtime (R4.4: a read never wakes a VM).
    if (!iter) return;

    let seq = nextSeq;
    while (!aborted && !out.destroyed && !opts.signal?.aborted) {
      const result = await iter.next();
      if (result.done) break;
      const event = result.value as PositionedOutboundEvent;
      // A lag notice carries no SSE id (see the module docstring) — always forward it.
      if (event.type === STREAM_LAGGED) {
        const { buffered } = reconcileDeltas(event, opts.eventDeltas);
        await writeFrame(out, buffered);
        continue;
      }
      // Dedupe against the replay window: an event already served by step 2 (buffered by
      // the subscriber while replay was in flight) has a position below the replay head —
      // skip it so the client never sees it twice.
      if (event.position !== undefined && event.position < seq) continue;
      const { pre, buffered } = reconcileDeltas(event, opts.eventDeltas);
      for (const frame of pre) {
        if (out.destroyed) break;
        await writeFrame(out, frame);
      }
      if (out.destroyed) break;
      // The runtime stamps the projection position; a source that doesn't (fakes) falls
      // back to the running sequence continued from the replay head.
      const id = event.position ?? seq;
      await writeFrame(out, { ...buffered, id });
      seq = id + 1;
    }
  } catch (err) {
    opts.logger?.warn?.({ err: err instanceof Error ? err.message : String(err) }, "event stream error");
  } finally {
    if (iter) {
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        await iter.return?.();
      } catch {
        /* iterator already released */
      }
    }
  }
}
