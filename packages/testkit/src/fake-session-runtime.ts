import type {
  EntryRange,
  InboundEvent,
  OutboundEvent,
  SessionEntry,
  SessionId,
  SessionRuntime,
  SessionStatus,
} from "@pi-managed/backend";

/**
 * In-memory fake `SessionRuntime` (spec §5.2, §5.4). Records sent events and replays
 * scripted outbound events. No real Pi `AgentSession` is created — this is a stub for
 * testing the session manager and events API against the seam.
 */
export class FakeSessionRuntime implements SessionRuntime {
  private _status: SessionStatus = "idle";
  private _woken: SessionId | undefined;
  private _inbound: InboundEvent[] = [];
  private _entries: SessionEntry[] = [];
  /** Outbound events queued for the next `subscribe()` consumer. */
  private outboundQueue: OutboundEvent[] = [];
  private waiter: ((e: OutboundEvent | null) => void) | null = null;
  private _interruptCount = 0;

  /** Script outbound events to emit to the next subscriber(s). */
  queueOutbound(...events: OutboundEvent[]): void {
    for (const e of events) this.outboundQueue.push(e);
    this.pumpWaiter();
  }

  private pumpWaiter(): void {
    if (this.waiter && this.outboundQueue.length > 0) {
      const e = this.outboundQueue.shift()!;
      const w = this.waiter;
      this.waiter = null;
      w(e);
    }
  }

  /** Seed the session log entries returned by `getEntries`. */
  seedEntries(entries: SessionEntry[]): void {
    this._entries = [...entries];
  }

  get wokenSession(): SessionId | undefined {
    return this._woken;
  }

  get inboundEvents(): readonly InboundEvent[] {
    return this._inbound;
  }

  get interruptCount(): number {
    return this._interruptCount;
  }

  async wake(sessionId: SessionId): Promise<void> {
    this._woken = sessionId;
    this._status = "idle";
  }

  async sendEvent(event: InboundEvent): Promise<void> {
    this._inbound.push(event);
    // `user.message` transitions to running; `user.interrupt` stays a side-effect.
    if (event.type === "user.message") this._status = "running";
  }

  subscribe(): AsyncIterable<OutboundEvent> {
    // Capture mutable state via lexical closures so the generator never aliases `this`.
    const queue = this.outboundQueue;
    const setWaiter = (w: ((e: OutboundEvent | null) => void) | null): void => {
      this.waiter = w;
    };
    const pump = (): void => this.pumpWaiter();
    async function* gen(): AsyncIterable<OutboundEvent> {
      // Drain anything already queued before subscription.
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

  async interrupt(): Promise<void> {
    this._interruptCount += 1;
    this._status = "idle";
  }

  async getEntries(range?: EntryRange): Promise<SessionEntry[]> {
    let slice = this._entries;
    if (range?.start !== undefined || range?.end !== undefined) {
      const start = range?.start ?? 0;
      const end = range?.end ?? slice.length;
      slice = slice.slice(start, end);
    }
    if (range?.limit !== undefined) slice = slice.slice(0, range.limit);
    return slice.map((e) => ({ ...e }));
  }

  status(): SessionStatus {
    return this._status;
  }

  /** Test helper: force a status transition (e.g. simulate `terminated`). */
  setStatus(status: SessionStatus): void {
    this._status = status;
  }
}
