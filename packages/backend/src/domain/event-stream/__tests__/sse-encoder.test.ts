/**
 * SSE frame encoder unit tests (WP-1.7, §"SSE wire format").
 */
import { describe, expect, it } from "vitest";
import { encodeSseFrame } from "../sse-encoder.js";

describe("encodeSseFrame", () => {
  it("emits id/event/data lines terminated by a blank line", () => {
    const frame = encodeSseFrame({ id: 42, event: "agent.message", data: { content: "hi" } });
    expect(frame).toBe("id: 42\nevent: agent.message\ndata: {\"content\":\"hi\"}\n\n");
  });

  it("omits the id line when no sequence position is given (delta frames)", () => {
    const frame = encodeSseFrame({ event: "event_start", data: { eventId: "evt_1", type: "agent.message" } });
    expect(frame).toBe("event: event_start\ndata: {\"eventId\":\"evt_1\",\"type\":\"agent.message\"}\n\n");
    expect(frame).not.toContain("id:");
  });

  it("serializes data as a single-line JSON string", () => {
    const frame = encodeSseFrame({ id: 0, event: "session.status_idle", data: { stopReason: "completed" } });
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    expect(dataLine).toBe('data: {"stopReason":"completed"}');
  });
});
