/**
 * Integration tests for {@link ManagedSessionRuntime} (WP-1.5).
 *
 * Uses testkit fakes (FakeSandboxProvider, FakeObjectStore, FakeUsageRecorder,
 * FakeSecretStore) + a {@link FakeAgentSessionFactory} that records calls and emits
 * scripted `AgentSessionEvent`s. The orchestration logic (state machine, idle policy,
 * crash recovery, JSONL sync, usage/budget) is the REAL runtime — only the Pi
 * `createAgentSession()` call is stubbed (it needs a live model provider).
 *
 * Covers: full lifecycle (idle→running→idle), JSONL sync points, kill-and-wake
 * recovery, idle-policy checkpoint, crash recovery, transient retry, and the §4.2
 * isolation invariant (no process-global Pi config read).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import { ManagedSessionRuntime } from "../runtime.js";
import { InMemorySessionStore } from "../session-store.js";
import { buildInMemoryAuthData } from "../materialize.js";
import type { OutboundEvent } from "../../ports.js";
import type { ResolvedAgentMaterial, SessionRecord } from "../types.js";
import { FakeAgentSession, FakeAgentSessionFactory } from "./fake-agent-session.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvironment(opts: { idleTimeoutSeconds?: number } = {}): Environment {
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
    idleTimeout: opts.idleTimeoutSeconds,
  };
}

function makeMaterial(
  overrides: Partial<ResolvedAgentMaterial> = {},
): ResolvedAgentMaterial {
  return {
    agentConfig: {
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    } as AgentConfig,
    providerKeys: { anthropic: "sk-test-managed-key" },
    cwd: tmpdir(),
    ...overrides,
  };
}

interface Fixture {
  sandbox: FakeSandboxProvider;
  objects: FakeObjectStore;
  usage: FakeUsageRecorder;
  secrets: FakeSecretStore;
  sessions: InMemorySessionStore;
  factory: FakeAgentSessionFactory;
  runtime: ManagedSessionRuntime;
  record: SessionRecord;
  jsonlPath: string;
}

function setup(opts: {
  idleTimeoutSeconds?: number;
  budget?: { maxTokens?: number; maxUsd?: number };
  material?: Partial<ResolvedAgentMaterial>;
} = {}): Fixture {
  const sandbox = new FakeSandboxProvider();
  const objects = new FakeObjectStore();
  const usage = new FakeUsageRecorder();
  const secrets = new FakeSecretStore();
  const sessions = new InMemorySessionStore();
  const factory = new FakeAgentSessionFactory();

  const dir = mkdtempSync(join(tmpdir(), "pi-sm-test-"));
  const jsonlPath = join(dir, "session.jsonl");
  writeFileSync(
    jsonlPath,
    `{"type":"session","version":3,"id":"abc","timestamp":"2026-07-13T00:00:00.000Z","cwd":"${dir}"}\n`,
  );

  const material = makeMaterial(opts.material);
  const record: SessionRecord = {
    sessionId: "sess_test",
    tenantId: "tnt_test",
    localJsonlPath: jsonlPath,
    objectStoreKey: "sessions/sess_test/session.jsonl",
    material,
    environment: makeEnvironment({ idleTimeoutSeconds: opts.idleTimeoutSeconds }),
    budget: opts.budget,
    vaultIds: [],
  };
  sessions.seed(record);

  const runtime = new ManagedSessionRuntime({
    sandbox,
    objects,
    usage,
    secrets,
    sessions,
    factory,
  });
  return { sandbox, objects, usage, secrets, sessions, factory, runtime, record, jsonlPath };
}

/** Drain the outbound stream until it's been quiet for `quietMs`. */
async function drainQuiet(
  runtime: ManagedSessionRuntime,
  quietMs = 30,
  maxMs = 800,
): Promise<OutboundEvent[]> {
  const out: OutboundEvent[] = [];
  const iter = runtime.subscribe()[Symbol.asyncIterator]();
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const r = await Promise.race([
      iter.next(),
      delay(quietMs).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (r.done) {
      if (out.length > 0) break;
      continue;
    }
    out.push(r.value as OutboundEvent);
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userMessage(content: string) {
  return {
    type: "user.message",
    id: `evt_${Math.random()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

/** Script the fake session to emit a one-message turn with usage. */
function scriptTurn(session: FakeAgentSession, text = "hello") {
  session.scriptTurn(
    { type: "turn_start" },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `Hi: ${text}` },
    },
    { type: "message_end" },
    {
      type: "turn_end",
      message: {
        model: "claude-sonnet-4-5",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      },
    },
    {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          model: "claude-sonnet-4-5",
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        },
      ],
      willRetry: false,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManagedSessionRuntime lifecycle", () => {
  let envBackup: NodeJS.ProcessEnv;
  beforeEach(() => {
    envBackup = { ...process.env };
  });
  afterEach(() => {
    process.env = envBackup;
    vi.useRealTimers();
  });

  it("wake → idle, then a full turn idle→running→idle with usage recorded", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    expect(f.runtime.status()).toBe("idle");
    expect(f.factory.optionsLog).toHaveLength(1);
    // Sandbox provisioned on first wake.
    expect(f.sandbox.calls.some((c) => c.kind === "provision")).toBe(true);

    scriptTurn(f.factory.last, "hello");
    const eventsP = drainQuiet(f.runtime);
    await f.runtime.sendEvent(userMessage("hello"));
    const events = await eventsP;

    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_run_started");
    expect(types).toContain("span.model_request_start");
    expect(types).toContain("agent.message");
    expect(types).toContain("span.model_request_end");
    expect(types).toContain("session.status_idle");
    expect(f.runtime.status()).toBe("idle");

    // The status_idle carries the completed stop reason (in payload).
    const idleEvt = events.find((e) => e.type === "session.status_idle");
    expect((idleEvt!.payload as { stopReason?: string }).stopReason).toBe(
      "completed",
    );

    // Usage recorded EXACTLY once per model request (ROB-7): `turn_end` is the single
    // billing source; `agent_end` re-carries the same message and no longer double-counts.
    const usage = await f.usage.cumulativeForSession("sess_test");
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    f.runtime.dispose();
  });

  it("JSONL is synced to the object store on the idle transition", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    scriptTurn(f.factory.last, "hi");
    await f.runtime.sendEvent(userMessage("hi"));

    // The sync ran on the idle transition (conditional=false first sync).
    const syncEvents = f.runtime.jsonlSync.events.filter(
      (e) => e.kind === "sync",
    );
    expect(syncEvents.length).toBeGreaterThanOrEqual(1);
    expect((syncEvents[0] as { conditional: boolean }).conditional).toBe(false);

    // The object store now holds the JSONL key.
    const keys: string[] = [];
    for await (const meta of f.objects.list("sessions/sess_test")) {
      keys.push(meta.key);
    }
    expect(keys).toContain("sessions/sess_test/session.jsonl");

    // The etag was persisted to the session store.
    const after = await f.sessions.get("sess_test");
    expect(after?.lastSyncedEtag).toBeDefined();
    f.runtime.dispose();
  });

  it("idle policy checkpoints the sandbox after idleTimeout (§10.3)", async () => {
    vi.useFakeTimers();
    const f = setup({ idleTimeoutSeconds: 2 }); // 2000ms
    await f.runtime.wake("sess_test");
    scriptTurn(f.factory.last, "hi");
    const sendP = f.runtime.sendEvent(userMessage("hi"));
    await vi.advanceTimersByTimeAsync(50);
    await sendP;

    // Turn settled → idle policy scheduled a stop.
    expect(f.runtime.idlePolicy.hasPending).toBe(true);
    expect(f.sandbox.calls.some((c) => c.kind === "stop")).toBe(false);

    // Advance past the idle timeout → provider.stop fires.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.sandbox.calls.some((c) => c.kind === "stop")).toBe(true);
    f.runtime.dispose();
  });

  it("resume from a stopped sandbox surfaces 'processes not preserved' (§10.3)", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    // Force the sandbox into the stopped state (checkpointed) before the next turn.
    await f.sandbox.stop(f.runtime.sandboxHandle!);

    scriptTurn(f.factory.last, "hello");
    await f.runtime.sendEvent(userMessage("hello"));

    // A steer with the resume note was issued before the prompt.
    const steered = f.factory.last.calls.steer.some((s) =>
      /cold-rebooted|processes were NOT/i.test(s),
    );
    expect(steered).toBe(true);
    // And the sandbox was started again.
    expect(f.sandbox.calls.some((c) => c.kind === "start")).toBe(true);
    f.runtime.dispose();
  });
});

describe("ManagedSessionRuntime kill-and-wake recovery", () => {
  it("a fresh runtime resumes from the persisted JSONL + session store", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    scriptTurn(f.factory.last, "first");
    await f.runtime.sendEvent(userMessage("first"));
    expect(f.runtime.status()).toBe("idle");
    const firstSessionId = f.factory.last.sessionId;
    f.runtime.dispose();

    // Simulate a crash/destroy: build a brand-new runtime sharing the same store +
    // object store (the JSONL is durable). A fresh AgentSession binds to the JSONL.
    const runtime2 = new ManagedSessionRuntime({
      sandbox: f.sandbox,
      objects: f.objects,
      usage: f.usage,
      secrets: f.secrets,
      sessions: f.sessions,
      factory: f.factory,
    });
    await runtime2.wake("sess_test");
    expect(runtime2.status()).toBe("idle");
    expect(f.factory.created.length).toBe(2); // a fresh session was booted
    expect(f.factory.last.sessionId).toBe(firstSessionId); // same bound session id

    // It can run another turn.
    scriptTurn(f.factory.last, "second");
    await runtime2.sendEvent(userMessage("second"));
    expect(runtime2.status()).toBe("idle");
    runtime2.dispose();
  });

  it("getEntries returns a positional slice of the JSONL tree", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    f.factory.last.seedEntries([
      { type: "message", id: "a1", parentId: null, timestamp: "2026-07-13T00:00:01.000Z", message: { role: "user", content: "hi" } },
      { type: "message", id: "b2", parentId: "a1", timestamp: "2026-07-13T00:00:02.000Z", message: { role: "assistant", content: [] } },
      { type: "message", id: "c3", parentId: "b2", timestamp: "2026-07-13T00:00:03.000Z", message: { role: "user", content: "again" } },
    ] as never);
    const all = await f.runtime.getEntries();
    expect(all.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(all[0].type).toBe("message");
    expect(all[0].id).toBe("a1");

    const slice = await f.runtime.getEntries({ start: 1, end: 3 });
    expect(slice.map((e) => e.position)).toEqual([1, 2]);

    const limited = await f.runtime.getEntries({ limit: 1 });
    expect(limited.map((e) => e.position)).toEqual([0]);
    f.runtime.dispose();
  });
});

describe("ManagedSessionRuntime crash recovery (§10.3)", () => {
  it("re-provisions + cold-reboots a crashed sandbox transparently", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    const originalHandle = f.runtime.sandboxHandle!;

    // Simulate a crash: the provider reports "crashed" on the next status poll.
    f.sandbox.setNextStatus("crashed");
    const recovered = await f.runtime.crashRecovery.pollOnce({
      handle: originalHandle,
      provisionSpec: f.runtime.currentProvisionSpec!,
    });

    expect(recovered).not.toBeNull();
    expect(f.runtime.crashRecovery.events.some((e) => e.kind === "crashed")).toBe(true);
    expect(f.runtime.crashRecovery.events.some((e) => e.kind === "reprovisioned")).toBe(true);
    expect(f.runtime.crashRecovery.events.some((e) => e.kind === "started")).toBe(true);
    // A fresh sandbox was provisioned + started.
    expect(f.sandbox.calls.filter((c) => c.kind === "provision").length).toBeGreaterThanOrEqual(2);
    expect(f.sandbox.calls.some((c) => c.kind === "start")).toBe(true);
    f.runtime.dispose();
  });

  it("wake re-provisions a crashed sandbox on resume", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    const handle = f.runtime.sandboxHandle!;
    // Mark the existing sandbox crashed, then re-wake (e.g. after a backend restart).
    f.sandbox.setNextStatus("crashed");
    // The session store still references the (now crashed) handle.
    const record = await f.sessions.get("sess_test")!;
    (record as SessionRecord).sandboxHandle = handle;
    await f.sessions.seed(record);

    const runtime2 = new ManagedSessionRuntime({
      sandbox: f.sandbox,
      objects: f.objects,
      usage: f.usage,
      secrets: f.secrets,
      sessions: f.sessions,
      factory: f.factory,
    });
    await runtime2.wake("sess_test");
    expect(runtime2.status()).toBe("idle");
    // Re-provisioned + cold-rebooted.
    expect(f.sandbox.calls.some((c) => c.kind === "start")).toBe(true);
    runtime2.dispose();
    f.runtime.dispose();
  });

  it("a crashed-sandbox re-provision carries the session's secret bindings (ROB-2)", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    // The session has an env-var secret binding resolved from its vault.
    f.secrets.scriptForSession("sess_test", [
      {
        placeholderName: "$MSB_API_TOKEN",
        category: "environment_variable",
        credentialRef: { tenantId: "tnt_test", vaultId: "vault_1", credentialKey: "API_TOKEN" },
      },
    ]);
    await f.runtime.wake("sess_test");
    const handle = f.runtime.sandboxHandle!;
    // Prove the RE-PROVISION path (not just first wake) carries the bindings: clear what the
    // first-wake provision registered, mark the VM crashed, and re-wake a fresh runtime.
    f.sandbox.registeredBindings.clear();
    f.sandbox.setNextStatus("crashed");
    const record = (await f.sessions.get("sess_test"))!;
    (record as SessionRecord).sandboxHandle = handle;
    await f.sessions.seed(record);

    const runtime2 = new ManagedSessionRuntime({
      sandbox: f.sandbox,
      objects: f.objects,
      usage: f.usage,
      secrets: f.secrets,
      sessions: f.sessions,
      factory: f.factory,
    });
    await runtime2.wake("sess_test");

    // The freshly provisioned VM was created WITH the $MSB_* secret binding (pre-ROB-2 the
    // re-provision path dropped it, so the guest lost every secret after a crash).
    const registered = [...f.sandbox.registeredBindings.values()].flat();
    expect(registered.map((b) => b.placeholderName)).toContain("$MSB_API_TOKEN");
    runtime2.dispose();
    f.runtime.dispose();
  });
});

describe("ManagedSessionRuntime transient retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retries a transient prompt failure with backoff, then completes", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    // Fail twice transiently, then succeed.
    f.factory.last.failTransiently(2);
    scriptTurn(f.factory.last, "retry-ok");

    const sendP = f.runtime.sendEvent(userMessage("go"));
    // Advance through the two backoff delays (1s + 4s).
    await vi.advanceTimersByTimeAsync(5_000);
    await sendP;

    expect(f.runtime.status()).toBe("idle");
    expect(f.factory.last.calls.prompt).toEqual(["go", "go", "go"]); // 2 retries + success
    f.runtime.dispose();
  });

  it("terminates after 3 failed retries", async () => {
    const f = setup({ idleTimeoutSeconds: 600 });
    await f.runtime.wake("sess_test");
    f.factory.last.failTransiently(5); // always fails

    const sendP = f.runtime.sendEvent(userMessage("doom"));
    await vi.advanceTimersByTimeAsync(30_000);
    await sendP;

    expect(f.runtime.status()).toBe("terminated");
    // 1 initial + 3 retries = 4 attempts.
    expect(f.factory.last.calls.prompt).toHaveLength(4);
    f.runtime.dispose();
  });
});

describe("§4.2 isolation — no process-global Pi config", () => {
  beforeEach(() => {
    // Seed process env with a "leaked" key that must NEVER be used.
    process.env.ANTHROPIC_API_KEY = "sk-leaked-from-env";
    process.env.OPENAI_API_KEY = "sk-openai-leaked";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.useRealTimers();
  });

  it("buildInMemoryAuthData uses only providerKeys, never process.env", () => {
    const data = buildInMemoryAuthData({ anthropic: "sk-managed" });
    expect(data.anthropic).toEqual({ type: "api_key", key: "sk-managed" });
    expect(data.openai).toBeUndefined();
    // The leaked env keys are absent.
    expect(JSON.stringify(data)).not.toContain("leaked");
  });

  it("the runtime forwards only the material's providerKeys to the factory", async () => {
    const f = setup({
      idleTimeoutSeconds: 600,
      material: { providerKeys: { anthropic: "sk-managed-session-key" } },
    });
    await f.runtime.wake("sess_test");

    const opts = f.factory.optionsLog[0]!;
    expect(opts.material.providerKeys).toEqual({
      anthropic: "sk-managed-session-key",
    });
    // The leaked env key did NOT leak into the material's provider keys.
    expect(opts.material.providerKeys.anthropic).not.toBe("sk-leaked-from-env");
    expect(Object.keys(opts.material.providerKeys)).not.toContain("openai");
    f.runtime.dispose();
  });
});
