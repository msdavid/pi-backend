/**
 * Replay unit tests (WP-1.7, §9.3 "Reconnect & replay"; R4.4) — gap-free, delta-free,
 * and served from the `session_events` projection (never a live runtime).
 */
import { describe, expect, it } from "vitest";
import type { EntryRange, SessionEntry } from "../../ports.js";
import { replayFromLastEventId, replayFrames } from "../replay.js";
import type { EventsReader } from "../replay.js";
import type { SseFrame } from "../sse-encoder.js";
import { FakeEventsReader } from "./fake-events-reader.js";

const TARGET = { tenantId: "tnt_test", sessionId: "sess_test" };

function entry(position: number, type = "agent.message", content = `msg-${position}`): SessionEntry {
  return {
    position,
    type,
    id: `evt_${position}`,
    createdAt: `2026-01-01T00:00:0${position}.000Z`,
    payload: type === "agent.message" ? { content } : {},
  };
}

describe("replayFromLastEventId", () => {
  it("replays persisted events with position > Last-Event-ID (gap-free)", async () => {
    const events = new FakeEventsReader([entry(0), entry(1), entry(2), entry(3), entry(4)]);

    const { frames, nextSeq } = await replayFromLastEventId(events, TARGET, 2);
    expect(frames.map((f) => f.id)).toEqual([3, 4]);
    expect(frames.map((f) => f.event)).toEqual(["agent.message", "agent.message"]);
    // Live events continue right after the last replayed position.
    expect(nextSeq).toBe(5);
  });

  it("replay frames carry the persisted processedAt, never event_start/event_delta", async () => {
    const events = new FakeEventsReader([entry(0), entry(1), entry(2)]);

    const { frames } = await replayFromLastEventId(events, TARGET, 0);
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    for (const f of frames) {
      expect(f.event).not.toBe("event_start");
      expect(f.event).not.toBe("event_delta");
      expect((f.data as Record<string, unknown>).processedAt).toBe(`2026-01-01T00:00:0${(f.id as number)}.000Z`);
    }
  });

  it("nothing new since the cursor → no frames, nextSeq = lastEventId + 1", async () => {
    const events = new FakeEventsReader([entry(0), entry(1)]);
    const { frames, nextSeq } = await replayFromLastEventId(events, TARGET, 1);
    expect(frames).toEqual([]);
    expect(nextSeq).toBe(2);
  });

  it("first connect (no Last-Event-ID): replays the FULL persisted history from position 0", async () => {
    const events = new FakeEventsReader([entry(0), entry(1), entry(2)]);
    const { frames, nextSeq } = await replayFromLastEventId(events, TARGET, undefined);
    expect(frames.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(nextSeq).toBe(3);
  });

  it("first connect with no persisted events: no frames, nextSeq = projection head (0)", async () => {
    const events = new FakeEventsReader([]);
    const { frames, nextSeq } = await replayFromLastEventId(events, TARGET, undefined);
    expect(frames).toEqual([]);
    expect(nextSeq).toBe(0);
  });

  it("first connect with `fromPosition`: replay is bounded to start at fromPosition, not 0", async () => {
    const events = new FakeEventsReader([entry(0), entry(1), entry(2), entry(3)]);
    const { frames, nextSeq } = await replayFromLastEventId(events, TARGET, undefined, 2);
    expect(frames.map((f) => f.id)).toEqual([2, 3]);
    expect(nextSeq).toBe(4);
  });

  it("`fromPosition` is ignored once Last-Event-ID is present", async () => {
    const events = new FakeEventsReader([entry(0), entry(1), entry(2), entry(3)]);
    const { frames } = await replayFromLastEventId(events, TARGET, 0, 2);
    // Last-Event-ID wins: replay resumes at position 1, not fromPosition (2).
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3]);
  });
});

describe("replayFrames (paged, PERF-3)", () => {
  /** Wraps a reader to count how many pages (readEvents calls) the generator fetched. */
  class CountingReader implements EventsReader {
    reads = 0;
    constructor(private readonly inner: FakeEventsReader) {}
    readEvents(t: string, s: string, range?: EntryRange): Promise<SessionEntry[]> {
      this.reads += 1;
      return this.inner.readEvents(t, s, range);
    }
    readEventsHead(s: string): Promise<number> {
      return this.inner.readEventsHead(s);
    }
  }

  async function collect(
    events: EventsReader,
    lastEventId: number | undefined,
    fromPosition: number | undefined,
    pageSize: number,
  ): Promise<{ frames: SseFrame[]; nextSeq: number }> {
    const gen = replayFrames(events, TARGET, lastEventId, fromPosition, pageSize);
    const frames: SseFrame[] = [];
    let step = await gen.next();
    while (!step.done) {
      frames.push(step.value);
      step = await gen.next();
    }
    return { frames, nextSeq: step.value };
  }

  it("pages the projection read and yields every frame gap-free", async () => {
    const reader = new CountingReader(
      new FakeEventsReader([entry(0), entry(1), entry(2), entry(3), entry(4)]),
    );
    const { frames, nextSeq } = await collect(reader, undefined, undefined, 2);
    expect(frames.map((f) => f.id)).toEqual([0, 1, 2, 3, 4]);
    expect(nextSeq).toBe(5);
    // 5 entries at pageSize 2 → pages of 2,2,1: the short final page ends the loop.
    expect(reader.reads).toBe(3);
  });

  it("a first connect with no events pages once and reports the projection head", async () => {
    const reader = new CountingReader(new FakeEventsReader([]));
    const { frames, nextSeq } = await collect(reader, undefined, undefined, 2);
    expect(frames).toEqual([]);
    expect(nextSeq).toBe(0);
    expect(reader.reads).toBe(1);
  });
});
