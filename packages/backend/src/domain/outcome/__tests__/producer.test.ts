/**
 * `RuntimeOutcomeProducer` tests (R6.3) — the PRODUCTION producer.
 *
 * The loop used to be drivable only by `FakeProducer` (a test double). The real producer
 * drives the session runtime: it sends a `user.message` (the outcome description on the
 * first call, the grader's feedback on later calls) through `SessionRuntime.sendEvent`
 * and awaits it — the runtime resolves `sendEvent` only once the turn has settled — and
 * it watches the session's outbound stream for a `user.interrupt` (§16.5).
 *
 * No DB / no container: the runtime is a fake implementing the `SessionRuntime` port.
 */

import { describe, expect, it } from "vitest";
import { RuntimeOutcomeProducer } from "../runner.js";
import type {
  InboundEvent,
  OutboundEvent,
  SessionEntry,
  SessionId,
  SessionRuntime,
  SessionStatus,
} from "../../ports.js";

/** A fake `SessionRuntime`: records inbound events, broadcasts scripted outbound ones. */
class FakeRuntime implements SessionRuntime {
  readonly sent: InboundEvent[] = [];
  /** Resolves the pending `sendEvent` (models the turn settling). */
  private settle: (() => void) | undefined;
  private subs: ((e: OutboundEvent | null) => void)[] = [];
  /** When true, `sendEvent` stays pending until {@link settleTurn}. */
  holdTurn = false;

  async wake(): Promise<void> {}
  async sendEvent(event: InboundEvent): Promise<void> {
    this.sent.push(event);
    if (!this.holdTurn) return;
    await new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }
  settleTurn(): void {
    const s = this.settle;
    this.settle = undefined;
    s?.();
  }
  subscribe(): AsyncIterable<OutboundEvent> {
    const queue: OutboundEvent[] = [];
    let waiter: ((e: OutboundEvent | null) => void) | null = null;
    const push = (e: OutboundEvent | null): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(e);
      } else if (e) queue.push(e);
    };
    this.subs.push(push);
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<OutboundEvent>> => {
          const ready = queue.shift();
          if (ready) return { done: false, value: ready };
          const next = await new Promise<OutboundEvent | null>((r) => {
            waiter = r;
          });
          if (!next) return { done: true, value: undefined };
          return { done: false, value: next };
        },
        return: async (): Promise<IteratorResult<OutboundEvent>> => {
          this.subs = this.subs.filter((s) => s !== push);
          return { done: true, value: undefined };
        },
      }),
    };
  }
  /** Broadcast an outbound event to every subscriber. */
  emit(type: string, payload: Record<string, unknown> = {}): void {
    const event: OutboundEvent = {
      type,
      id: `evt_${type}`,
      createdAt: new Date().toISOString(),
      payload,
    };
    for (const s of [...this.subs]) s(event);
  }
  get subscriberCount(): number {
    return this.subs.length;
  }
  async interrupt(): Promise<void> {}
  async getEntries(): Promise<SessionEntry[]> {
    return [];
  }
  status(): SessionStatus {
    return "idle";
  }
}

const SESSION = "sess_1" as SessionId;

function makeProducer(runtime: FakeRuntime): RuntimeOutcomeProducer {
  return new RuntimeOutcomeProducer(async () => runtime, SESSION, "Write a hello file");
}

describe("RuntimeOutcomeProducer (R6.3)", () => {
  it("sends the outcome description as a user.message on the first produce", async () => {
    const runtime = new FakeRuntime();
    const producer = makeProducer(runtime);

    await producer.produce();

    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0].type).toBe("user.message");
    expect(runtime.sent[0].payload).toMatchObject({ content: "Write a hello file" });
    producer.dispose();
  });

  it("sends the grader feedback on subsequent produces", async () => {
    const runtime = new FakeRuntime();
    const producer = makeProducer(runtime);

    await producer.produce();
    await producer.produce("convert the login callback");

    expect(runtime.sent.map((e) => (e.payload as { content: string }).content)).toEqual([
      "Write a hello file",
      "convert the login callback",
    ]);
    producer.dispose();
  });

  it("awaits the turn settling before produce() resolves", async () => {
    const runtime = new FakeRuntime();
    runtime.holdTurn = true;
    const producer = makeProducer(runtime);

    let settled = false;
    const pending = producer.produce().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // still mid-turn — the grader must not read outputs yet

    runtime.settleTurn();
    await pending;
    expect(settled).toBe(true);
    producer.dispose();
  });

  it("reflects a user.interrupt from the session stream + aborts the interrupt signal", async () => {
    const runtime = new FakeRuntime();
    const producer = makeProducer(runtime);
    await producer.produce();

    expect(producer.wasInterrupted()).toBe(false);
    expect(producer.interruptSignal().aborted).toBe(false);

    // The runtime reports an interrupt by settling the turn with this stop reason.
    runtime.emit("session.status_idle", { stopReason: "user_interrupt" });
    await new Promise((r) => setTimeout(r, 5));

    expect(producer.wasInterrupted()).toBe(true);
    expect(producer.interruptSignal().aborted).toBe(true);
    producer.dispose();
  });

  it("does not treat an ordinary idle settle as an interrupt", async () => {
    const runtime = new FakeRuntime();
    const producer = makeProducer(runtime);
    await producer.produce();

    runtime.emit("session.status_idle", { stopReason: "completed" });
    await new Promise((r) => setTimeout(r, 5));

    expect(producer.wasInterrupted()).toBe(false);
    producer.dispose();
  });

  it("releases the stream subscription on dispose", async () => {
    const runtime = new FakeRuntime();
    const producer = makeProducer(runtime);
    await producer.produce();
    expect(runtime.subscriberCount).toBe(1);

    producer.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(runtime.subscriberCount).toBe(0);
  });
});
