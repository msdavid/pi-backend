/**
 * Cross-posting of blocking events to the primary thread (WP-3.1, spec §18.7).
 *
 * When a child thread needs a permission/custom-tool result, it cannot surface that
 * round-trip on its own stream (the user only watches the *primary* thread). So the
 * blocking event is **cross-posted** to the primary thread, tagged with
 * `sessionThreadId` identifying the originating child. The user's
 * `user.tool_confirmation` / `user.custom_tool_result` response is then routed back
 * to the correct child by that id (§18.7).
 *
 * This mirrors the {@link ConfirmationCoordinator} pattern (WP-2.3) but is scoped to
 * the multiagent coordinator: one `CrossPostCoordinator` per primary thread, shared
 * across all children.
 */

import type { OutboundEvent } from "../ports.js";
import { generateEventId, nowIso } from "../event-stream/wire.js";
import type { BlockingResponse, BlockingThreadEvent } from "./types.js";

/**
 * Hooks the coordinator implements to surface cross-posted blocking events on the
 * PRIMARY thread's condensed stream (§18.7).
 */
export interface CrossPostHooks {
  /**
   * Emit a `session.status_idle` (requires_action) on the primary thread, carrying
   * the originating `sessionThreadId` + blocking event ids. Called whenever the
   * pending set changes.
   */
  emitPrimaryBlocking(events: readonly BlockingThreadEvent[]): void;
}

interface PendingEntry {
  req: BlockingThreadEvent;
  resolve: (response: BlockingResponse) => void;
}

/**
 * Coordinates cross-posted blocking round-trips for one multiagent session. Construct
 * per primary thread; share between child threads (producers) and the inbound
 * `user.tool_confirmation` / `user.custom_tool_result` router (consumer).
 */
export class CrossPostCoordinator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly hooks: CrossPostHooks;

  constructor(hooks: CrossPostHooks) {
    this.hooks = hooks;
  }

  /**
   * Register a blocking event from a child thread and cross-post it to the primary
   * thread. The returned promise resolves when the user responds (via
   * {@link applyToolConfirmation} / {@link applyCustomToolResult}) or the call is
   * aborted (via {@link abortAll}).
   */
  requestBlocking(req: BlockingThreadEvent): Promise<BlockingResponse> {
    return new Promise<BlockingResponse>((resolve) => {
      this.pending.set(req.eventId, { req, resolve });
      this.emitPrimary();
    });
  }

  /**
   * Route a `user.tool_confirmation` response to the originating child thread.
   * @returns `true` if a pending block matched `eventId`.
   */
  applyToolConfirmation(
    eventId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ): boolean {
    const entry = this.pending.get(eventId);
    if (!entry) return false;
    this.pending.delete(entry.req.eventId);
    entry.resolve({
      kind: "tool_confirmation",
      eventId,
      decision,
      ...(denyMessage ? { denyMessage } : {}),
    });
    if (this.pending.size > 0) this.emitPrimary();
    return true;
  }

  /**
   * Route a `user.custom_tool_result` response to the originating child thread.
   * @returns `true` if a pending block matched `customToolUseId`.
   */
  applyCustomToolResult(customToolUseId: string, result: string): boolean {
    const entry = this.pending.get(customToolUseId);
    if (!entry) return false;
    this.pending.delete(entry.req.eventId);
    entry.resolve({
      kind: "custom_tool_result",
      eventId: customToolUseId,
      result,
    });
    if (this.pending.size > 0) this.emitPrimary();
    return true;
  }

  /** Abort every pending block (e.g. on primary interrupt / teardown). */
  abortAll(reason = "Multiagent session interrupted"): void {
    if (this.pending.size === 0) return;
    for (const [, entry] of this.pending) {
      entry.resolve({
        kind: entry.req.kind,
        eventId: entry.req.eventId,
        decision: "deny",
        denyMessage: reason,
      });
    }
    this.pending.clear();
  }

  /** The currently-pending blocking events (cross-posted on the primary thread). */
  get pendingEvents(): readonly BlockingThreadEvent[] {
    return [...this.pending.values()].map((e) => e.req);
  }

  /** Number of blocking round-trips currently pending. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Is a given blocking event id still pending? */
  hasPending(eventId: string): boolean {
    return this.pending.has(eventId);
  }

  private emitPrimary(): void {
    const events = [...this.pending.values()].map((e) => e.req);
    if (events.length > 0) this.hooks.emitPrimaryBlocking(events);
  }
}

/**
 * Build the primary-thread `session.status_idle` (requires_action) payload for a set
 * of cross-posted blocking events. Each carries `sessionThreadId` so the client can
 * route its response (§18.7). Used by the coordinator's {@link CrossPostHooks}.
 */
export function primaryBlockingPayload(
  events: readonly BlockingThreadEvent[],
): Record<string, unknown> {
  return {
    stopReason: "requires_action",
    blockingEventIds: events.map((e) => e.eventId),
    blockingThreads: events.map((e) => ({
      sessionThreadId: e.sessionThreadId,
      eventId: e.eventId,
      toolName: e.toolName,
      kind: e.kind,
    })),
  };
}

/** Construct a primary-thread blocking `session.status_idle` outbound event. */
export function primaryBlockingEvent(
  events: readonly BlockingThreadEvent[],
): OutboundEvent {
  return {
    type: "session.status_idle",
    id: generateEventId(),
    createdAt: nowIso(),
    payload: primaryBlockingPayload(events),
  };
}
