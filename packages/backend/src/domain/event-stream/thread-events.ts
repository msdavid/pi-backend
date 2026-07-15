/**
 * Thread-event glue (WP-3.1, §18.6).
 *
 * Constructors for the multiagent thread lifecycle + inter-thread message events,
 * in the ports {@link OutboundEvent} shape (`{type, id, createdAt, payload}`). The
 * runtime emits these on the *primary* thread's condensed view (and each child
 * thread's own stream). They serialize generically via {@link outboundWireData}
 * (which spreads `payload`), so no other event-stream module needs to change.
 *
 * Thread event types (§18.6):
 * - `session.thread_created` — a child thread was created.
 * - `thread_status_running` / `thread_status_idle` / `thread_status_terminated` —
 *   the per-thread lifecycle (condensed on the primary thread).
 * - `agent.thread_message_received` / `agent.thread_message_sent` — inter-thread
 *   messages (§18.5), carrying `from`/`to` fields.
 *
 * This module is intentionally minimal: it only shapes payloads. The orchestration
 * that *emits* these events lives in `domain/multiagent/`.
 */

import type { OutboundEvent } from "../ports.js";
import { generateEventId, nowIso } from "./wire.js";

/** A thread id is a session id (each thread is its own AgentSession). */
export type ThreadId = string;

/** Create a `session.thread_created` outbound event. */
export function threadCreatedEvent(
  threadId: ThreadId,
  agentName: string,
): OutboundEvent {
  return make("session.thread_created", { sessionThreadId: threadId, agentName });
}

/** Create a `thread_status_running` outbound event. */
export function threadStatusRunningEvent(threadId: ThreadId): OutboundEvent {
  return make("thread_status_running", { sessionThreadId: threadId });
}

/** Create a `thread_status_idle` outbound event (a child thread finished a turn). */
export function threadStatusIdleEvent(
  threadId: ThreadId,
  stopReason?: string,
  blockingEventIds?: readonly string[],
): OutboundEvent {
  return make("thread_status_idle", {
    sessionThreadId: threadId,
    ...(stopReason ? { stopReason } : {}),
    ...(blockingEventIds && blockingEventIds.length > 0
      ? { blockingEventIds: [...blockingEventIds] }
      : {}),
  });
}

/** Create a `thread_status_terminated` outbound event. */
export function threadStatusTerminatedEvent(threadId: ThreadId): OutboundEvent {
  return make("thread_status_terminated", { sessionThreadId: threadId });
}

/**
 * Create an `agent.thread_message_received` outbound event (§18.5). Emitted on the
 * *receiving* thread's stream; carries the sender's thread id + agent name + content.
 */
export function threadMessageReceivedEvent(
  fromSessionThreadId: ThreadId,
  fromAgentName: string,
  toSessionThreadId: ThreadId,
  toAgentName: string,
  content: string,
): OutboundEvent {
  return make("agent.thread_message_received", {
    fromSessionThreadId,
    fromAgentName,
    toSessionThreadId,
    toAgentName,
    content,
  });
}

/**
 * Create an `agent.thread_message_sent` outbound event (§18.5). Emitted on the
 * *sending* thread's stream; mirrors the received payload.
 */
export function threadMessageSentEvent(
  fromSessionThreadId: ThreadId,
  fromAgentName: string,
  toSessionThreadId: ThreadId,
  toAgentName: string,
  content: string,
): OutboundEvent {
  return make("agent.thread_message_sent", {
    fromSessionThreadId,
    fromAgentName,
    toSessionThreadId,
    toAgentName,
    content,
  });
}

function make(type: string, payload: Record<string, unknown>): OutboundEvent {
  return { type, id: generateEventId(), createdAt: nowIso(), payload };
}
