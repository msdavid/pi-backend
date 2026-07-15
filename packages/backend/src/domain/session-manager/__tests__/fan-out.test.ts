/**
 * Multi-consumer fan-out + backpressure (R4.2 / R4.3).
 *
 * The REAL {@link ManagedSessionRuntime} (testkit fakes for the sandbox/objects/usage/
 * secrets + a scripted `AgentSessionLike`) drives one turn and we observe `subscribe()`:
 *
 * - **Fan-out (R4.2):** two concurrent subscribers EACH receive every event of the turn.
 *   Before R4.2 one shared `outbound` array + one `waiter` slot meant the two iterators
 *   *stole* events from each other — the second viewer saw a subset. This test fails on
 *   that implementation.
 * - **Backpressure (R4.3):** a subscriber that never consumes is bounded; on overflow the
 *   OLDEST events are dropped and it is handed a synthetic `session.stream_lagged` naming
 *   the position its gap starts at (`fromPosition`), so it re-fetches from the projection.
 * - **Zero subscribers buffer nothing:** durability is the `session_events` projection.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { ManagedSessionRuntime } from "../runtime.js";
import { InMemorySessionStore } from "../session-store.js";
import { STREAM_LAGGED } from "../../event-stream/stream.js";
import type { OutboundEvent } from "../../ports.js";
import type { SessionRecord } from "../types.js";
import { FakeAgentSessionFactory } from "./fake-agent-session.js";

const SESSION_ID = "sess_fanout";

function makeEnvironment(): Environment {
  return {
    id: "env_test",
    name: "test-env",
    type: "cloud",
    status: "active",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

interface Fixture {
  runtime: ManagedSessionRuntime;
  factory: FakeAgentSessionFactory;
}

function setup(opts: { maxOutboundEvents?: number } = {}): Fixture {
  const sessions = new InMemorySessionStore();
  const factory = new FakeAgentSessionFactory();

  const dir = mkdtempSync(join(tmpdir(), "pi-fanout-test-"));
  const jsonlPath = join(dir, "session.jsonl");
  writeFileSync(
    jsonlPath,
    `{"type":"session","version":3,"id":"abc","timestamp":"2026-07-13T00:00:00.000Z","cwd":"${dir}"}\n`,
  );

  const record: SessionRecord = {
    sessionId: SESSION_ID,
    tenantId: "tnt_test",
    localJsonlPath: jsonlPath,
    objectStoreKey: `sessions/${SESSION_ID}/session.jsonl`,
    material: {
      agentConfig: { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: tmpdir(),
    },
    environment: makeEnvironment(),
    vaultIds: [],
  };
  sessions.seed(record);

  const runtime = new ManagedSessionRuntime({
    sandbox: new FakeSandboxProvider(),
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions,
    factory,
    ...(opts.maxOutboundEvents !== undefined
      ? { maxOutboundEvents: opts.maxOutboundEvents }
      : {}),
  });
  return { runtime, factory };
}

/**
 * Script a minimal turn: one assistant message. The runtime emits exactly three outbound
 * events — `session.status_run_started`, `agent.message`, `session.status_idle`.
 */
function scriptOneMessageTurn(f: Fixture, text = "hi"): void {
  f.factory.last.scriptTurn(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    { type: "message_end" },
  );
}

function userMessage(content: string) {
  return {
    type: "user.message",
    id: `evt_${Math.random()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

/** Collect exactly `n` events from an iterator (rejects if the stream ends early). */
async function take(
  iter: AsyncIterator<OutboundEvent>,
  n: number,
): Promise<OutboundEvent[]> {
  const out: OutboundEvent[] = [];
  while (out.length < n) {
    const r = await iter.next();
    if (r.done) throw new Error(`stream ended after ${out.length} of ${n} events`);
    out.push(r.value);
  }
  return out;
}

describe("ManagedSessionRuntime — multi-consumer fan-out (R4.2)", () => {
  it("two concurrent subscribers EACH receive all three events of the turn", async () => {
    const f = setup();
    await f.runtime.wake(SESSION_ID);
    scriptOneMessageTurn(f, "hello");

    const a = f.runtime.subscribe()[Symbol.asyncIterator]();
    const b = f.runtime.subscribe()[Symbol.asyncIterator]();
    // Both are awaiting BEFORE the turn emits (the pre-R4.2 shared-waiter bug).
    const bothP = Promise.all([take(a, 3), take(b, 3)]);

    await f.runtime.sendEvent(userMessage("hello"));
    const [eventsA, eventsB] = await bothP;

    const expected = ["session.status_run_started", "agent.message", "session.status_idle"];
    expect(eventsA.map((e) => e.type)).toEqual(expected);
    expect(eventsB.map((e) => e.type)).toEqual(expected);
    // Same numbered universe on both connections: the SSE id is the projection position.
    expect(eventsA.map((e) => (e as { position?: number }).position)).toEqual([0, 1, 2]);
    expect(eventsB.map((e) => (e as { position?: number }).position)).toEqual([0, 1, 2]);
    expect((eventsA[1].payload as { content: string }).content).toBe("hello");
    expect((eventsB[1].payload as { content: string }).content).toBe("hello");

    await a.return?.();
    await b.return?.();
    f.runtime.dispose();
  });

  it("a subscriber that disconnects is detached; the other keeps receiving", async () => {
    const f = setup();
    await f.runtime.wake(SESSION_ID);
    scriptOneMessageTurn(f, "one");

    const a = f.runtime.subscribe()[Symbol.asyncIterator]();
    const b = f.runtime.subscribe()[Symbol.asyncIterator]();
    await b.return?.(); // client B goes away before the turn

    const eventsAP = take(a, 3);
    await f.runtime.sendEvent(userMessage("one"));
    const eventsA = await eventsAP;
    expect(eventsA.map((e) => e.type)).toEqual([
      "session.status_run_started",
      "agent.message",
      "session.status_idle",
    ]);

    await a.return?.();
    f.runtime.dispose();
  });
});

describe("ManagedSessionRuntime — backpressure (R4.3)", () => {
  it("a slow (un-consumed) subscriber is bounded and yields session.stream_lagged", async () => {
    // Bound of 1: the turn emits 3 events, so positions 0 and 1 are dropped from the head.
    const f = setup({ maxOutboundEvents: 1 });
    await f.runtime.wake(SESSION_ID);
    scriptOneMessageTurn(f, "hello");

    // Subscribe, then DON'T consume while the turn runs — the buffer overflows.
    const slow = f.runtime.subscribe()[Symbol.asyncIterator]();
    await f.runtime.sendEvent(userMessage("hello"));

    const [lag, kept] = await take(slow, 2);
    expect(lag.type).toBe(STREAM_LAGGED);
    // The gap starts at the OLDEST dropped event: position 0 (status_run_started).
    expect((lag.payload as { fromPosition: number }).fromPosition).toBe(0);
    // Only the newest event survived the bound.
    expect(kept.type).toBe("session.status_idle");
    expect((kept as { position?: number }).position).toBe(2);

    await slow.return?.();
    f.runtime.dispose();
  });

  it("a runtime with ZERO subscribers buffers nothing live (durability is the projection)", async () => {
    const f = setup({ maxOutboundEvents: 1 });
    await f.runtime.wake(SESSION_ID);
    scriptOneMessageTurn(f, "unwatched");

    // No subscriber at all: the turn's events are emitted with nowhere in-memory to go.
    await f.runtime.sendEvent(userMessage("unwatched"));

    // A subscriber attaching AFTER the turn gets no backlog — and no lag notice either
    // (it never lost anything: it reads history from the projection).
    const late = f.runtime.subscribe()[Symbol.asyncIterator]();
    const next = await Promise.race([
      late.next(),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 30)),
    ]);
    expect(next).toBe("pending");

    await late.return?.();
    f.runtime.dispose();
  });
});
