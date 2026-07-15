/**
 * Thread runtime (WP-3.1, spec §18.2 / §18.6).
 *
 * A thread = its own `AgentSession` (per-thread context window + JSONL + event
 * stream), bound to its own sandbox (isolated) or a shared one (shared mode). This
 * wraps an {@link AgentSessionLike} (created by the {@link AgentSessionFactory}) and:
 *
 * - Emits the thread lifecycle events on its own outbound stream:
 *   `session.thread_created`, `thread_status_running`, `thread_status_idle`,
 *   `thread_status_terminated` (§18.6).
 * - Passes through `agent.*` events from the underlying session (condensed on the
 *   primary thread by the coordinator).
 * - Detects blocking requests (permission/custom-tool) and cross-posts them to the
 *   primary thread via the {@link ThreadCrossPostPort} (§18.7).
 *
 * The thread is **persistent**: `followUp()` re-uses the same `AgentSession`, so a
 * prior agent retains its turns when the coordinator sends a follow-up (§18.5).
 *
 * Blocking detection: the underlying AgentSession emits a synthetic
 * `{type: "blocking_request", toolCallId, toolName, input, kind}` event when a
 * permission-gate / custom-tool round-trip is needed (the permission-gate extension,
 * WP-2.3, produces this in production; tests script it via `FakeAgentSession.dispatch`).
 * The thread awaits the cross-posted response, then resumes.
 */

import type { OutboundEvent } from "../ports.js";
import type { AgentSessionEventLike } from "../session-manager/types.js";
import {
  threadCreatedEvent,
  threadStatusIdleEvent,
  threadStatusRunningEvent,
  threadStatusTerminatedEvent,
} from "../event-stream/thread-events.js";
import { generateEventId, nowIso } from "../event-stream/wire.js";
import type {
  CondensedThreadEvent,

  ThreadHandle,
  ThreadRunResult,
  ThreadRuntimeOptions,
  ThreadStatus,
} from "./types.js";

/** A per-thread AgentSession wrapper. One instance per spawned thread. */
export class ThreadRuntime implements ThreadHandle {
  private readonly opts: ThreadRuntimeOptions;
  private readonly outbound: OutboundEvent[] = [];
  private waiter: ((e: OutboundEvent | null) => void) | null = null;
  private statusValue: ThreadStatus = "idle";
  private messageBuffer = "";
  private lastOutput = "";
  private readonly unsubscribe: () => void;
  /**
   * Blocking round-trips cross-posted during the current turn that have NOT been
   * answered yet (§18.7). Recorded **synchronously** by {@link handleBlocking} before
   * it awaits the cross-post, so a turn that settles while a block is outstanding can
   * report `requires_action` + the pending ids (the await itself resolves later, on
   * the user's `user.tool_confirmation` / `user.custom_tool_result`).
   */
  private readonly unresolvedBlocks = new Set<string>();

  constructor(opts: ThreadRuntimeOptions) {
    this.opts = opts;
    this.unsubscribe = opts.session.subscribe((ev) => this.onPiEvent(ev));
    // §18.6: thread_created is emitted on construction (the coordinator forwards a
    // condensed form to the primary thread).
    this.emit(threadCreatedEvent(opts.threadId, opts.agentName));
    this.condensed({ kind: "started" });
  }

  get threadId(): string {
    return this.opts.threadId;
  }

  get agentName(): string {
    return this.opts.agentName;
  }

  get status(): ThreadStatus {
    return this.statusValue;
  }

  // -- ThreadHandle ----------------------------------------------------------

  subscribe(): AsyncIterable<OutboundEvent> {
    const queue = this.outbound;
    const setWaiter = (w: ((e: OutboundEvent | null) => void) | null): void => {
      this.waiter = w;
    };
    const pump = (): void => this.pumpWaiter();
    async function* gen(): AsyncIterable<OutboundEvent> {
      while (queue.length > 0) yield queue.shift()!;
      while (true) {
        const next = await new Promise<OutboundEvent | null>((resolve) => {
          setWaiter(resolve);
          pump();
        });
        if (next === null) break;
        yield next;
      }
    }
    return gen();
  }

  /** Run an initial task turn. */
  async run(task: string): Promise<ThreadRunResult> {
    return this.drive(task, "prompt");
  }

  /** Send a follow-up to a thread that retains its prior turns (§18.5 persistent). */
  async followUp(content: string): Promise<ThreadRunResult> {
    return this.drive(content, "followUp");
  }

  async interrupt(): Promise<void> {
    await this.opts.session.abort();
  }

  dispose(): void {
    this.statusValue = "terminated";
    this.unsubscribe();
    this.emit(threadStatusTerminatedEvent(this.opts.threadId));
    this.condensed({ kind: "terminated" });
    this.opts.session.dispose();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  // -- turn driving ----------------------------------------------------------

  private async drive(content: string, mode: "prompt" | "followUp"): Promise<ThreadRunResult> {
    if (this.statusValue === "terminated") {
      throw new Error(`ThreadRuntime: thread ${this.opts.threadId} is terminated`);
    }
    this.statusValue = "running";
    this.emit(threadStatusRunningEvent(this.opts.threadId));
    this.condensed({ kind: "started" });

    // Per-turn: only blocks raised during THIS turn gate its stop reason.
    this.unresolvedBlocks.clear();
    try {
      if (mode === "prompt") {
        await this.opts.session.prompt(content);
      } else {
        await this.opts.session.followUp(content);
      }
    } catch {
      // Surface as a terminated thread; the coordinator records the failure.
      this.statusValue = "terminated";
      this.emit(threadStatusTerminatedEvent(this.opts.threadId));
      this.condensed({ kind: "terminated" });
      return {
        threadId: this.opts.threadId,
        output: this.lastOutput,
        stopReason: "error",
        blockingEventIds: [...this.unresolvedBlocks],
      };
    }

    // The turn settled. Any block raised during it and still unanswered means the
    // thread is waiting on the user (cross-posted to the primary thread, §18.7).
    const blockingEventIds = [...this.unresolvedBlocks];
    const blocked = blockingEventIds.length > 0;
    const stopReason = blocked ? "requires_action" : "completed";
    this.statusValue = "idle";
    this.emit(
      threadStatusIdleEvent(
        this.opts.threadId,
        stopReason,
        blocked ? blockingEventIds : undefined,
      ),
    );
    this.condensed({
      kind: "idle",
      stopReason,
      ...(blocked ? { blockingEventIds } : {}),
    });
    return {
      threadId: this.opts.threadId,
      output: this.lastOutput,
      stopReason,
      blockingEventIds,
    };
  }

  // -- Pi event mapping ------------------------------------------------------

  private onPiEvent(event: AgentSessionEventLike): void {
    switch (event.type) {
      case "message_update": {
        const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (ame?.type === "text_delta" && ame.delta) this.messageBuffer += ame.delta;
        break;
      }
      case "message_end": {
        if (this.messageBuffer) {
          this.lastOutput = this.messageBuffer;
          this.emit(
            makeEvent("agent.message", { content: this.messageBuffer }),
          );
          this.messageBuffer = "";
        }
        break;
      }
      case "tool_execution_start": {
        const tool = String((event as { toolName?: unknown }).toolName ?? "unknown");
        this.emit(
          makeEvent("agent.tool_use", {
            tool,
            input: ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>,
          }),
        );
        break;
      }
      case "tool_execution_end": {
        const tool = String((event as { toolName?: unknown }).toolName ?? "unknown");
        this.emit(
          makeEvent("agent.tool_result", {
            tool,
            output: String((event as { output?: unknown }).output ?? ""),
          }),
        );
        break;
      }
      case "blocking_request": {
        void this.handleBlocking(event);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Handle a synthetic `blocking_request` from the underlying session: cross-post to
   * the primary thread and await the user's response. The promise resolves with the
   * decision/result; the coordinator (or permission-gate) resumes the tool.
   *
   * The pending id is recorded in {@link unresolvedBlocks} **before** the first await,
   * so it is visible to {@link drive} even if the turn settles while the user is still
   * deciding — that is what makes `stopReason: "requires_action"` reachable (§18.7).
   */
  private async handleBlocking(event: AgentSessionEventLike): Promise<void> {
    if (!this.opts.crossPost) return;
    const toolCallId = String((event as { toolCallId?: unknown }).toolCallId ?? "");
    const toolName = String((event as { toolName?: unknown }).toolName ?? "unknown");
    const input = ((event as { input?: unknown }).input ?? {}) as Record<string, unknown>;
    const kind = (event as { kind?: string }).kind === "custom_tool_result"
      ? "custom_tool_result"
      : "tool_confirmation";

    // -- synchronous, pre-await: the turn can settle at any point after this. --
    this.unresolvedBlocks.add(toolCallId);
    this.emit(
      threadStatusIdleEvent(this.opts.threadId, "requires_action", [toolCallId]),
    );
    this.condensed({
      kind: "blocking",
      stopReason: "requires_action",
      blockingEventIds: [toolCallId],
    });

    let res: BlockingResponseLike;
    try {
      res = await this.opts.crossPost.requestBlocking({
        sessionThreadId: this.opts.threadId,
        eventId: toolCallId,
        toolName,
        input,
        kind,
      });
    } finally {
      // Answered (or aborted) — it no longer blocks a future turn.
      this.unresolvedBlocks.delete(toolCallId);
    }
    // The resolved response is consumed by the permission-gate / custom-tool hook in
    // production. For tests, record it on the thread for assertion + steer the
    // session so the next turn sees the decision.
    this.lastBlockingResponse = res;
    const summary =
      res.kind === "tool_confirmation"
        ? `decision=${res.decision}${res.denyMessage ? ` (${res.denyMessage})` : ""}`
        : `result=${res.result ?? ""}`;
    try {
      await this.opts.session.steer(`[blocking-resolved] ${toolName} ${summary}`);
    } catch {
      /* best-effort steering */
    }
  }

  /** Inject an event on this thread's stream (inter-thread `received` messages). */
  inject(event: OutboundEvent): void {
    this.emit(event);
  }

  /** @internal test seam: the most recent blocking response routed to this thread. */
  lastBlockingResponse?: BlockingResponseLike;

  // -- outbound plumbing -----------------------------------------------------

  private emit(event: OutboundEvent): void {
    this.outbound.push(event);
    this.pumpWaiter();
  }

  private pumpWaiter(): void {
    if (this.waiter && this.outbound.length > 0) {
      const e = this.outbound.shift()!;
      const w = this.waiter;
      this.waiter = null;
      w(e);
    }
  }

  private condensed(
    over: Omit<CondensedThreadEvent, "sessionThreadId" | "agentName">,
  ): void {
    this.opts.onCondensed?.({
      sessionThreadId: this.opts.threadId,
      agentName: this.opts.agentName,
      ...over,
    });
  }
}

/** Minimal shape of a blocking response, for the test seam. */
type BlockingResponseLike = {
  kind: string;
  eventId: string;
  decision?: string;
  denyMessage?: string;
  result?: string;
};

function makeEvent(type: string, payload: Record<string, unknown>): OutboundEvent {
  return { type, id: generateEventId(), createdAt: nowIso(), payload };
}
