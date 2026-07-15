/**
 * Delta reconciler unit tests (WP-1.7, §"Live deltas") — opt-in matrix.
 */
import { describe, expect, it } from "vitest";
import type { OutboundEvent } from "../../ports.js";
import { reconcileDeltas, parseEventDeltas, DELTAABLE_TYPES } from "../deltas.js";

function agentMessage(content: string): OutboundEvent {
  return {
    type: "agent.message",
    id: "evt_abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { content },
  };
}

function agentThinking(content: string): OutboundEvent {
  return {
    type: "agent.thinking",
    id: "evt_thk",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { content },
  };
}

function types(frames: { event: string }[]): string[] {
  return frames.map((f) => f.event);
}

describe("parseEventDeltas", () => {
  it("parses a comma-separated list and filters to delta-able types", () => {
    const set = parseEventDeltas("agent.message,agent.thinking,bogus, ");
    expect(set.has("agent.message")).toBe(true);
    expect(set.has("agent.thinking")).toBe(true);
    expect(set.has("bogus")).toBe(false);
    expect(set.size).toBe(2);
  });

  it("returns an empty set for missing/blank values", () => {
    expect(parseEventDeltas(undefined).size).toBe(0);
    expect(parseEventDeltas("").size).toBe(0);
    expect(parseEventDeltas("   ").size).toBe(0);
  });

  it("only agent.message and agent.thinking are delta-able", () => {
    expect(DELTAABLE_TYPES.has("agent.message")).toBe(true);
    expect(DELTAABLE_TYPES.has("agent.thinking")).toBe(true);
    expect(DELTAABLE_TYPES.has("session.status_idle")).toBe(false);
  });
});

describe("reconcileDeltas — opt-in matrix", () => {
  it("no opt-in: only the buffered event", () => {
    const { pre, buffered } = reconcileDeltas(agentMessage("hi"), new Set());
    expect(pre).toEqual([]);
    expect(buffered.event).toBe("agent.message");
    expect(buffered.id).toBeUndefined();
    expect((buffered.data as Record<string, unknown>).processedAt).toBe("2026-01-01T00:00:00.000Z");
    expect((buffered.data as Record<string, unknown>).content).toBe("hi");
  });

  it("agent.message opted in: event_start + event_delta(index 0, full text) + buffered", () => {
    const optIn = new Set(["agent.message"]);
    const { pre, buffered } = reconcileDeltas(agentMessage("Fixing the bug"), optIn);
    expect(types(pre)).toEqual(["event_start", "event_delta"]);
    expect(pre[0].data).toEqual({ eventId: "evt_abc", type: "agent.message" });
    expect(pre[1].data).toEqual({ eventId: "evt_abc", index: 0, text: "Fixing the bug" });
    // pre frames never carry an SSE id (stream-only).
    expect(pre[0].id).toBeUndefined();
    expect(pre[1].id).toBeUndefined();
    expect(buffered.event).toBe("agent.message");
    expect((buffered.data as Record<string, unknown>).content).toBe("Fixing the bug");
  });

  it("agent.thinking opted in: event_start only (no event_delta) + buffered", () => {
    const optIn = new Set(["agent.thinking"]);
    const { pre, buffered } = reconcileDeltas(agentThinking("hmm"), optIn);
    expect(types(pre)).toEqual(["event_start"]);
    expect(pre[0].data).toEqual({ eventId: "evt_thk", type: "agent.thinking" });
    expect(buffered.event).toBe("agent.thinking");
    expect((buffered.data as Record<string, unknown>).content).toBe("hmm");
  });

  it("agent.message opted in but event is agent.thinking (not opted in): only buffered", () => {
    const optIn = new Set(["agent.message"]);
    const { pre, buffered } = reconcileDeltas(agentThinking("hmm"), optIn);
    expect(pre).toEqual([]);
    expect(buffered.event).toBe("agent.thinking");
  });

  it("agent.thinking opted in but event is agent.message: only buffered (thinking opt-in does not affect message)", () => {
    const optIn = new Set(["agent.thinking"]);
    const { pre, buffered } = reconcileDeltas(agentMessage("hi"), optIn);
    expect(pre).toEqual([]);
    expect(buffered.event).toBe("agent.message");
  });
});
