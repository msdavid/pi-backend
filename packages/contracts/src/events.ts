/**
 * @pi-managed/contracts — Events & SSE.
 *
 * Mirrors docs/api-reference.md §"Events & SSE" and the FINAL persisted event
 * catalog (§"Event-type naming scheme"). Persisted event types follow
 * `{domain}.{action}`; stream-only `event_start`/`event_delta` are never persisted.
 * Every persisted event carries `processedAt` (null = queued).
 */

import { z } from "zod";
import { Timestamp, StopReason } from "./common.js";
import { eventId } from "./ids.js";
import { OutcomeRubric } from "./outcome.js";

const ProcessedAt = { processedAt: Timestamp.nullable() } as const;

// ============================ Inbound events (request bodies) ================
// user.* / system.* — sent via POST /v1/sessions/:id/events. processedAt is
// server-assigned, so request schemas omit it.

export const UserMessageEvent = z.object({
  type: z.literal("user.message"),
  content: z.string(),
});
export type UserMessageEvent = z.infer<typeof UserMessageEvent>;

export const UserInterruptEvent = z.object({
  type: z.literal("user.interrupt"),
});
export type UserInterruptEvent = z.infer<typeof UserInterruptEvent>;

export const SystemMessageEvent = z.object({
  type: z.literal("system.message"),
  content: z.string(),
});
export type SystemMessageEvent = z.infer<typeof SystemMessageEvent>;

export const UserToolConfirmationEvent = z.object({
  type: z.literal("user.tool_confirmation"),
  eventId: eventId,
  decision: z.enum(["allow", "deny"]),
  denyMessage: z.string().optional(),
});
export type UserToolConfirmationEvent = z.infer<typeof UserToolConfirmationEvent>;

export const UserCustomToolResultEvent = z.object({
  type: z.literal("user.custom_tool_result"),
  customToolUseId: eventId,
  result: z.string(),
});
export type UserCustomToolResultEvent = z.infer<typeof UserCustomToolResultEvent>;

/** Self-hosted environments only — worker-provided tool results (§9.2). */
export const UserToolResultEvent = z.object({
  type: z.literal("user.tool_result"),
  toolUseId: z.string(),
  result: z.string(),
});
export type UserToolResultEvent = z.infer<typeof UserToolResultEvent>;

export const UserDefineOutcomeEvent = z.object({
  type: z.literal("user.define_outcome"),
  description: z.string(),
  rubric: OutcomeRubric,
  maxIterations: z.number().int().min(1).max(20).optional(),
});
export type UserDefineOutcomeEvent = z.infer<typeof UserDefineOutcomeEvent>;

export const InboundEvent = z.discriminatedUnion("type", [
  UserMessageEvent,
  UserInterruptEvent,
  SystemMessageEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserToolResultEvent,
  UserDefineOutcomeEvent,
]);
export type InboundEvent = z.infer<typeof InboundEvent>;

// ============================ Outbound events (response / stream) ============

// --- session.* --------------------------------------------------------------

export const SessionStatusIdleEvent = z.object({
  type: z.literal("session.status_idle"),
  stopReason: StopReason,
  blockingEventIds: z.array(eventId).optional(),
  ...ProcessedAt,
});
export type SessionStatusIdleEvent = z.infer<typeof SessionStatusIdleEvent>;

export const SessionStatusRunStartedEvent = z.object({
  type: z.literal("session.status_run_started"),
  ...ProcessedAt,
});
export type SessionStatusRunStartedEvent = z.infer<typeof SessionStatusRunStartedEvent>;

export const SessionStatusRescheduledEvent = z.object({
  type: z.literal("session.status_rescheduled"),
  ...ProcessedAt,
});
export type SessionStatusRescheduledEvent = z.infer<typeof SessionStatusRescheduledEvent>;

export const SessionStatusTerminatedEvent = z.object({
  type: z.literal("session.status_terminated"),
  ...ProcessedAt,
});
export type SessionStatusTerminatedEvent = z.infer<typeof SessionStatusTerminatedEvent>;

export const SessionErrorEvent = z.object({
  type: z.literal("session.error"),
  mcpServerName: z.string().optional(),
  retryStatus: z
    .enum(["mcp_connection_failed_error", "mcp_authentication_failed_error"])
    .optional(),
  ...ProcessedAt,
});
export type SessionErrorEvent = z.infer<typeof SessionErrorEvent>;

// --- agent.* ----------------------------------------------------------------

export const AgentMessageEvent = z.object({
  type: z.literal("agent.message"),
  content: z.string(),
  ...ProcessedAt,
});
export type AgentMessageEvent = z.infer<typeof AgentMessageEvent>;

export const AgentThinkingEvent = z.object({
  type: z.literal("agent.thinking"),
  content: z.string(),
  ...ProcessedAt,
});
export type AgentThinkingEvent = z.infer<typeof AgentThinkingEvent>;

const ToolInput = z.record(z.string(), z.unknown());

export const AgentToolUseEvent = z.object({
  type: z.literal("agent.tool_use"),
  tool: z.string(),
  input: ToolInput,
  eventId: eventId.optional(),
  ...ProcessedAt,
});
export type AgentToolUseEvent = z.infer<typeof AgentToolUseEvent>;

export const AgentMcpToolUseEvent = z.object({
  type: z.literal("agent.mcp_tool_use"),
  tool: z.string(),
  input: ToolInput,
  mcpServerName: z.string().optional(),
  eventId: eventId.optional(),
  ...ProcessedAt,
});
export type AgentMcpToolUseEvent = z.infer<typeof AgentMcpToolUseEvent>;

export const AgentToolResultEvent = z.object({
  type: z.literal("agent.tool_result"),
  tool: z.string(),
  output: z.string(),
  truncated: z.boolean().optional(),
  ...ProcessedAt,
});
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEvent>;

export const AgentCustomToolUseEvent = z.object({
  type: z.literal("agent.custom_tool_use"),
  tool: z.string(),
  input: ToolInput,
  eventId: eventId,
  ...ProcessedAt,
});
export type AgentCustomToolUseEvent = z.infer<typeof AgentCustomToolUseEvent>;

export const AgentThreadMessageReceivedEvent = z.object({
  type: z.literal("agent.thread_message_received"),
  ...ProcessedAt,
});
export type AgentThreadMessageReceivedEvent = z.infer<
  typeof AgentThreadMessageReceivedEvent
>;

export const AgentThreadMessageSentEvent = z.object({
  type: z.literal("agent.thread_message_sent"),
  ...ProcessedAt,
});
export type AgentThreadMessageSentEvent = z.infer<typeof AgentThreadMessageSentEvent>;

// --- span.* -----------------------------------------------------------------

export const SpanModelRequestStartEvent = z.object({
  type: z.literal("span.model_request_start"),
  ...ProcessedAt,
});
export type SpanModelRequestStartEvent = z.infer<typeof SpanModelRequestStartEvent>;

export const SpanModelRequestEndEvent = z.object({
  type: z.literal("span.model_request_end"),
  ...ProcessedAt,
});
export type SpanModelRequestEndEvent = z.infer<typeof SpanModelRequestEndEvent>;

/** Concrete enumerated outbound event types. */
export const OutboundEvent = z.discriminatedUnion("type", [
  SessionStatusIdleEvent,
  SessionStatusRunStartedEvent,
  SessionStatusRescheduledEvent,
  SessionStatusTerminatedEvent,
  SessionErrorEvent,
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolUseEvent,
  AgentMcpToolUseEvent,
  AgentToolResultEvent,
  AgentCustomToolUseEvent,
  AgentThreadMessageReceivedEvent,
  AgentThreadMessageSentEvent,
  SpanModelRequestStartEvent,
  SpanModelRequestEndEvent,
]);
export type OutboundEvent = z.infer<typeof OutboundEvent>;

/**
 * Fallback for the wildcard families (`session.thread_*`,
 * `session.outcome_evaluation_*`, `span.outcome_evaluation_*`) whose concrete subtypes
 * are enumerated in WP-0.4, and for future event types.
 */
export const LooseEvent = z
  .object({
    type: z.string(),
    ...ProcessedAt,
  })
  .catchall(z.unknown());
export type LooseEvent = z.infer<typeof LooseEvent>;

/** Any persisted event (inbound or outbound, including not-yet-enumerated subtypes). */
export const PersistedEvent = z.union([InboundEvent, OutboundEvent, LooseEvent]);
export type PersistedEvent = z.infer<typeof PersistedEvent>;

// ============================ Stream-only deltas (never persisted) ===========

export const EventStartFrame = z.object({
  eventId: eventId,
  /** The upcoming buffered event's type (e.g. `agent.message`). */
  type: z.string(),
});
export type EventStartFrame = z.infer<typeof EventStartFrame>;

export const EventDeltaFrame = z.object({
  eventId: eventId,
  index: z.number().int().nonnegative(),
  text: z.string(),
});
export type EventDeltaFrame = z.infer<typeof EventDeltaFrame>;

/** SSE `event:` field values for the stream-only delta frames. */
export const StreamEventType = z.enum(["event_start", "event_delta"]);
export type StreamEventType = z.infer<typeof StreamEventType>;

/** A parsed SSE frame: the `event` line value + the `data` JSON payload. */
export const SseFrame = z.union([
  z.object({ event: z.literal("event_start"), data: EventStartFrame }),
  z.object({ event: z.literal("event_delta"), data: EventDeltaFrame }),
  // A buffered persisted event frame: `event` is the event type, `data` is the event.
  z.object({ event: z.string(), data: PersistedEvent, id: z.number().int().optional() }),
]);
export type SseFrame = z.infer<typeof SseFrame>;
