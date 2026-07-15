/**
 * SubagentCoordinator tests (R6.4 — the module previously had ZERO tests and its
 * subagent extension cited a `subagent.test.ts` that never existed).
 *
 * Covers the four real defects:
 * 1. the `runParallel` JSONL-filename race (paths were derived from `threads.size`),
 * 2. `requires_action` propagation from a child thread to the primary (§18.7),
 * 3. the never-released sandbox handles (isolated per-thread + the shared one),
 * 4. the concurrency cap counting FINISHED threads (the 26th lifetime delegation 429'd
 *    with nothing running), plus the new per-node thread budget.
 *
 * Everything runs against fakes — no model, no microVM.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "../../errors.js";
import {
  SubagentCoordinator,
  ThreadBudget,
  type SubagentCoordinatorOptions,
} from "../coordinator.js";
import { FakeSandboxAllocator } from "../modes.js";
import { MAX_CONCURRENT_THREADS } from "../types.js";
import type { MultiagentMode } from "../types.js";
import {
  FakeThreadSessionFactory,
  fakeResolveMaterial,
  fakeSlot,
} from "./fakes.js";

interface Harness {
  coordinator: SubagentCoordinator;
  factory: FakeThreadSessionFactory;
  allocator: FakeSandboxAllocator;
  budget: ThreadBudget;
}

function harness(
  opts: { mode?: MultiagentMode; budgetMax?: number } = {},
): Harness {
  const mode = opts.mode ?? "isolated";
  const factory = new FakeThreadSessionFactory();
  const allocator = new FakeSandboxAllocator(mode);
  // A per-test budget: the module default is process-wide, so sharing it across tests
  // would leak state between them.
  const budget = new ThreadBudget(opts.budgetMax ?? 100);
  const options: SubagentCoordinatorOptions = {
    roster: [fakeSlot("researcher"), fakeSlot("writer")],
    mode,
    factory,
    sandboxAllocator: allocator,
    resolveMaterial: fakeResolveMaterial,
    primaryAgentName: "primary",
    primaryThreadId: "thread_primary",
    threadBudget: budget,
  };
  return { coordinator: new SubagentCoordinator(options), factory, allocator, budget };
}

describe("SubagentCoordinator — parallel spawn (JSONL filename race, R6.4)", () => {
  it("gives every concurrently-spawned thread a distinct JSONL path", async () => {
    const { coordinator, factory } = harness();

    // Same agent, 8 ways: the old `threads.size + 1` derivation was read at spawn
    // time, so all 8 in-flight spawns computed the SAME filename and interleaved
    // their JSONL into one file.
    const results = await coordinator.runParallel(
      Array.from({ length: 8 }, (_, i) => ({ agent: "researcher", task: `task ${i}` })),
    );

    expect(results).toHaveLength(8);
    const paths = factory.optionsLog.map((o) => o.localJsonlPath);
    expect(paths).toHaveLength(8);
    expect(new Set(paths).size).toBe(8);
    // ...and each is still a per-thread file under the agent's session dir.
    for (const p of paths) {
      expect(p).toMatch(/^\/work\/\.pi\/sessions\/thread-agent_researcher-\d+\.jsonl$/);
    }
    // Distinct threads, in input order.
    expect(new Set(results.map((r) => r.threadId)).size).toBe(8);
    expect(results.map((r) => r.task)).toEqual(
      Array.from({ length: 8 }, (_, i) => `task ${i}`),
    );
    expect(coordinator.liveThreadCount).toBe(8);
  });

  it("keeps numbering monotonic across separate delegations", async () => {
    const { coordinator, factory } = harness();
    await coordinator.runParallel([
      { agent: "researcher", task: "a" },
      { agent: "writer", task: "b" },
    ]);
    await coordinator.runSingle("researcher", "c");
    const paths = factory.optionsLog.map((o) => o.localJsonlPath);
    expect(new Set(paths).size).toBe(3);
    expect(paths[2]).toContain("thread-agent_researcher-3.jsonl");
  });
});

describe("SubagentCoordinator — requires_action propagation (§18.7)", () => {
  it("reports requires_action with the blocking ids when a child blocks", async () => {
    const { coordinator, factory } = harness();
    factory.onCreate = (s) => s.scriptBlocking("call_1", "bash");

    const result = await coordinator.runSingle("researcher", "delete everything");

    // Dead before R6.4: `blockingEventIds` was declared, never pushed to, so this was
    // always "completed".
    expect(result.stopReason).toBe("requires_action");
    expect(result.isError).toBe(false);

    // The block is cross-posted on the PRIMARY thread and still pending.
    const pending = coordinator.crossPostCoordinator.pendingEvents;
    expect(pending).toHaveLength(1);
    expect(pending[0].eventId).toBe("call_1");
    expect(pending[0].sessionThreadId).toBe(result.threadId);
    expect(coordinator.crossPostCoordinator.hasPending("call_1")).toBe(true);

    // The turn settled, so it holds no concurrency slot while awaiting the user.
    expect(coordinator.activeThreadCount).toBe(0);

    // The user answers → routed back to the originating child.
    expect(coordinator.applyToolConfirmation("call_1", "allow")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.crossPostCoordinator.pendingCount).toBe(0);
  });

  it("emits the blocking round-trip on the primary condensed stream", async () => {
    const { coordinator, factory } = harness();
    factory.onCreate = (s) => s.scriptBlocking("call_2");

    const seen: string[] = [];
    const stream = coordinator.subscribe();
    const drain = (async () => {
      for await (const ev of stream) seen.push(ev.type);
    })();

    await coordinator.runSingle("writer", "risky");
    await coordinator.dispose();
    await drain;

    // The cross-post surfaces as a primary `session.status_idle` (requires_action).
    expect(seen).toContain("session.status_idle");
  });

  it("a resolved block does not leave the NEXT turn in requires_action", async () => {
    const { coordinator, factory } = harness();
    factory.onCreate = (s) => s.scriptBlocking("call_3");

    const first = await coordinator.runSingle("researcher", "risky");
    expect(first.stopReason).toBe("requires_action");
    coordinator.applyToolConfirmation("call_3", "allow");
    await Promise.resolve();

    factory.last.scriptText("all done");
    const second = await coordinator.sendMessage(first.threadId, "continue");
    expect(second.stopReason).toBe("completed");
    expect(second.blockingEventIds).toEqual([]);
    expect(second.output).toBe("all done");
  });
});

describe("SubagentCoordinator — sandbox release on dispose (R6.4 leak)", () => {
  it("releases every isolated handle exactly once", async () => {
    const { coordinator, allocator } = harness({ mode: "isolated" });
    await coordinator.runParallel([
      { agent: "researcher", task: "a" },
      { agent: "writer", task: "b" },
      { agent: "researcher", task: "c" },
    ]);
    expect(allocator.distinctHandles).toBe(3);
    expect(allocator.released).toHaveLength(0);

    await coordinator.dispose();

    // Before R6.4 the handle was stored on the thread and NEVER released — one leaked
    // microVM per subagent.
    expect(allocator.released).toHaveLength(3);
    expect(new Set(allocator.released).size).toBe(3);
    expect(allocator.leakedHandles).toBe(0);
    expect(coordinator.liveThreadCount).toBe(0);
  });

  it("releases an isolated handle as soon as its thread is disposed", async () => {
    const { coordinator, allocator } = harness({ mode: "isolated" });
    const r = await coordinator.runSingle("researcher", "a");

    expect(await coordinator.disposeThread(r.threadId)).toBe(true);
    expect(allocator.released).toHaveLength(1);
    expect(coordinator.liveThreadCount).toBe(0);
    // Gone from the addressable map.
    await expect(coordinator.sendMessage(r.threadId, "hi")).rejects.toBeInstanceOf(ApiError);

    await coordinator.dispose();
    expect(allocator.released).toHaveLength(1);
  });

  it("releases the SHARED handle exactly once, at coordinator dispose", async () => {
    const { coordinator, allocator } = harness({ mode: "shared" });
    await coordinator.runParallel([
      { agent: "researcher", task: "a" },
      { agent: "writer", task: "b" },
      { agent: "researcher", task: "c" },
    ]);
    // §18.4: one sandbox for all threads.
    expect(allocator.distinctHandles).toBe(1);

    await coordinator.dispose();

    expect(allocator.released).toHaveLength(1);
    expect(allocator.leakedHandles).toBe(0);
  });

  it("does not release the shared handle when a single thread is disposed", async () => {
    const { coordinator, allocator } = harness({ mode: "shared" });
    const a = await coordinator.runSingle("researcher", "a");
    await coordinator.runSingle("writer", "b");

    await coordinator.disposeThread(a.threadId);
    expect(allocator.released).toHaveLength(0);

    await coordinator.dispose();
    expect(allocator.released).toHaveLength(1);
  });

  it("dispose is idempotent (no double release)", async () => {
    const { coordinator, allocator } = harness({ mode: "isolated" });
    await coordinator.runSingle("researcher", "a");
    await coordinator.dispose();
    await coordinator.dispose();
    expect(allocator.released).toHaveLength(1);
  });
});

describe("SubagentCoordinator — concurrency cap counts ACTIVE threads only (R6.4)", () => {
  it("allows more than 25 delegations over a session's lifetime", async () => {
    const { coordinator } = harness({ budgetMax: 100 });

    // Sequentially delegate 30 times. Pre-R6.4 the 26th threw 429 because finished
    // threads were never removed from the map the cap counted.
    for (let i = 0; i < MAX_CONCURRENT_THREADS + 5; i++) {
      const r = await coordinator.runSingle("researcher", `task ${i}`);
      expect(r.stopReason).toBe("completed");
      // Nothing is running between delegations.
      expect(coordinator.activeThreadCount).toBe(0);
    }

    expect(coordinator.liveThreadCount).toBe(MAX_CONCURRENT_THREADS + 5);
  });

  it("still rejects >25 CONCURRENT threads", async () => {
    const { coordinator } = harness({ budgetMax: 100 });
    const tasks = Array.from({ length: MAX_CONCURRENT_THREADS + 1 }, (_, i) => ({
      agent: "researcher",
      task: `t${i}`,
    }));
    await expect(coordinator.runParallel(tasks)).rejects.toMatchObject({
      statusCode: 429,
    });
    // The rejected fan-out admitted nothing.
    expect(coordinator.activeThreadCount).toBe(0);

    // Exactly 25 concurrent is fine.
    const ok = await coordinator.runParallel(tasks.slice(0, MAX_CONCURRENT_THREADS));
    expect(ok).toHaveLength(MAX_CONCURRENT_THREADS);
    expect(coordinator.activeThreadCount).toBe(0);
  });

  it("keeps finished threads addressable for follow-ups (§18.5 persistent)", async () => {
    const { coordinator, factory } = harness();
    const r = await coordinator.runSingle("researcher", "first");
    expect(coordinator.activeThreadCount).toBe(0);

    factory.last.scriptText("second answer");
    const follow = await coordinator.sendMessage(r.threadId, "and now?");

    expect(follow.threadId).toBe(r.threadId);
    expect(follow.output).toBe("second answer");
    // The same AgentSession was re-used (persistent thread), not a new one.
    expect(factory.created).toHaveLength(1);
    expect(factory.last.followUps).toEqual(["and now?"]);
  });

  it("frees the concurrency slot when a turn fails", async () => {
    const { coordinator, factory } = harness();
    factory.onCreate = (s) => s.failNextTurn();
    const r = await coordinator.runSingle("researcher", "boom");
    expect(r.isError).toBe(true);
    expect(r.stopReason).toBe("error");
    expect(coordinator.activeThreadCount).toBe(0);
  });

  it("frees the concurrency slot when the spawn itself throws", async () => {
    const { coordinator, budget } = harness();
    await expect(coordinator.runSingle("nobody", "task")).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(coordinator.activeThreadCount).toBe(0);
    expect(budget.inUse).toBe(0);
  });
});

describe("SubagentCoordinator — per-node thread budget (R6.4)", () => {
  it("rejects a spawn that would exceed the node's live-thread budget", async () => {
    const { coordinator, budget } = harness({ budgetMax: 2 });
    await coordinator.runSingle("researcher", "a");
    await coordinator.runSingle("writer", "b");
    expect(budget.inUse).toBe(2);
    expect(budget.available).toBe(0);

    // 25-per-coordinator × N coordinators would otherwise be unbounded node RAM.
    await expect(coordinator.runSingle("researcher", "c")).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("returns budget when threads are disposed", async () => {
    const { coordinator, budget } = harness({ budgetMax: 2 });
    const a = await coordinator.runSingle("researcher", "a");
    await coordinator.runSingle("writer", "b");

    await coordinator.disposeThread(a.threadId);
    expect(budget.inUse).toBe(1);

    // The freed slot is reusable.
    const c = await coordinator.runSingle("researcher", "c");
    expect(c.stopReason).toBe("completed");
    expect(budget.inUse).toBe(2);

    await coordinator.dispose();
    expect(budget.inUse).toBe(0);
  });

  it("does not charge the budget for a failed spawn", async () => {
    const { coordinator, factory, budget } = harness({ budgetMax: 2 });
    factory.failAtIndex = 0;
    await expect(coordinator.runSingle("researcher", "a")).rejects.toThrow(/factory failed/);
    expect(budget.inUse).toBe(0);
    expect(coordinator.liveThreadCount).toBe(0);
  });

  it("is shared across coordinators (it is a NODE budget)", async () => {
    const budget = new ThreadBudget(3);
    const factory = new FakeThreadSessionFactory();
    const allocator = new FakeSandboxAllocator("isolated");
    const make = (id: string): SubagentCoordinator =>
      new SubagentCoordinator({
        roster: [fakeSlot("researcher")],
        mode: "isolated",
        factory,
        sandboxAllocator: allocator,
        resolveMaterial: fakeResolveMaterial,
        primaryAgentName: "primary",
        primaryThreadId: id,
        threadBudget: budget,
      });
    const a = make("thread_a");
    const b = make("thread_b");

    await a.runParallel([
      { agent: "researcher", task: "1" },
      { agent: "researcher", task: "2" },
    ]);
    await b.runSingle("researcher", "3");
    expect(budget.inUse).toBe(3);

    await expect(b.runSingle("researcher", "4")).rejects.toMatchObject({ statusCode: 429 });

    await a.dispose();
    expect(budget.inUse).toBe(1);
    const ok = await b.runSingle("researcher", "4");
    expect(ok.stopReason).toBe("completed");

    await b.dispose();
    expect(budget.inUse).toBe(0);
  });
});
