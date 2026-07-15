/**
 * Stream integration tests (WP-1.7, R4.3/R4.4) — pipeSessionStream:
 * reconnect-with-gap replay is gap-free + delta-free and comes from the `session_events`
 * projection (never a runtime); the live delta opt-in matrix; abort; a session with NO
 * active runtime streams history only (no wake); a `session.stream_lagged` notice is
 * forwarded WITHOUT an SSE id so the client's Last-Event-ID stays at the last event it got.
 */
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import type {
  EntryRange,
  InboundEvent,
  OutboundEvent,
  SessionEntry,
  SessionRuntime,
  SessionStatus,
} from "../../ports.js";
import { pipeSessionStream, STREAM_LAGGED } from "../stream.js";
import { FakeEventsReader } from "./fake-events-reader.js";

const TENANT = "tnt_test";
const SESSION = "sess_test";

/**
 * Minimal fake runtime whose `subscribe()` yields a pre-set list then ENDS (unlike the
 * testkit fake, which blocks forever on a waiter promise that `.return()` cannot interrupt
 * while suspended at an `await`). This lets pipeSessionStream resolve naturally so tests
 * stay deterministic. History is NOT read from it any more (R4.4) — only the live tail.
 */
class FiniteStreamRuntime implements SessionRuntime {
  private _outbound: OutboundEvent[] = [];
  private _sent: InboundEvent[] = [];
  queueOutbound(...events: OutboundEvent[]): void {
    this._outbound.push(...events);
  }
  get inboundEvents(): readonly InboundEvent[] {
    return this._sent;
  }
  async wake(): Promise<void> {}
  async sendEvent(event: InboundEvent): Promise<void> {
    this._sent.push(event);
  }
  subscribe(): AsyncIterable<OutboundEvent> {
    const out = this._outbound;
    return (async function* gen(): AsyncIterable<OutboundEvent> {
      for (const e of out) yield e;
    })();
  }
  async interrupt(): Promise<void> {}
  async getEntries(_range?: EntryRange): Promise<SessionEntry[]> {
    throw new Error("getEntries must not be used as the read path (R4.4)");
  }
  status(): SessionStatus {
    return "idle";
  }
}

function entry(position: number): SessionEntry {
  return {
    position,
    type: "agent.message",
    id: `evt_${position}`,
    createdAt: `2026-01-01T00:00:0${position}.000Z`,
    payload: { content: `msg-${position}` },
  };
}

function agentMessage(content: string, position?: number): OutboundEvent {
  return {
    type: "agent.message",
    id: `evt_live_${content}`,
    createdAt: "2026-01-01T00:00:10.000Z",
    payload: { content },
    ...(position !== undefined ? { position } : {}),
  } as OutboundEvent;
}

function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/** Parse SSE text into frames: [{id?, event, data}]. */
function parseFrames(text: string): Array<{ id?: number; event: string; data: unknown }> {
  const frames: Array<{ id?: number; event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let id: number | undefined;
    let event = "";
    let dataRaw = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataRaw += line.slice(6);
    }
    frames.push({ id, event, data: dataRaw ? JSON.parse(dataRaw) : undefined });
  }
  return frames;
}

/** Build a stream source over a seeded projection + an optional live runtime. */
function source(entries: SessionEntry[], runtime?: SessionRuntime) {
  return {
    events: new FakeEventsReader(entries),
    tenantId: TENANT,
    sessionId: SESSION,
    ...(runtime ? { runtime } : {}),
  };
}

describe("pipeSessionStream — reconnect with gap", () => {
  it("replays persisted events gap-free + delta-free, then continues live", async () => {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(agentMessage("live-1"));

    const { stream, text } = collector();
    await pipeSessionStream(
      source([entry(0), entry(1), entry(2), entry(3), entry(4)], fake),
      { lastEventId: 2, eventDeltas: new Set(["agent.message"]) },
      stream,
    );

    const frames = parseFrames(text());
    // Gap-free: 3, 4 (replay from the projection), then live seq 5.
    const bufferedIds = frames.filter((f) => f.id !== undefined).map((f) => f.id);
    expect(bufferedIds).toEqual([3, 4, 5]);
    // Replay frames are persisted events, never deltas.
    expect(frames[0].event).toBe("agent.message");
    expect(frames[1].event).toBe("agent.message");
    // The live agent.message (opted in) is preceded by event_start + event_delta.
    expect(frames[2].event).toBe("event_start");
    expect(frames[3].event).toBe("event_delta");
    expect(frames[4].event).toBe("agent.message");
    expect(frames[4].id).toBe(5);
    // event_start / event_delta carry no SSE id.
    expect(frames[2].id).toBeUndefined();
    expect(frames[3].id).toBeUndefined();
    // Replayed persisted events carry processedAt.
    expect((frames[0].data as Record<string, unknown>).processedAt).toBe("2026-01-01T00:00:03.000Z");
  });

  it("first connect (no Last-Event-ID): replays the full persisted history, then the live tail", async () => {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(agentMessage("live"));

    const { stream, text } = collector();
    await pipeSessionStream(source([entry(0), entry(1)], fake), { eventDeltas: new Set() }, stream);

    const frames = parseFrames(text());
    // The persisted history (0, 1) replays first, then the live event continues at seq 2.
    expect(frames.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(frames.every((f) => f.event === "agent.message")).toBe(true);
  });

  it("a live event that carries its projection position uses it as the SSE id", async () => {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(agentMessage("stamped", 7));
    const { stream, text } = collector();
    await pipeSessionStream(source([], fake), { eventDeltas: new Set() }, stream);
    expect(parseFrames(text()).map((f) => f.id)).toEqual([7]);
  });
});

describe("pipeSessionStream — first connect after the turn already finished (regression)", () => {
  it("no Last-Event-ID: delivers the FULL persisted history — including a terminal event emitted before connect — not just the live tail", async () => {
    // Pins the real bug: a turn can complete (and persist session.status_idle) before the
    // client's first `GET /stream` connects. The runtime may still be active but has
    // nothing left to emit LIVE — so the only way `status_idle` reaches the client is via
    // the replay. Without the fix, a first connect (no Last-Event-ID) replayed zero frames
    // and this event was never delivered.
    const idle: SessionEntry = {
      position: 2,
      type: "session.status_idle",
      id: "evt_idle",
      createdAt: "2026-01-01T00:00:02.000Z",
      payload: { status: "idle" },
    };
    const fake = new FiniteStreamRuntime(); // nothing queued: the turn already finished live

    const { stream, text } = collector();
    await pipeSessionStream(
      source([entry(0), entry(1), idle], fake),
      { eventDeltas: new Set() }, // no Last-Event-ID: first connect, AFTER the events emitted
      stream,
    );

    const frames = parseFrames(text());
    expect(frames.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(frames.map((f) => f.event)).toEqual([
      "agent.message",
      "agent.message",
      "session.status_idle",
    ]);
  });
});

describe("pipeSessionStream — read path (R4.4)", () => {
  it("no active runtime: history replays, no live tail, nothing is woken", async () => {
    const { stream, text } = collector();
    await pipeSessionStream(
      source([entry(0), entry(1), entry(2)]), // runtime omitted (cold/archived session)
      { lastEventId: 0, eventDeltas: new Set() },
      stream,
    );
    const frames = parseFrames(text());
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames.every((f) => f.event === "agent.message")).toBe(true);
  });
});

describe("pipeSessionStream — lag notice (R4.3)", () => {
  it("session.stream_lagged is forwarded WITHOUT an SSE id and does not consume a seq", async () => {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(
      {
        type: STREAM_LAGGED,
        id: "evt_lag",
        createdAt: "2026-01-01T00:00:10.000Z",
        payload: { fromPosition: 3 },
      },
      agentMessage("after-lag", 42),
    );
    const { stream, text } = collector();
    await pipeSessionStream(source([], fake), { eventDeltas: new Set() }, stream);

    const frames = parseFrames(text());
    expect(frames.map((f) => f.event)).toEqual([STREAM_LAGGED, "agent.message"]);
    // No id on the notice → the client's Last-Event-ID stays at its last real event.
    expect(frames[0].id).toBeUndefined();
    expect((frames[0].data as Record<string, unknown>).fromPosition).toBe(3);
    expect(frames[1].id).toBe(42);
  });
});

describe("pipeSessionStream — delta opt-in matrix (live)", () => {
  async function runOnce(optIn: Set<string>, event: OutboundEvent) {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(event);
    const { stream, text } = collector();
    await pipeSessionStream(source([], fake), { eventDeltas: optIn }, stream);
    return parseFrames(text());
  }

  it("no opt-in: only the buffered event", async () => {
    const frames = await runOnce(new Set(), agentMessage("hi"));
    expect(frames.map((f) => f.event)).toEqual(["agent.message"]);
  });

  it("agent.message opted in: event_start → event_delta → buffered", async () => {
    const frames = await runOnce(new Set(["agent.message"]), agentMessage("hello"));
    expect(frames.map((f) => f.event)).toEqual(["event_start", "event_delta", "agent.message"]);
    expect(frames[1].data).toEqual({ eventId: "evt_live_hello", index: 0, text: "hello" });
  });

  it("agent.thinking opted in: event_start → buffered (no event_delta)", async () => {
    const thinking: OutboundEvent = {
      type: "agent.thinking",
      id: "evt_thk_live",
      createdAt: "2026-01-01T00:00:10.000Z",
      payload: { content: "pondering" },
    };
    const frames = await runOnce(new Set(["agent.thinking"]), thinking);
    expect(frames.map((f) => f.event)).toEqual(["event_start", "agent.thinking"]);
  });
});

describe("pipeSessionStream — abort", () => {
  it("a pre-aborted signal skips the live loop (client already gone)", async () => {
    const fake = new FiniteStreamRuntime();
    fake.queueOutbound(agentMessage("never-seen"));
    const { stream, text } = collector();
    const controller = new AbortController();
    controller.abort();
    await pipeSessionStream(
      source([entry(0), entry(1)], fake),
      { lastEventId: 0, eventDeltas: new Set(), signal: controller.signal },
      stream,
    );
    // Client already gone: replay is skipped (nothing written), live loop skipped.
    const frames = parseFrames(text());
    expect(frames).toEqual([]);
  });
});
