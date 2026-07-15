/**
 * Regression tests for the audit-fix pass.
 *
 * - **Event position is DB-authoritative (finding #1).** The runtime sources every event's
 *   SSE `id` from the projection `append` (not a second in-memory counter), so a failed
 *   append drops that event from BOTH the live tail and the persisted projection
 *   consistently — the next event still takes a contiguous position and the live `id`
 *   always equals the persisted position. The pre-fix bug: emit stamped `nextPosition++`
 *   while `append` assigned `MAX(position)+1`, and a swallowed append failure desynced the
 *   two forever, silently skipping events on `Last-Event-ID` reconnect.
 * - **A transient append failure is retried, not dropped.**
 * - **`system.message` rebuilds the system prompt (finding #7)** via `setSystemPrompt`, not
 *   a `[system]` steering note.
 * - **The per-session `mkdtemp` agent dir is removed on dispose (finding #7).**
 */

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
import type { SessionEventsStore } from "../session-events-store.js";
import type { EntryRange, SessionEntry, SessionId, TenantId } from "../../ports.js";
import type { OutboundEvent } from "../../ports.js";
import type { SessionRecord } from "../types.js";
import { FakeAgentSessionFactory } from "./fake-agent-session.js";

const SESSION_ID = "sess_audit";

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

/**
 * In-memory projection with the real store's `MAX(position)+1` + idempotent-on-event-id
 * semantics, plus controllable failure so a divergence can be forced. Structurally stands
 * in for {@link SessionEventsStore}.
 */
class ControllableEventsStore {
  readonly rows: { position: number; event: { id: string; type: string } }[] = [];
  /** Event types whose append ALWAYS throws (permanent drop). */
  readonly failTypes = new Set<string>();
  /** Event type → remaining transient failures before it succeeds. */
  readonly transientFailsByType = new Map<string, number>();

  append(
    _tenantId: TenantId,
    _sessionId: SessionId,
    event: { id: string; type: string; createdAt: string; payload: unknown },
  ): Promise<number> {
    if (this.failTypes.has(event.type)) {
      return Promise.reject(new Error("append boom (permanent)"));
    }
    const transient = this.transientFailsByType.get(event.type) ?? 0;
    if (transient > 0) {
      this.transientFailsByType.set(event.type, transient - 1);
      return Promise.reject(new Error("append boom (transient)"));
    }
    const existing = this.rows.find((r) => r.event.id === event.id);
    if (existing) return Promise.resolve(existing.position);
    const position =
      this.rows.length === 0
        ? 0
        : Math.max(...this.rows.map((r) => r.position)) + 1;
    this.rows.push({ position, event: { id: event.id, type: event.type } });
    return Promise.resolve(position);
  }

  read(_sessionId: SessionId, _range?: EntryRange): Promise<SessionEntry[]> {
    return Promise.resolve([]);
  }
  head(_sessionId: SessionId): Promise<number> {
    return Promise.resolve(
      this.rows.length === 0 ? 0 : Math.max(...this.rows.map((r) => r.position)) + 1,
    );
  }
  count(_sessionId: SessionId): Promise<number> {
    return Promise.resolve(this.rows.length);
  }
}

interface Fixture {
  runtime: ManagedSessionRuntime;
  factory: FakeAgentSessionFactory;
  events: ControllableEventsStore;
  agentDir: string;
}

function setup(): Fixture {
  const sessions = new InMemorySessionStore();
  const factory = new FakeAgentSessionFactory();
  const events = new ControllableEventsStore();

  const dir = mkdtempSync(join(tmpdir(), "pi-audit-test-"));
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
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
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
    // Structural stand-in for the Postgres-backed projection.
    events: events as unknown as SessionEventsStore,
  });
  return { runtime, factory, events, agentDir: dir };
}

function userMessage(content: string): OutboundEvent {
  return {
    type: "user.message",
    id: `evt_${Math.random()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  } as unknown as OutboundEvent;
}

/** Collect exactly `n` events from an iterator (rejects if the stream ends early). */
async function take(
  iter: AsyncIterator<OutboundEvent>,
  n: number,
): Promise<(OutboundEvent & { position?: number })[]> {
  const out: (OutboundEvent & { position?: number })[] = [];
  while (out.length < n) {
    const r = await iter.next();
    if (r.done) throw new Error(`stream ended after ${out.length} of ${n} events`);
    out.push(r.value as OutboundEvent & { position?: number });
  }
  return out;
}

describe("audit fix — event position is DB-authoritative (finding #1)", () => {
  it("live SSE ids equal persisted positions across a clean turn", async () => {
    const f = setup();
    await f.runtime.wake(SESSION_ID);
    const iter = f.runtime.subscribe()[Symbol.asyncIterator]();
    f.factory.last.scriptTurn(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end" },
    );
    await f.runtime.sendEvent(userMessage("go"));
    // run_started, agent.message, status_idle
    const live = await take(iter, 3);
    const livePositions = live.map((e) => e.position);
    const persisted = f.events.rows.map((r) => r.position);
    expect(livePositions).toEqual([0, 1, 2]);
    expect(persisted).toEqual([0, 1, 2]);
  });

  it("a permanently failing append drops the event from BOTH surfaces without desyncing positions", async () => {
    const f = setup();
    // Force the middle event (the agent message) to never persist.
    f.events.failTypes.add("agent.message");
    await f.runtime.wake(SESSION_ID);
    const iter = f.runtime.subscribe()[Symbol.asyncIterator]();
    f.factory.last.scriptTurn(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end" },
    );
    await f.runtime.sendEvent(userMessage("go"));
    // Only run_started + status_idle survive (agent.message's append failed).
    const live = await take(iter, 2);
    const liveTypes = live.map((e) => e.type);
    const livePositions = live.map((e) => e.position);
    expect(liveTypes).not.toContain("agent.message");
    // Live ids are contiguous AND equal the persisted positions — no divergence.
    expect(livePositions).toEqual([0, 1]);
    expect(f.events.rows.map((r) => r.position)).toEqual([0, 1]);
    expect(f.events.rows.map((r) => r.event.type)).not.toContain("agent.message");
  });

  it("a transient append failure is retried, not dropped", async () => {
    const f = setup();
    f.events.transientFailsByType.set("agent.message", 1); // fail once, then succeed
    await f.runtime.wake(SESSION_ID);
    const iter = f.runtime.subscribe()[Symbol.asyncIterator]();
    f.factory.last.scriptTurn(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } },
      { type: "message_end" },
    );
    await f.runtime.sendEvent(userMessage("go"));
    const live = await take(iter, 3);
    expect(live.map((e) => e.type)).toContain("agent.message");
    expect(live.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(f.events.rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });
});

describe("audit fix — system.message rebuilds the prompt + mkdtemp cleanup (finding #7)", () => {
  it("system.message calls setSystemPrompt (not a [system] steer)", async () => {
    const f = setup();
    await f.runtime.wake(SESSION_ID);
    await f.runtime.sendEvent({
      type: "system.message",
      id: "evt_sys",
      createdAt: new Date().toISOString(),
      payload: { content: "new system directive" },
    } as unknown as OutboundEvent);
    expect(f.factory.last.setSystemPromptCalls).toEqual(["new system directive"]);
    expect(f.factory.last.calls.steer).toHaveLength(0);
  });

  it("dispose removes the per-session mkdtemp agent dir", async () => {
    const f = setup();
    await f.runtime.wake(SESSION_ID);
    // The real factory sets agentDir; the fake does not, so simulate it with a real dir.
    const leaked = mkdtempSync(join(tmpdir(), "pi-agent-leak-"));
    f.factory.last.agentDir = leaked;
    expect(existsSync(leaked)).toBe(true);
    f.runtime.dispose();
    expect(existsSync(leaked)).toBe(false);
  });
});
