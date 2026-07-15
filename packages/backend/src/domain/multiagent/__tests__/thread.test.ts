/**
 * ThreadRuntime tests (R6.4).
 *
 * The thread runtime is the unit that makes `requires_action` real: it must record a
 * cross-posted blocking id **synchronously**, before it awaits the round-trip, so a
 * turn that settles while the user is still deciding reports `requires_action` + the
 * pending ids rather than a bogus `completed` (the pre-R6.4 behavior — `blockingEventIds`
 * was declared in `drive()` and never written to).
 */

import { describe, expect, it } from "vitest";
import { ThreadRuntime } from "../thread.js";
import type { OutboundEvent } from "../../ports.js";
import type { CondensedThreadEvent } from "../types.js";
import { FakeThreadSession, ManualCrossPost } from "./fakes.js";

interface Rig {
  thread: ThreadRuntime;
  session: FakeThreadSession;
  crossPost: ManualCrossPost;
  condensed: CondensedThreadEvent[];
  events: OutboundEvent[];
}

function rig(): Rig {
  const session = new FakeThreadSession("sess-1", "/work/.pi/sessions/thread-a-1.jsonl");
  const crossPost = new ManualCrossPost();
  const condensed: CondensedThreadEvent[] = [];
  const events: OutboundEvent[] = [];
  const thread = new ThreadRuntime({
    threadId: "thread_sess-1",
    agentName: "researcher",
    session,
    localJsonlPath: "/work/.pi/sessions/thread-a-1.jsonl",
    crossPost,
    onCondensed: (e) => condensed.push(e),
  });
  // Drain the thread's own stream into an array.
  void (async () => {
    for await (const ev of thread.subscribe()) events.push(ev);
  })();
  return { thread, session, crossPost, condensed, events };
}

/** Let queued microtasks (the thread's stream pump) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("ThreadRuntime — lifecycle", () => {
  it("runs a turn and reports the assistant output", async () => {
    const { thread, session, condensed } = rig();
    session.scriptText("hello world");

    const result = await thread.run("say hi");

    expect(result.stopReason).toBe("completed");
    expect(result.output).toBe("hello world");
    expect(result.blockingEventIds).toEqual([]);
    expect(thread.status).toBe("idle");
    expect(session.prompts).toEqual(["say hi"]);
    expect(condensed.map((c) => c.kind)).toContain("idle");
  });

  it("reuses the same session on followUp (persistent thread, §18.5)", async () => {
    const { thread, session } = rig();
    session.scriptText("first");
    await thread.run("a");
    session.scriptText("second");
    const r = await thread.followUp("b");

    expect(r.output).toBe("second");
    expect(session.prompts).toEqual(["a"]);
    expect(session.followUps).toEqual(["b"]);
  });

  it("reports a failed turn as terminated/error", async () => {
    const { thread, session } = rig();
    session.failNextTurn(new Error("model exploded"));

    const r = await thread.run("boom");

    expect(r.stopReason).toBe("error");
    expect(thread.status).toBe("terminated");
    await expect(thread.run("again")).rejects.toThrow(/terminated/);
  });

  it("disposes the underlying session and closes the stream", async () => {
    const { thread, session, condensed, events } = rig();
    session.scriptText("x");
    await thread.run("a");

    thread.dispose();
    await flush();

    expect(session.disposeCount).toBe(1);
    expect(thread.status).toBe("terminated");
    expect(condensed.at(-1)?.kind).toBe("terminated");
    expect(events.map((e) => e.type)).toContain("thread_status_terminated");
  });
});

describe("ThreadRuntime — requires_action (§18.7)", () => {
  it("returns requires_action with the pending ids when a turn settles while blocked", async () => {
    const { thread, session, crossPost, condensed } = rig();
    session.scriptBlocking("call_1", "bash");

    const result = await thread.run("rm the thing");

    // The cross-post is in flight (the user has NOT answered).
    expect(crossPost.requests).toHaveLength(1);
    expect(crossPost.requests[0]).toMatchObject({
      eventId: "call_1",
      toolName: "bash",
      kind: "tool_confirmation",
      sessionThreadId: "thread_sess-1",
    });
    expect(crossPost.pendingCount).toBe(1);

    // ...and the turn reports it (pre-R6.4: always "completed").
    expect(result.stopReason).toBe("requires_action");
    expect(result.blockingEventIds).toEqual(["call_1"]);

    // Condensed view carries the blocking marker for the primary thread.
    const blocking = condensed.find((c) => c.kind === "blocking");
    expect(blocking?.blockingEventIds).toEqual(["call_1"]);
  });

  it("records the blocking id BEFORE awaiting the cross-post", async () => {
    // If the id were recorded only after the round-trip resolved, a turn that settles
    // first (the normal case: the tool call is pending on the user) would report
    // "completed" — the original bug. A cross-post that never resolves proves ordering.
    const { thread, session } = rig();
    session.scriptBlocking("call_never");

    const result = await thread.run("do it");

    expect(result.stopReason).toBe("requires_action");
    expect(result.blockingEventIds).toEqual(["call_never"]);
  });

  it("collects every unresolved block raised in one turn", async () => {
    const { thread, session } = rig();
    session.scriptTurn(
      { type: "blocking_request", toolCallId: "c1", toolName: "bash", kind: "tool_confirmation" },
      { type: "blocking_request", toolCallId: "c2", toolName: "write", kind: "custom_tool_result" },
    );

    const result = await thread.run("two risky things");

    expect(result.stopReason).toBe("requires_action");
    expect([...result.blockingEventIds].sort()).toEqual(["c1", "c2"]);
  });

  it("does not report a block that the user already answered", async () => {
    const { thread, session, crossPost } = rig();
    // A session whose blocking round-trip is answered *during* the turn: the runtime
    // dispatches the block, the user answers, and only then does prompt() settle.
    session.scriptBlocking("call_fast");
    const runPromise = thread.run("risky");
    await flush();
    expect(crossPost.resolve("call_fast", { decision: "allow" })).toBe(true);
    await flush();

    const result = await runPromise;
    // The turn itself settled before the answer landed, so this turn is requires_action,
    // but the block is now resolved and must not gate the NEXT turn.
    expect(crossPost.pendingCount).toBe(0);

    session.scriptText("finished");
    const next = await thread.followUp("continue");
    expect(next.stopReason).toBe("completed");
    expect(next.blockingEventIds).toEqual([]);
    expect(result.threadId).toBe("thread_sess-1");
  });

  it("steers the session with the decision once the user answers", async () => {
    const { thread, session, crossPost } = rig();
    session.scriptBlocking("call_2", "bash");
    await thread.run("risky");

    crossPost.resolve("call_2", { decision: "deny", denyMessage: "nope" });
    await flush();

    expect(session.steers).toHaveLength(1);
    expect(session.steers[0]).toContain("decision=deny");
    expect(session.steers[0]).toContain("nope");
    expect(thread.lastBlockingResponse).toMatchObject({ decision: "deny" });
  });

  it("no crossPort ⇒ blocking requests are ignored (turn completes)", async () => {
    const session = new FakeThreadSession("sess-2", undefined);
    const thread = new ThreadRuntime({
      threadId: "thread_sess-2",
      agentName: "solo",
      session,
      localJsonlPath: "/work/x.jsonl",
    });
    session.scriptBlocking("call_x");

    const r = await thread.run("go");
    expect(r.stopReason).toBe("completed");
    expect(r.blockingEventIds).toEqual([]);
  });
});

describe("ThreadRuntime — inter-thread injection (§18.5)", () => {
  it("injects an event onto the thread's own stream", async () => {
    const { thread, events } = rig();
    thread.inject({
      type: "agent.thread_message_received",
      id: "evt_1",
      createdAt: new Date().toISOString(),
      payload: { content: "hi" },
    });
    await flush();
    expect(events.map((e) => e.type)).toContain("agent.thread_message_received");
  });
});
