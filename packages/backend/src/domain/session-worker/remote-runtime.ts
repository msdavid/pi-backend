/**
 * `RemoteSessionRuntime` — the parent-side proxy for a session that lives in a worker
 * child process (R7.1, `SESSION_WORKER_MODE=pool`).
 *
 * Implements the {@link SessionRuntime} port exactly as {@link ManagedSessionRuntime} does,
 * so every caller above the seam (routes, the Events API, the outcome runner, the
 * scheduler's `triggerSession`, the self-hosted tool-result sink) is unchanged: `wake` /
 * `sendEvent` / `interrupt` / `getEntries` become IPC RPCs; `subscribe()` is a local
 * fan-out over the outbound events the child streams up.
 *
 * **Events.** The child persists every outbound event to the `session_events` projection
 * itself (it holds its own Postgres pool and runs the *same* `ManagedSessionRuntime` write
 * path), and *additionally* streams the event to the parent for the live SSE fan-out. That
 * split is deliberate: the projection is the durability + numbering authority (R4.1/R4.2)
 * and keeping its write inside the runtime means pool mode and in-process mode persist
 * through identical code — no second writer, no re-numbering at the boundary. The IPC
 * stream is therefore *only* a transport for live subscribers; if a child dies with events
 * in flight, the SSE client reconnects and replays from the projection by position (the
 * same recovery path a network blip already uses).
 *
 * **status().** The port's `status()` is synchronous, so it cannot round-trip. The child
 * pushes its state on every transition and on every emitted event; this proxy answers from
 * that cache. Staleness is bounded by IPC latency (sub-millisecond, same host) and the DB
 * row written by the runtime's `saveStatus` (R2.8) remains the source of truth the routes
 * read — so nothing correctness-critical depends on this cache.
 */

import type {
  EntryRange,
  InboundEvent,
  OutboundEvent,
  SandboxHandle,
  SessionContext,
  SessionEntry,
  SessionId,
  SessionRuntime,
  SessionStatus,
} from "../ports.js";
import {
  STREAM_LAGGED,
  type PositionedOutboundEvent,
} from "../event-stream/stream.js";
import type { RemoteSessionState } from "./protocol.js";

/** One live SSE consumer of a remote session (mirrors the in-process fan-out, R4.2/R4.3). */
interface Subscriber {
  buffer: PositionedOutboundEvent[];
  waiter: ((e: PositionedOutboundEvent | null) => void) | null;
  lagFrom: number | null;
  closed: boolean;
}

/** The IPC transport the proxy talks through (implemented by the worker handle). */
export interface RemoteSessionTransport {
  wake(sessionId: SessionId): Promise<RemoteSessionState>;
  sendEvent(sessionId: SessionId, event: InboundEvent): Promise<void>;
  interrupt(sessionId: SessionId): Promise<void>;
  getEntries(sessionId: SessionId, range?: EntryRange): Promise<SessionEntry[]>;
  dispose(sessionId: SessionId): void;
}

export interface RemoteSessionRuntimeOptions {
  sessionId: SessionId;
  transport: RemoteSessionTransport;
  /** Per-subscriber outbound bound (R4.3). */
  maxOutboundEvents: number;
  /** PID of the worker child that owns this session (observability + tests). */
  workerPid: number | undefined;
}

export class RemoteSessionRuntime implements SessionRuntime {
  readonly sessionId: SessionId;
  /** PID of the owning worker child — `undefined` once the child is gone. */
  readonly workerPid: number | undefined;

  private readonly transport: RemoteSessionTransport;
  private readonly maxOutbound: number;
  private readonly subscribers = new Set<Subscriber>();
  private state: RemoteSessionState = { status: "idle" };
  /** Set when the owning child died (crash) or the proxy was disposed. */
  private dead = false;

  constructor(opts: RemoteSessionRuntimeOptions) {
    this.sessionId = opts.sessionId;
    this.transport = opts.transport;
    this.maxOutbound = opts.maxOutboundEvents;
    this.workerPid = opts.workerPid;
  }

  // -- SessionRuntime --------------------------------------------------------

  async wake(sessionId: SessionId): Promise<void> {
    this.state = await this.transport.wake(sessionId);
  }

  async sendEvent(event: InboundEvent): Promise<void> {
    this.assertAlive();
    await this.transport.sendEvent(this.sessionId, event);
  }

  async interrupt(): Promise<void> {
    this.assertAlive();
    await this.transport.interrupt(this.sessionId);
  }

  getEntries(range?: EntryRange): Promise<SessionEntry[]> {
    this.assertAlive();
    return this.transport.getEntries(this.sessionId, range);
  }

  status(): SessionStatus {
    return this.state.status;
  }

  subscribe(): AsyncIterable<OutboundEvent> {
    const sub: Subscriber = { buffer: [], waiter: null, lagFrom: null, closed: this.dead };
    this.subscribers.add(sub);
    const done: IteratorResult<OutboundEvent> = { done: true, value: undefined };
    const detach = (): void => {
      sub.waiter = null;
      this.subscribers.delete(sub);
    };
    const iterator: AsyncIterator<OutboundEvent> = {
      next: async (): Promise<IteratorResult<OutboundEvent>> => {
        const ready = this.takeFor(sub);
        if (ready) return { done: false, value: ready };
        if (sub.closed) {
          detach();
          return done;
        }
        const next = await new Promise<PositionedOutboundEvent | null>((resolve) => {
          sub.waiter = resolve;
          this.pump(sub);
        });
        if (next === null) {
          detach();
          return done;
        }
        return { done: false, value: next };
      },
      return: async (): Promise<IteratorResult<OutboundEvent>> => {
        sub.closed = true;
        const w = sub.waiter;
        sub.waiter = null;
        detach();
        w?.(null);
        return done;
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  // -- registry surface (parity with ManagedSessionRuntime) -------------------

  /** The bound microVM handle, as last reported by the child (R2.8). */
  get sandboxHandle(): SandboxHandle | undefined {
    return this.state.sandboxHandle;
  }

  /** The running session's re-resolution context (§12.5), as reported by the child. */
  get sessionContext(): SessionContext | undefined {
    return this.state.sessionContext;
  }

  /** Stop the remote runtime (best-effort IPC) and end every live subscriber. */
  dispose(): void {
    if (!this.dead) {
      this.transport.dispose(this.sessionId);
    }
    this.endSubscribers();
  }

  // -- pool-driven callbacks -------------------------------------------------

  /** An outbound event streamed up from the child: update state, fan out (R4.2/R4.3). */
  onRemoteEvent(event: PositionedOutboundEvent, state: RemoteSessionState): void {
    this.state = state;
    for (const sub of this.subscribers) {
      sub.buffer.push(event);
      while (sub.buffer.length > this.maxOutbound) {
        const dropped = sub.buffer.shift()!;
        if (sub.lagFrom === null && dropped.position !== undefined) {
          sub.lagFrom = dropped.position;
        }
      }
      this.pump(sub);
    }
  }

  /** A state push from the child (status / sandbox-handle transition). */
  onRemoteState(state: RemoteSessionState): void {
    this.state = state;
  }

  /**
   * The owning child died (R7.1 crash detection). The session is NOT lost: its sandbox
   * handle + status are persisted (R2.8) and its detached VM survives, so the pool drops
   * this proxy and the next `getOrCreate` re-wakes the session on the respawned worker,
   * which re-attaches the surviving VM through the same boot-reattach path (R2.9).
   */
  onWorkerCrashed(): void {
    this.dead = true;
    this.endSubscribers();
  }

  /** Whether the owning child is gone. */
  get isLost(): boolean {
    return this.dead;
  }

  // -- internals -------------------------------------------------------------

  private assertAlive(): void {
    if (this.dead) {
      throw new Error(
        `session worker for ${this.sessionId} is gone; the session will re-wake on the ` +
          `next getOrCreate`,
      );
    }
  }

  private endSubscribers(): void {
    for (const sub of this.subscribers) {
      sub.closed = true;
      if (sub.waiter) {
        const w = sub.waiter;
        sub.waiter = null;
        w(null);
      }
    }
  }

  private takeFor(sub: Subscriber): PositionedOutboundEvent | undefined {
    if (sub.lagFrom !== null) {
      const fromPosition = sub.lagFrom;
      sub.lagFrom = null;
      return {
        type: STREAM_LAGGED,
        id: `evt_${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        payload: { fromPosition },
      };
    }
    return sub.buffer.shift();
  }

  private pump(sub: Subscriber): void {
    if (!sub.waiter) return;
    const next = this.takeFor(sub);
    if (!next) return;
    const w = sub.waiter;
    sub.waiter = null;
    w(next);
  }
}
