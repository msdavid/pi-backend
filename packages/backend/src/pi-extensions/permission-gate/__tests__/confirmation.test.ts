/**
 * Confirmation round-trip tests (WP-2.3, §9.5 / §29.3).
 *
 * Covers: allow → resume; deny → rejection (denyMessage propagation); multi-blocking-
 * event handling (two tools pending, confirm each); unknown event id; abort.
 *
 * The {@link ConfirmationCoordinator} is exercised through a fake emitter that records
 * the `requires_action` idle signals (the same seam the runtime / events-API layer will
 * implement against the live outbound queue).
 */

import { describe, expect, it } from "vitest";
import {
  ConfirmationCoordinator,
  DEFAULT_DENY_MESSAGE,
  type BlockingToolCall,
} from "../confirmation.js";

interface Emitted {
  blockingEventIds: string[];
}

function fakeHooks(): {
  hooks: { emitStatusIdleRequiresAction(ids: readonly string[]): void };
  emitted: Emitted[];
} {
  const emitted: Emitted[] = [];
  return {
    hooks: {
      emitStatusIdleRequiresAction: (ids) => emitted.push({ blockingEventIds: [...ids] }),
    },
    emitted,
  };
}

function call(id: string, toolName = "bash", isMcp = false): BlockingToolCall {
  return { toolCallId: id, toolName, input: {}, isMcp };
}

describe("ConfirmationCoordinator", () => {
  it("emits requires_action with the blocking id and awaits a decision", async () => {
    const { hooks, emitted } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);

    const pending = coord.requestConfirmation(call("evt_1", "bash"));
    expect(coord.pendingCount).toBe(1);
    expect(coord.hasPending("evt_1")).toBe(true);
    expect(emitted).toEqual([{ blockingEventIds: ["evt_1"] }]);
    expect(pending).toBeInstanceOf(Promise);

    const ok = coord.applyConfirmation("evt_1", "allow");
    expect(ok).toBe(true);
    await expect(pending).resolves.toEqual({ allow: true });
    expect(coord.pendingCount).toBe(0);
  });

  it("deny resolves with the denyMessage (propagated to the gate as the rejection reason)", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);

    const pending = coord.requestConfirmation(call("evt_2", "bash"));
    const ok = coord.applyConfirmation("evt_2", "deny", "Forbidden by policy");
    expect(ok).toBe(true);
    await expect(pending).resolves.toEqual({
      allow: false,
      denyMessage: "Forbidden by policy",
    });
  });

  it("deny without a denyMessage uses the default rejection text", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const pending = coord.requestConfirmation(call("evt_3"));
    coord.applyConfirmation("evt_3", "deny");
    await expect(pending).resolves.toEqual({
      allow: false,
      denyMessage: DEFAULT_DENY_MESSAGE,
    });
  });

  it("treats a whitespace-only denyMessage as missing", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const pending = coord.requestConfirmation(call("evt_4"));
    coord.applyConfirmation("evt_4", "deny", "   ");
    await expect(pending).resolves.toEqual({
      allow: false,
      denyMessage: DEFAULT_DENY_MESSAGE,
    });
  });

  it("handles multiple blocking events: advertises all ids, confirms each in turn", async () => {
    const { hooks, emitted } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);

    // Two tools block before either is confirmed (parallel tool-call mode).
    const a = coord.requestConfirmation(call("evt_A", "bash"));
    const b = coord.requestConfirmation(call("evt_B", "web_fetch"));

    // First idle advertises A; the second advertises BOTH (pending set grew).
    expect(emitted).toEqual([
      { blockingEventIds: ["evt_A"] },
      { blockingEventIds: ["evt_A", "evt_B"] },
    ]);
    expect(coord.pendingEventIds).toEqual(["evt_A", "evt_B"]);

    // Confirm A → A resolves (allow); B still pending → re-emit idle advertising [B].
    coord.applyConfirmation("evt_A", "allow");
    await expect(a).resolves.toEqual({ allow: true });
    expect(coord.pendingEventIds).toEqual(["evt_B"]);
    expect(emitted[emitted.length - 1]).toEqual({ blockingEventIds: ["evt_B"] });

    // Confirm B → deny with a message.
    coord.applyConfirmation("evt_B", "deny", "Nope");
    await expect(b).resolves.toEqual({ allow: false, denyMessage: "Nope" });
    expect(coord.pendingCount).toBe(0);
    // No extra idle emission after the last confirmation (pending set empty).
    expect(emitted.length).toBe(3);
  });

  it("returns false for an unknown event id (no-op, no emission)", () => {
    const { hooks, emitted } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    coord.requestConfirmation(call("evt_5"));
    const ok = coord.applyConfirmation("evt_unknown", "allow");
    expect(ok).toBe(false);
    expect(coord.pendingCount).toBe(1);
    expect(emitted.length).toBe(1); // only the initial block emission
  });

  it("abortAll denies every pending call with the given reason", async () => {
    const { hooks } = fakeHooks();
    const coord = new ConfirmationCoordinator(hooks);
    const a = coord.requestConfirmation(call("evt_A"));
    const b = coord.requestConfirmation(call("evt_B"));
    coord.abortAll("Session interrupted");
    await expect(a).resolves.toEqual({
      allow: false,
      denyMessage: "Session interrupted",
    });
    await expect(b).resolves.toEqual({
      allow: false,
      denyMessage: "Session interrupted",
    });
    expect(coord.pendingCount).toBe(0);
  });
});
