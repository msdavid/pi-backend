/**
 * Inter-thread messaging (WP-3.1, spec §18.5).
 *
 * The coordinator sends a message from one thread to another; the receiver's stream
 * gets `agent.thread_message_received` (with `fromSessionThreadId`/`fromAgentName` +
 * `content`) and the sender's stream gets `agent.thread_message_sent` (with
 * `toSessionThreadId`/`toAgentName` + `content`).
 *
 * Threads are **persistent**: the coordinator can send a follow-up to an agent it
 * called earlier, and that agent retains its prior turns (the underlying
 * `AgentSession` is reused via `followUp`). This module only shapes + routes the
 * message events; the actual `followUp` is driven by the coordinator.
 */

import type { OutboundEvent } from "../ports.js";
import {
  threadMessageReceivedEvent,
  threadMessageSentEvent,
} from "../event-stream/thread-events.js";
import type { ThreadMessage } from "./types.js";

/** A sink that accepts an outbound event on a thread's stream. */
export interface ThreadEventSink {
  emit(event: OutboundEvent): void;
}

/** Options for {@link deliverThreadMessage}. */
export interface DeliverMessageOptions {
  message: ThreadMessage;
  /** Sink for the receiving thread (emits `agent.thread_message_received`). */
  receiverSink: ThreadEventSink;
  /** Sink for the sending thread (emits `agent.thread_message_sent`). */
  senderSink: ThreadEventSink;
}

/**
 * Deliver an inter-thread message: emit `agent.thread_message_sent` on the sender's
 * stream and `agent.thread_message_received` on the receiver's stream (§18.5). Both
 * events carry the full from/to routing so the primary condensed view can correlate.
 *
 * @returns the two emitted events (for assertions / primary forwarding).
 */
export function deliverThreadMessage(
  opts: DeliverMessageOptions,
): { sent: OutboundEvent; received: OutboundEvent } {
  const { message, receiverSink, senderSink } = opts;
  const sent = threadMessageSentEvent(
    message.fromSessionThreadId,
    message.fromAgentName,
    message.toSessionThreadId,
    message.toAgentName,
    message.content,
  );
  const received = threadMessageReceivedEvent(
    message.fromSessionThreadId,
    message.fromAgentName,
    message.toSessionThreadId,
    message.toAgentName,
    message.content,
  );
  senderSink.emit(sent);
  receiverSink.emit(received);
  return { sent, received };
}
