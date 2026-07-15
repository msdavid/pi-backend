/**
 * @pi-managed/backend — Event stream (SSE) domain (WP-1.7).
 *
 * The Events API send/stream surface. See `api/events.ts` for the HTTP routes
 * that consume this module.
 */

export { encodeSseFrame, type SseFrame } from "./sse-encoder.js";
export {
  generateEventId,
  nowIso,
  inboundToPorts,
  outboundWireData,
  entryWireData,
  entryToHistoryItem,
  type HistoryItem,
} from "./wire.js";
export {
  replayFromLastEventId,
  type ReplayResult,
  type EventsReader,
  type ReplayTarget,
} from "./replay.js";
export {
  reconcileDeltas,
  parseEventDeltas,
  DELTAABLE_TYPES,
  type EventDeltaSet,
  type ReconciledFrames,
} from "./deltas.js";
export {
  pipeSessionStream,
  STREAM_LAGGED,
  type PipeSessionStreamOptions,
  type PositionedOutboundEvent,
  type SessionStreamSource,
} from "./stream.js";
