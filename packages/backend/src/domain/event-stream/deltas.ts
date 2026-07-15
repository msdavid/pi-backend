/**
 * @pi-managed/backend — Delta reconciler (WP-1.7, §"Live deltas").
 *
 * By default agent text arrives as buffered `agent.message` events. Clients opt in
 * to incremental previews via `?eventDeltas=agent.message,agent.thinking`. When
 * opted in, a buffered event is preceded by stream-only frames:
 *
 * 1. `event_start` — announces the upcoming event `{type, eventId}`.
 * 2. `event_delta` — incremental text keyed by `eventId` + `index` (agent.message
 *    only; agent.thinking is `event_start` only — content arrives in the buffered
 *    event).
 * 3. The buffered event (with SSE `id`) reconciles and is authoritative.
 *
 * Invariants (§"Live deltas"):
 * - Deltas are **never persisted and never replayed** on reconnect. They live only
 *   on the connection that opted in. (Replay is handled in `replay.ts` and never
 *   invokes this module.)
 * - Primary thread only; text only.
 *
 * NOTE: the {@link ManagedSessionRuntime} (WP-1.5) currently emits buffered
 * `agent.message`/`agent.thinking` events whole — it does not stream incremental
 * `text_delta`s through `subscribe()`. The reconciler therefore emits a single
 * `event_delta` (index 0) carrying the full text for `agent.message`; the buffered
 * event remains authoritative, so clients that replace deltas with the buffered
 * event see no net difference. When the runtime exposes true chunked deltas, only
 * the `event_delta` emission here needs to change — the wire contract is already
 * correct.
 */

import type { OutboundEvent } from "../ports.js";
import type { SseFrame } from "./sse-encoder.js";
import { outboundWireData } from "./wire.js";

/** A set of event types the client opted into for delta previews. */
export type EventDeltaSet = ReadonlySet<string>;

/** Valid delta-able event types (per §"Live deltas"). */
export const DELTAABLE_TYPES = new Set(["agent.message", "agent.thinking"]);

/**
 * Parse the `?eventDeltas=` query value into a set of opted-in event types.
 * Unknown types are ignored; only `agent.message`/`agent.thinking` are meaningful.
 */
export function parseEventDeltas(raw: unknown): EventDeltaSet {
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(parts.filter((t) => DELTAABLE_TYPES.has(t)));
}

/** Reconciled frames for a single live outbound event. */
export interface ReconciledFrames {
  /** Pre-buffered delta frames (`event_start`/`event_delta`); never carry an SSE id. */
  pre: SseFrame[];
  /** The authoritative buffered event frame; the caller assigns the SSE id (seq). */
  buffered: SseFrame;
}

/**
 * Reconcile deltas for a live outbound event. When the event type is opted in,
 * emits `event_start` (+ one `event_delta` for `agent.message`) before the
 * buffered event. Otherwise emits just the buffered event.
 */
export function reconcileDeltas(event: OutboundEvent, optIn: EventDeltaSet): ReconciledFrames {
  const buffered: SseFrame = { event: event.type, data: outboundWireData(event) };
  if (!optIn.has(event.type)) return { pre: [], buffered };

  const pre: SseFrame[] = [
    { event: "event_start", data: { eventId: event.id, type: event.type } },
  ];
  if (event.type === "agent.message") {
    const payload = (event.payload as { content?: unknown } | undefined) ?? {};
    const text = typeof payload.content === "string" ? payload.content : "";
    pre.push({ event: "event_delta", data: { eventId: event.id, index: 0, text } });
  }
  return { pre, buffered };
}
