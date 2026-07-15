/**
 * @pi-managed/backend — Event stream (SSE) frame encoder (WP-1.7, §"SSE wire format").
 *
 * Each persisted event is delivered as one SSE frame:
 *
 * ```
 * id: <seq>
 * event: <type>
 * data: <json>
 *
 * ```
 *
 * - `id` — the event's sequence position in the session log (the replay cursor,
 *   §9.3). Omitted for stream-only `event_start`/`event_delta` frames.
 * - `event` — the event type from the catalog (`{domain}.{action}`).
 * - `data` — the event JSON, on a single line.
 * - Frames are separated by a blank line (`\n\n`).
 */

/** A single SSE frame: an optional sequence `id`, an `event` type, and `data`. */
export interface SseFrame {
  /** Sequence position in the session log (§9.3). Omitted for delta frames. */
  id?: number;
  /** The SSE `event:` field — the event type (or `event_start`/`event_delta`). */
  event: string;
  /** JSON-serialized into the `data:` line. */
  data: unknown;
}

/**
 * Encode an {@link SseFrame} into the SSE wire text (without trailing delimiter
 * handling beyond the spec's blank line). Returns the frame text ending in `\n\n`.
 */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}
