/**
 * SessionManager registry tests (R2.11 — wake race + bounded LRU).
 *
 *  - RACE: N concurrent `getOrCreate` on a cold session must wake it exactly ONCE
 *    (one sandbox provision) and hand every caller the SAME runtime instance. The
 *    pre-R2.11 check-then-act race provisioned the VM twice.
 *  - BOUND: past `maxRuntimes`, waking a new session evicts the least-recently-used
 *    IDLE runtime (a running runtime is never evicted).
 *
 * Fakes stand in for the collaborators (the subject under test is the registry, not the
 * sandbox/agent). No real Postgres or model is needed.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import type { AgentConfig, Environment } from "@pi-managed/contracts";
import { SessionManager, type SessionManagerDeps } from "../../../app.js";
import { InMemorySessionStore } from "../session-store.js";
import { FakeAgentSessionFactory } from "./fake-agent-session.js";
import type { SessionRecord } from "../types.js";

const TENANT = "tnt_registry";

const silentLogger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

function makeEnvironment(): Environment {
  return {
    id: "env_registry",
    name: "registry-env",
    type: "cloud",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    image: "ubuntu:22.04",
    resources: { cpus: 1, memoryMiB: 512 },
    networking: { mode: "unrestricted" },
  };
}

function makeRecord(sessionId: string): SessionRecord {
  const dir = mkdtempSync(join(tmpdir(), `pi-registry-${sessionId}-`));
  return {
    sessionId,
    tenantId: TENANT,
    localJsonlPath: join(dir, "log.jsonl"),
    objectStoreKey: `tenants/${TENANT}/sessions/${sessionId}/log.jsonl`,
    material: {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: dir,
    },
    environment: makeEnvironment(),
    vaultIds: [],
  };
}

function makeManager(
  store: InMemorySessionStore,
  overrides: Partial<SessionManagerDeps> = {},
): { manager: SessionManager; sandbox: FakeSandboxProvider } {
  const sandbox = new FakeSandboxProvider();
  const manager = new SessionManager({
    sandbox,
    objects: new FakeObjectStore(),
    usage: new FakeUsageRecorder(),
    secrets: new FakeSecretStore(),
    sessions: store,
    factory: new FakeAgentSessionFactory(),
    // Large idle timeout so the idle-eviction timer never fires mid-test.
    idleTimeoutMs: 60_000,
    maxRuntimes: 256,
    logger: silentLogger,
    ...overrides,
  });
  return { manager, sandbox };
}

describe("SessionManager registry (R2.11)", () => {
  it("3 concurrent getOrCreate on a cold session provision exactly once (same instance)", async () => {
    const store = new InMemorySessionStore();
    const sessionId = "sess_race";
    store.seed(makeRecord(sessionId));
    const { manager, sandbox } = makeManager(store);

    const [a, b, c] = await Promise.all([
      manager.getOrCreate(sessionId),
      manager.getOrCreate(sessionId),
      manager.getOrCreate(sessionId),
    ]);

    // Same runtime instance handed to every caller.
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly ONE provision (the race did not double-provision).
    const provisions = sandbox.calls.filter((k) => k.kind === "provision").length;
    expect(provisions).toBe(1);
    expect(manager.size).toBe(1);

    await manager.disposeAll();
  });

  it("evicts the LRU idle runtime once the registry exceeds maxRuntimes", async () => {
    const store = new InMemorySessionStore();
    for (const id of ["s1", "s2", "s3"]) store.seed(makeRecord(id));
    const { manager } = makeManager(store, { maxRuntimes: 2 });

    const r1 = await manager.getOrCreate("s1");
    await manager.getOrCreate("s2");
    // Both idle after wake.
    expect(r1.status()).toBe("idle");
    expect(manager.size).toBe(2);

    // Waking s3 exceeds the cap → evict the oldest idle runtime (s1).
    await manager.getOrCreate("s3");
    expect(manager.size).toBe(2);
    expect(manager.getRuntime("s1")).toBeUndefined();
    expect(manager.getRuntime("s2")).toBeDefined();
    expect(manager.getRuntime("s3")).toBeDefined();

    await manager.disposeAll();
  });

  it("does not evict a RUNNING runtime when the idle timer fires (finding #4)", async () => {
    const store = new InMemorySessionStore();
    store.seed(makeRecord("srun"));
    const factory = new FakeAgentSessionFactory();
    // Tiny idle timeout so the eviction timer fires during the held turn.
    const { manager } = makeManager(store, { factory, idleTimeoutMs: 20 });

    const rt = await manager.getRuntime("srun") ?? (await manager.getOrCreate("srun"));
    // Hold the turn so the runtime stays `running` well past the idle timeout.
    factory.last.holdNextPrompt();
    const turn = rt.sendEvent({
      type: "user.message",
      id: "evt_run",
      createdAt: new Date().toISOString(),
      payload: { content: "go" },
    });

    // Wait several idle-timeout periods; the running-guard must reschedule, never dispose.
    await new Promise((r) => setTimeout(r, 100));
    expect(rt.status()).toBe("running");
    expect(manager.getRuntime("srun")).toBeDefined();

    // Settle the turn → idle; the runtime is now eligible for idle eviction again.
    factory.last.release();
    await turn;
    expect(rt.status()).toBe("idle");

    await manager.disposeAll();
  });
});
