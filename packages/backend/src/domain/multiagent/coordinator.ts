/**
 * Multiagent coordinator (WP-3.1, spec §18).
 *
 * Owns the *primary* thread (the user-facing session, loaded with the subagent
 * extension) and spawns *child* threads for delegated work. Spawning follows the Pi
 * subagent example: single / parallel / chain modes. Child threads are exactly ONE
 * level deep (§18.2) — their materials carry NO subagent extensionFactories, so a
 * child cannot itself delegate (depth > 1 is structurally impossible).
 *
 * Responsibilities:
 * - Resolve + freeze the roster (snapshot-at-creation, §18.3).
 * - Spawn child threads via the {@link AgentSessionFactory} (each its own
 *   `AgentSession` + sandbox, per the shared/isolated mode, §18.4).
 * - Fan out parallel / sequential / chain work and synthesize results.
 * - Maintain a **condensed primary view** of all child activity (start / idle /
 *   terminated / blocking / inter-thread messages) on the primary thread's stream.
 * - Route inter-thread messages (§18.5) and cross-posted blocking round-trips (§18.7).
 * - Enforce ≤25 concurrently-*running* threads (§18.2) + the node-wide live-thread
 *   budget (R6.4), and release every sandbox handle it allocated.
 */

import { ApiError } from "../errors.js";
import type { OutboundEvent, SandboxHandle } from "../ports.js";
import type {
  AgentSessionFactory,
  AgentSessionLike,
} from "../session-manager/types.js";
import { generateEventId, nowIso } from "../event-stream/wire.js";
import { deliverThreadMessage } from "./messaging.js";
import {
  CrossPostCoordinator,
  primaryBlockingEvent,
  type CrossPostHooks,
} from "./cross-posting.js";
import { ThreadRuntime } from "./thread.js";
import { canDelegate } from "./roster.js";
import type {
  MultiagentMode,
  ResolvedRosterEntry,
  ResolvedThreadMaterial,
  ThreadHandle,
  ThreadId,
  ThreadMessage,
  ThreadRunResult,
} from "./types.js";
import type { SandboxAllocator } from "./modes.js";
import { MAX_CONCURRENT_THREADS, MAX_THREADS_PER_NODE } from "./types.js";

/**
 * A node-wide ceiling on *live* (spawned, not yet disposed) threads (R6.4).
 *
 * The §18.2 cap is per-coordinator, so N concurrent sessions can each hold 25 threads
 * — each one a live `AgentSession` in this node's single heap (R7.1). This budget is
 * the backstop: spawning past it fails the delegation with 429 rather than OOM-ing
 * every tenant on the node. Reserved BEFORE the session is created and released when
 * the thread is disposed.
 */
export class ThreadBudget {
  private used = 0;

  constructor(private readonly max: number = MAX_THREADS_PER_NODE) {}

  /** Reserve `n` thread slots, or throw 429 if the node is at capacity. */
  acquire(n = 1): void {
    if (this.used + n > this.max) {
      throw new ApiError(
        429,
        "rate_limited",
        `node thread budget exhausted: ${this.used} + ${n} > ${this.max}`,
      );
    }
    this.used += n;
  }

  /** Return `n` thread slots to the node budget (idempotent-safe, floors at 0). */
  release(n = 1): void {
    this.used = Math.max(0, this.used - n);
  }

  /** Live threads currently charged to this budget. */
  get inUse(): number {
    return this.used;
  }

  /** Remaining capacity. */
  get available(): number {
    return this.max - this.used;
  }
}

/** The process-wide default budget (one Node process per node until R7.1). */
export const nodeThreadBudget = new ThreadBudget();

/** A live thread + the sandbox handle allocated for it (so it can be released). */
interface ThreadEntry {
  thread: ThreadHandle;
  sandboxHandle: SandboxHandle;
  /** Shared handles are owned by the coordinator and released exactly once. */
  shared: boolean;
}

/** A task for parallel fan-out. */
export interface SubagentTask {
  /** Roster slot name (matches a `ResolvedRosterEntry.name`). */
  agent: string;
  task: string;
}

/** A step in a chain (the `{previous}` placeholder is replaced with prior output). */
export interface ChainStep extends SubagentTask {
  /** Task text; `{previous}` is replaced with the previous step's output. */
  task: string;
}

/** A completed subagent result (condensed for the primary view). */
export interface SubagentResult {
  agent: string;
  task: string;
  output: string;
  stopReason: string;
  isError: boolean;
  threadId: ThreadId;
}

/** Options to construct a {@link SubagentCoordinator}. */
export interface SubagentCoordinatorOptions {
  /** Frozen roster (snapshot-at-creation). */
  roster: ResolvedRosterEntry[];
  /** Execution mode (§18.4). */
  mode: MultiagentMode;
  /** Factory that builds each child thread's AgentSession. */
  factory: AgentSessionFactory;
  /** Sandbox allocator (shared or isolated). */
  sandboxAllocator: SandboxAllocator;
  /**
   * Resolves the material for a roster slot (config + provider keys + cwd + vault
   * ids). In shared mode, the vault ids + provider keys are the shared set; in
   * isolated mode, per-thread. The coordinator passes the slot + mode; the caller
   * decides the actual resolution (vault first-match-wins is in the SecretStore,
   * §12.6).
   */
  resolveMaterial: (slot: ResolvedRosterEntry, mode: MultiagentMode) => ResolvedThreadMaterial;
  /** The primary thread's agent name (for inter-thread message routing). */
  primaryAgentName: string;
  /** The primary thread's id (the user-facing session). */
  primaryThreadId: ThreadId;
  /**
   * Node-wide live-thread budget (R6.4). Defaults to the process-wide
   * {@link nodeThreadBudget}; tests inject a small one.
   */
  threadBudget?: ThreadBudget;
}

/**
 * The multiagent coordinator. Construct one per primary session that has a non-empty
 * roster. Exposes the subagent operations the Pi extension calls, plus the inbound
 * blocking routers (`applyToolConfirmation` / `applyCustomToolResult`) and inter-thread
 * messaging.
 */
export class SubagentCoordinator {
  private readonly opts: SubagentCoordinatorOptions;
  /**
   * Every spawned, not-yet-disposed thread, keyed by id. This is the **addressable**
   * map (`sendMessage` targets a thread here long after its first turn settled —
   * threads are persistent, §18.5). It is NOT the concurrency count: a finished thread
   * stays here holding zero concurrency slots.
   */
  private readonly threads = new Map<ThreadId, ThreadEntry>();
  /** Threads with an in-flight turn (observable; drives {@link runningThreadIds}). */
  private readonly running = new Set<ThreadId>();
  /**
   * Turns admitted by {@link admit} and not yet settled — the number the §18.2 ≤25 cap
   * is measured against. Counted from admission (not from thread creation) so a fan-out
   * cannot slip past the cap while every spawn is still in flight, and decremented
   * exactly once per admitted turn.
   */
  private inFlightTurns = 0;
  private readonly slotByName = new Map<string, ResolvedRosterEntry>();
  private readonly crossPost: CrossPostCoordinator;
  private readonly budget: ThreadBudget;
  /** Monotonic spawn counter — the JSONL filename discriminator (see {@link runOne}). */
  private threadSeq = 0;
  /** The shared-mode sandbox handle (allocated once, released once at dispose). */
  private sharedSandbox: SandboxHandle | undefined;
  private disposed = false;
  /** The primary thread's condensed outbound stream. */
  private readonly primaryOutbound: OutboundEvent[] = [];
  private primaryWaiter: ((e: OutboundEvent | null) => void) | null = null;

  constructor(opts: SubagentCoordinatorOptions) {
    this.opts = opts;
    this.budget = opts.threadBudget ?? nodeThreadBudget;
    for (const slot of opts.roster) this.slotByName.set(slot.name, slot);

    const hooks: CrossPostHooks = {
      emitPrimaryBlocking: (events) => {
        this.emitPrimary(primaryBlockingEvent(events));
      },
    };
    this.crossPost = new CrossPostCoordinator(hooks);
  }

  // -- primary condensed view ------------------------------------------------

  /** The primary thread's condensed outbound stream (start/idle/blocking/messages). */
  subscribe(): AsyncIterable<OutboundEvent> {
    const queue = this.primaryOutbound;
    const setWaiter = (w: ((e: OutboundEvent | null) => void) | null): void => {
      this.primaryWaiter = w;
    };
    const pump = (): void => this.pumpPrimary();
    // Checked before parking: dispose() can land while the consumer is between
    // iterations (no waiter registered to signal), which would otherwise park it on a
    // promise nobody will ever resolve.
    const isDisposed = (): boolean => this.disposed;
    async function* gen(): AsyncIterable<OutboundEvent> {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (isDisposed()) break;
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

  /** The cross-post coordinator (for the inbound event router / tests). */
  get crossPostCoordinator(): CrossPostCoordinator {
    return this.crossPost;
  }

  /**
   * Threads with an in-flight turn — what the §18.2 ≤25 cap counts (R6.4: it used to
   * count every thread ever spawned, so the 26th delegation of a session's *lifetime*
   * 429'd with nothing running).
   */
  get activeThreadCount(): number {
    return this.inFlightTurns;
  }

  /** Spawned, not-yet-disposed threads (addressable via {@link sendMessage}). */
  get liveThreadCount(): number {
    return this.threads.size;
  }

  /** Ids of threads currently mid-turn. */
  get runningThreadIds(): readonly ThreadId[] {
    return [...this.running];
  }

  // -- subagent operations (single / parallel / chain) -----------------------

  /** Run a single subagent. */
  async runSingle(agent: string, task: string): Promise<SubagentResult> {
    const [r] = await this.runParallel([{ agent, task }]);
    return r;
  }

  /**
   * Fan out to N parallel subagents + synthesize (§18.2, §29.4 gate slice). Each
   * task runs in its own thread; results are collected in input order. The primary
   * thread sees a condensed start/idle per child.
   */
  async runParallel(tasks: SubagentTask[]): Promise<SubagentResult[]> {
    if (tasks.length === 0) return [];
    // Admit the whole fan-out up front: all N turns are concurrent.
    this.admit(tasks.length);
    const results = await Promise.all(
      tasks.map((t) => this.runOne(t.agent, t.task)),
    );
    return results;
  }

  /**
   * Run a chain: each step's `{previous}` placeholder is replaced with the prior
   * step's output (sequential). Stops on the first error.
   */
  async runChain(steps: ChainStep[]): Promise<SubagentResult[]> {
    if (steps.length === 0) return [];
    const results: SubagentResult[] = [];
    let previous = "";
    for (const step of steps) {
      // A chain is sequential: exactly one turn is in flight at a time, so each step
      // is admitted on its own (a 30-step chain is not 30 concurrent threads).
      this.admit(1);
      const task = step.task.replace(/\{previous\}/g, previous);
      const r = await this.runOne(step.agent, task);
      results.push(r);
      if (r.isError) break;
      previous = r.output;
    }
    return results;
  }

  // -- inter-thread messaging (§18.5) ----------------------------------------

  /**
   * Send a follow-up message from the primary thread to a previously-spawned child
   * thread. The child retains its prior turns (persistent thread). Emits
   * `agent.thread_message_sent` on the primary + `agent.thread_message_received` on
   * the child (§18.5).
   */
  async sendMessage(toThreadId: ThreadId, content: string): Promise<ThreadRunResult> {
    const entry = this.threads.get(toThreadId);
    if (!entry) {
      throw new ApiError(404, "not_found", `thread not found: ${toThreadId}`);
    }
    const child = entry.thread;
    this.admit(1);
    const msg: ThreadMessage = {
      fromSessionThreadId: this.opts.primaryThreadId,
      fromAgentName: this.opts.primaryAgentName,
      toSessionThreadId: toThreadId,
      toAgentName: child.agentName,
      content,
    };
    deliverThreadMessage({
      message: msg,
      receiverSink: { emit: (e) => child.inject(e) },
      senderSink: { emit: (e) => this.emitPrimary(e) },
    });
    // Drive the child's follow-up turn (persistent — reuses its AgentSession).
    this.running.add(toThreadId);
    try {
      return await child.followUp(content);
    } finally {
      this.running.delete(toThreadId);
      this.settle();
    }
  }

  // -- inbound blocking routers (§18.7) --------------------------------------

  /** Route a `user.tool_confirmation` to the originating child thread. */
  applyToolConfirmation(
    eventId: string,
    decision: "allow" | "deny",
    denyMessage?: string,
  ): boolean {
    return this.crossPost.applyToolConfirmation(eventId, decision, denyMessage);
  }

  /** Route a `user.custom_tool_result` to the originating child thread. */
  applyCustomToolResult(customToolUseId: string, result: string): boolean {
    return this.crossPost.applyCustomToolResult(customToolUseId, result);
  }

  /** Abort all pending blocking round-trips (primary interrupt / teardown). */
  abortAllBlocking(reason?: string): void {
    this.crossPost.abortAll(reason);
  }

  /**
   * Dispose one child thread: terminate its `AgentSession`, return its node-budget
   * slot, and release its sandbox if it owns one (isolated mode). The shared handle is
   * NOT released here — it belongs to the coordinator (§18.4) and is released exactly
   * once by {@link dispose}.
   */
  async disposeThread(threadId: ThreadId): Promise<boolean> {
    const entry = this.threads.get(threadId);
    if (!entry) return false;
    this.threads.delete(threadId);
    this.running.delete(threadId);
    entry.thread.dispose();
    this.budget.release();
    if (!entry.shared) {
      await this.opts.sandboxAllocator.release(entry.sandboxHandle);
    }
    return true;
  }

  /**
   * Dispose all child threads + release every sandbox handle allocated (R6.4: the
   * allocated handle used to be stored and never released — one leaked microVM per
   * isolated thread, and the shared VM leaked for the session's whole lifetime).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const threadId of [...this.threads.keys()]) {
      await this.disposeThread(threadId);
    }
    // The shared handle is coordinator-owned: released exactly once, here.
    if (this.sharedSandbox) {
      const handle = this.sharedSandbox;
      this.sharedSandbox = undefined;
      await this.opts.sandboxAllocator.release(handle);
    }
    this.crossPost.abortAll("coordinator disposed");
    if (this.primaryWaiter) {
      const w = this.primaryWaiter;
      this.primaryWaiter = null;
      w(null);
    }
  }

  // -- internals -------------------------------------------------------------

  /**
   * Spawn + run one child thread for `agent`/`task`. The caller must have {@link admit}ted
   * this turn; it settles exactly once here, whatever the outcome.
   */
  private async runOne(agent: string, task: string): Promise<SubagentResult> {
    try {
      return await this.spawnAndRun(agent, task);
    } finally {
      this.settle();
    }
  }

  private async spawnAndRun(agent: string, task: string): Promise<SubagentResult> {
    const slot = this.slotByName.get(agent);
    if (!slot) {
      throw new ApiError(
        422,
        "invalid_request",
        `unknown roster agent "${agent}"; known: ${[...this.slotByName.keys()].join(", ")}`,
      );
    }
    // §18.2: depth-1-only. Child threads do not load the subagent extension.
    if (!canDelegate(true)) {
      throw new Error("SubagentCoordinator: delegation not enabled (depth > 1)");
    }

    const material = this.opts.resolveMaterial(slot, this.opts.mode);
    // R6.4: the JSONL path discriminator is a monotonic counter taken BEFORE the
    // spawn — `threads.size` was read at spawn time, so two threads racing under
    // `runParallel`'s Promise.all both saw the same size and wrote the SAME file
    // (interleaved JSONL ⇒ corrupt transcripts for both).
    const seq = ++this.threadSeq;
    const localJsonlPath = `${material.cwd}/.pi/sessions/thread-${slot.resolvedAgentId}-${seq}.jsonl`;

    // Reserve a node-wide slot before allocating anything real (R6.4 RAM budget).
    this.budget.acquire();
    let session: AgentSessionLike;
    try {
      session = await this.opts.factory.create({
        material: {
          agentConfig: material.agentConfig,
          providerKeys: material.providerKeys,
          cwd: material.cwd,
          ...(material.systemPromptOverride
            ? { systemPromptOverride: material.systemPromptOverride }
            : {}),
          // §18.2 depth-1: NO extensionFactories (subagent extension omitted) so the
          // child cannot delegate. Depth > 1 is structurally impossible.
        },
        localJsonlPath,
      });
    } catch (err) {
      this.budget.release();
      throw err;
    }

    let allocated;
    try {
      allocated = await this.opts.sandboxAllocator.allocate({
        mode: this.opts.mode,
        threadId: localJsonlPath,
        material,
      });
    } catch (err) {
      session.dispose();
      this.budget.release();
      throw err;
    }
    if (allocated.shared) this.sharedSandbox = allocated.handle;

    const threadId = `thread_${session.sessionId}`;
    const thread = new ThreadRuntime({
      threadId,
      agentName: agent,
      session,
      localJsonlPath,
      sandboxHandle: allocated.handle,
      crossPost: this.crossPost,
      onCondensed: (ev) => this.forwardCondensed(ev),
    });
    this.threads.set(threadId, {
      thread,
      sandboxHandle: allocated.handle,
      shared: allocated.shared,
    });

    this.running.add(threadId);
    let result: ThreadRunResult;
    try {
      result = await thread.run(task);
    } finally {
      this.running.delete(threadId);
    }
    const isError = result.stopReason === "error" || result.stopReason === "terminated";
    return {
      agent,
      task,
      output: result.output,
      stopReason: result.stopReason,
      isError,
      threadId,
    };
  }

  /** Forward a condensed child event to the primary stream (§18.6 condensed view). */
  private forwardCondensed(
    ev: import("./types.js").CondensedThreadEvent,
  ): void {
    // The condensed view: only start / idle / terminated / blocking / message
    // boundaries are forwarded (not every tool call / token). The ThreadRuntime
    // already emits the thread_status_* events on its own stream; here we re-emit a
    // condensed marker on the PRIMARY stream so the user sees a summary.
    const type =
      ev.kind === "started"
        ? "thread_status_running"
        : ev.kind === "idle"
          ? "thread_status_idle"
          : ev.kind === "terminated"
            ? "thread_status_terminated"
            : ev.kind === "blocking"
              ? "session.status_idle"
              : "agent.thread_message_received";
    this.emitPrimary({
      type,
      id: generateEventId(),
      createdAt: nowIso(),
      payload: {
        sessionThreadId: ev.sessionThreadId,
        agentName: ev.agentName,
        ...(ev.stopReason ? { stopReason: ev.stopReason } : {}),
        ...(ev.blockingEventIds ? { blockingEventIds: [...ev.blockingEventIds] } : {}),
      },
    });
  }

  /** Emit an event on a child thread's stream (for inter-thread messages). */
  // (Inter-thread `received` events are injected directly via ThreadHandle.inject;
  // this hook is retained for future direct-injection paths.)

  private emitPrimary(event: OutboundEvent): void {
    this.primaryOutbound.push(event);
    this.pumpPrimary();
  }

  private pumpPrimary(): void {
    if (this.primaryWaiter && this.primaryOutbound.length > 0) {
      const e = this.primaryOutbound.shift()!;
      const w = this.primaryWaiter;
      this.primaryWaiter = null;
      w(e);
    }
  }

  /**
   * Admit `n` concurrent turns, or throw 429 (§18.2 ≤25).
   *
   * R6.4: this counted `threads.size` — every thread *ever spawned*, since entries were
   * never removed — so the 26th delegation in a session's lifetime threw 429 with zero
   * threads actually running. It now counts only in-flight turns; finished threads stay
   * addressable (persistent, §18.5) at zero concurrency cost, bounded instead by the
   * node-wide {@link ThreadBudget}.
   */
  private admit(n: number): void {
    if (this.disposed) {
      throw new ApiError(409, "conflict", "multiagent coordinator is disposed");
    }
    if (this.inFlightTurns + n > MAX_CONCURRENT_THREADS) {
      throw new ApiError(
        429,
        "rate_limited",
        `multiagent concurrency cap exceeded: ${this.inFlightTurns} running + ${n} > ${MAX_CONCURRENT_THREADS} (§18.2)`,
      );
    }
    this.inFlightTurns += n;
  }

  /** Settle exactly one admitted turn. */
  private settle(): void {
    this.inFlightTurns = Math.max(0, this.inFlightTurns - 1);
  }
}

/** Re-export the session-factory seam type for the extension's convenience. */
export type { AgentSessionLike };
