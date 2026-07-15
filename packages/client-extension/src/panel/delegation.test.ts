import { describe, it, expect } from "vitest";
import {
  DelegationRecorder,
  InMemoryDelegationDedupStore,
} from "./delegation.js";
import { DELEGATION_CUSTOM_TYPE } from "./types.js";

/** A recorder that captures every appendEntry call (customType + data). */
function makeRecorder() {
  const appended: { customType: string; data: unknown }[] = [];
  const append = (customType: string, data?: unknown): void => {
    appended.push({ customType, data });
  };
  const now = () => "2026-07-13T12:00:00.000Z";
  const recorder = new DelegationRecorder(append, now);
  return { recorder, appended };
}

describe("DelegationRecorder — entry-append discipline (§24.7)", () => {
  it("appends exactly TWO entries per delegation (start + completion)", () => {
    const { recorder, appended } = makeRecorder();

    recorder.appendStart("sess_1", "fix the login bug", "delegate");
    recorder.appendCompletion("sess_1", {
      status: "idle",
      stopReason: "completed",
      outputsAvailable: true,
    });

    expect(appended.length).toBe(2);
    expect(appended.every((e) => e.customType === DELEGATION_CUSTOM_TYPE)).toBe(true);

    const start = appended[0]!.data as { kind: string; sessionId: string };
    const completion = appended[1]!.data as { kind: string; sessionId: string };
    expect(start.kind).toBe("start");
    expect(completion.kind).toBe("completion");
    expect(start.sessionId).toBe("sess_1");
    expect(completion.sessionId).toBe("sess_1");
  });

  it("does NOT append a second start on reconnect/re-emission (idempotent)", () => {
    const { recorder, appended } = makeRecorder();
    recorder.appendStart("sess_2", "task", "delegate");
    recorder.appendStart("sess_2", "task", "delegate"); // replayed
    recorder.appendStart("sess_2", "task", "delegate"); // replayed again

    expect(appended.filter((e) => (e.data as { kind: string }).kind === "start")).toHaveLength(1);
  });

  it("does NOT append a second completion on repeated idle/terminated (idempotent)", () => {
    const { recorder, appended } = makeRecorder();
    recorder.appendStart("sess_3", "task", "delegate");
    recorder.appendCompletion("sess_3", { status: "idle", outputsAvailable: true });
    recorder.appendCompletion("sess_3", { status: "idle", outputsAvailable: true });
    recorder.appendCompletion("sess_3", { status: "terminated", outputsAvailable: false });

    const completions = appended.filter(
      (e) => (e.data as { kind: string }).kind === "completion",
    );
    expect(completions).toHaveLength(1);
  });

  it("records a separate delegation per session (no cross-session collapse)", () => {
    const { recorder, appended } = makeRecorder();
    recorder.appendStart("sess_a", "task a", "delegate");
    recorder.appendStart("sess_b", "task b", "delegate");
    recorder.appendCompletion("sess_a", { status: "idle", outputsAvailable: true });
    recorder.appendCompletion("sess_b", { status: "terminated", outputsAvailable: false });

    // 2 delegations × 2 entries = 4 total, never more.
    expect(appended.length).toBe(4);
    expect(recorder.hasStarted("sess_a")).toBe(true);
    expect(recorder.hasStarted("sess_b")).toBe(true);
    expect(recorder.hasCompleted("sess_a")).toBe(true);
    expect(recorder.hasCompleted("sess_b")).toBe(true);
  });

  it("offline completion is a single entry and idempotent", () => {
    const { recorder, appended } = makeRecorder();
    recorder.appendOfflineCompletion("sess_off", {
      status: "idle",
      lastActivityAt: "2026-07-13T13:00:00Z",
    });
    recorder.appendOfflineCompletion("sess_off", {
      status: "idle",
      lastActivityAt: "2026-07-13T13:00:00Z",
    });

    expect(appended.length).toBe(1);
    expect((appended[0]!.data as { kind: string }).kind).toBe("offline-completion");
  });

  it("dedup survives a restart via a shared store (R3.3)", () => {
    const store = new InMemoryDelegationDedupStore();
    const now = () => "2026-07-13T12:00:00.000Z";

    // First recorder records a full delegation, persisting to the store.
    const appended1: { customType: string; data: unknown }[] = [];
    const r1 = new DelegationRecorder(
      (ct, d) => appended1.push({ customType: ct, data: d }),
      now,
      store,
    );
    r1.appendStart("sess_persist", "task", "delegate");
    r1.appendCompletion("sess_persist", { status: "idle", outputsAvailable: true });
    expect(r1.hasCompleted("sess_persist")).toBe(true);

    // Simulate a Pi restart: a SECOND recorder over the SAME store hydrates the
    // dedup sets — no fresh entries, and a replayed completion is a no-op.
    const appended2: { customType: string; data: unknown }[] = [];
    const r2 = new DelegationRecorder(
      (ct, d) => appended2.push({ customType: ct, data: d }),
      now,
      store,
    );
    expect(r2.hasStarted("sess_persist")).toBe(true);
    expect(r2.hasCompleted("sess_persist")).toBe(true);

    r2.appendStart("sess_persist", "task", "delegate");
    r2.appendCompletion("sess_persist", { status: "idle", outputsAvailable: true });
    expect(appended2.length).toBe(0);
  });
});
