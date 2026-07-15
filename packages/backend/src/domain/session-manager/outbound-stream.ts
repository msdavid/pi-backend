/**
 * Outbound event stream (R4.1–R4.3) — extracted from {@link ManagedSessionRuntime}.
 *
 * Owns the single responsibility of turning the runtime's emitted events into a coherent,
 * DB-authoritative, multi-consumer live tail:
 *
 * - **One numbered universe (R4.1).** {@link emit} persists to the `session_events`
 *   projection FIRST, then fans out with the position the projection assigns — the SSE `id`
 *   (§9.3). There is no second in-memory counter to drift from the persisted positions; a
 *   failed append drops the event from both the live tail and history consistently.
 * - **Per-subscriber fan-out (R4.2).** Every {@link subscribe} call gets its OWN buffer +
 *   waiter, so N concurrent SSE clients each receive EVERY event.
 * - **Bounded backpressure (R4.3).** A slow subscriber's oldest events are dropped and it is
 *   handed a synthetic {@link STREAM_LAGGED} notice naming the gap's start position.
 *
 * The runtime composes one of these, {@link bind}s it to the session's projection + record at
 * wake, and delegates `emit`/`subscribe`/`disposeSubscribers` to it.
 */

import { randomUUID } from "node:crypto";
import type { OutboundEvent } from "../ports.js";
import type { SessionRecord } from "./types.js";
import type { SessionEventsStore } from "./session-events-store.js";
import { STREAM_LAGGED, type PositionedOutboundEvent } from "../event-stream/stream.js";
import { now, delay } from "./runtime-helpers.js";

/** A single live consumer's queue state. */
interface Subscriber {
  /** This consumer's bounded buffer (oldest first). */
  buffer: PositionedOutboundEvent[];
  /** The pending `next()` resolver, when the consumer is awaiting an event. */
  waiter: ((e: PositionedOutboundEvent | null) => void) | null;
  /**
   * The projection position of the OLDEST dropped event not yet reported to this consumer,
   * or `null` when it is not lagging (R4.3). Reported once, then cleared.
   */
  lagFrom: number | null;
  /** Set on dispose: the iterator drains what it has, then ends. */
  closed: boolean;
}

export class OutboundEventStream {
  private readonly subscribers = new Set<Subscriber>();
  /** Serializes projection appends so persisted positions preserve emit order. */
  private appendChain: Promise<unknown> = Promise.resolve();
  /** Fallback counter used ONLY when no projection is wired (a unit-test seam). */
  private localPosition = 0;
  private events: SessionEventsStore | undefined;
  private record: SessionRecord | undefined;

  constructor(private readonly maxOutbound: number) {}

  /**
   * Bind to the session's projection + record at wake. The projection is the single source
   * of the SSE `id`; resetting the local fallback keeps the no-projection path deterministic.
   */
  bind(events: SessionEventsStore | undefined, record: SessionRecord): void {
    this.events = events;
    this.record = record;
    this.localPosition = 0;
  }

  /** Emit an outbound event: persist (R4.1) then fan out with the assigned position. */
  emit(type: string, payload: Record<string, unknown> = {}): void {
    const base: OutboundEvent = {
      type,
      id: `evt_${randomUUID()}`,
      createdAt: now(),
      payload,
    };
    this.appendChain = this.appendChain
      .then(() => this.persistAndFanOut(base))
      .catch(() => {
        /* persistAndFanOut handles its own failure; keep the chain link alive */
      });
  }

  /**
   * Subscribe to the live tail (R4.2 — broadcast, not a shared queue). Every call gets its
   * own subscriber; the subscriber is detached when the iterator returns (client disconnect)
   * or the runtime is disposed.
   */
  subscribe(): AsyncIterable<OutboundEvent> {
    const sub: Subscriber = { buffer: [], waiter: null, lagFrom: null, closed: false };
    this.subscribers.add(sub);
    const done: IteratorResult<OutboundEvent> = { done: true, value: undefined };
    const detach = (): void => {
      sub.waiter = null;
      this.subscribers.delete(sub);
    };
    // Hand-rolled (not an async generator): `return()` must detach a disconnected SSE
    // client IMMEDIATELY. A generator suspended at an `await` cannot be interrupted — it
    // would keep its buffer alive until the next emit.
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

  /** End every live subscriber (each drains what it has, then its iterator returns). */
  disposeSubscribers(): void {
    for (const sub of this.subscribers) {
      sub.closed = true;
      if (sub.waiter) {
        const w = sub.waiter;
        sub.waiter = null;
        w(null);
      }
    }
  }

  /**
   * Persist `base` to the projection then fan it out stamped with the assigned position —
   * the authoritative SSE `id` (§9.3). Without a projection (a unit-test seam) a local
   * monotonic counter stands in. A persistent append failure drops the event from BOTH the
   * live tail and history consistently (the next event still gets a contiguous position).
   */
  private async persistAndFanOut(base: OutboundEvent): Promise<void> {
    let position: number;
    if (this.events && this.record) {
      position = await this.appendWithRetry(this.events, this.record, base);
    } else {
      position = this.localPosition++;
    }
    this.fanOut({ ...base, position });
  }

  /** Append to the projection, retrying transient DB failures a few times before giving up. */
  private async appendWithRetry(
    store: SessionEventsStore,
    record: SessionRecord,
    base: OutboundEvent,
  ): Promise<number> {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await store.append(record.tenantId, record.sessionId, {
          type: base.type,
          id: base.id,
          createdAt: base.createdAt,
          payload: base.payload,
        });
      } catch (err) {
        lastErr = err;
        if (i < 2) await delay(25 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** Deliver `event` to every subscriber, dropping the oldest on overflow (R4.2/R4.3). */
  private fanOut(event: PositionedOutboundEvent): void {
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

  /**
   * The next event for `sub`: a pending lag notice first (it describes the gap that precedes
   * everything still buffered), then the oldest buffered event.
   */
  private takeFor(sub: Subscriber): PositionedOutboundEvent | undefined {
    if (sub.lagFrom !== null) {
      const fromPosition = sub.lagFrom;
      sub.lagFrom = null;
      return {
        type: STREAM_LAGGED,
        id: `evt_${randomUUID()}`,
        createdAt: now(),
        payload: { fromPosition },
      };
    }
    return sub.buffer.shift();
  }

  /** Hand the next event to `sub`'s pending waiter, if both exist. */
  private pump(sub: Subscriber): void {
    if (!sub.waiter) return;
    const next = this.takeFor(sub);
    if (!next) return;
    const w = sub.waiter;
    sub.waiter = null;
    w(next);
  }
}
