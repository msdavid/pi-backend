/**
 * R7.1 — session-worker process pool: harness blast radius.
 *
 * Drives the REAL composition root (`createManagedApp`) with `SESSION_WORKER_MODE=pool`
 * against a real Postgres (testcontainers/podman) and real forked child processes running
 * the compiled worker entry. Nothing about the pool is faked: the children are real
 * processes, the IPC is the real protocol, the runtimes inside them are real
 * `ManagedSessionRuntime`s writing to the real `session_events` projection. Only two
 * collaborators are substituted inside the worker (via `SESSION_WORKER_OVERRIDES_MODULE`,
 * the same seam `createManagedApp({ sandboxProvider, factory })` is for the in-process
 * path): a cross-process file-backed fake sandbox and a model-less agent-session factory.
 *
 * Asserts:
 *  (a) sessions run in CHILD processes (the sandbox is provisioned by a worker PID, not
 *      ours; two sessions on different shards are provisioned by different PIDs), and their
 *      events still reach the SSE fan-out AND the `session_events` projection;
 *  (b) SIGKILLing one child does not affect a session on another child;
 *  (c) the killed child's session recovers on the next `getOrCreate` — it re-attaches the
 *      SAME sandbox (provision count stays 1, persisted handle unchanged) on a NEW child;
 *  (d) `inproc` mode (the default) is unchanged: the runtime is an in-process
 *      `ManagedSessionRuntime` and no pool exists.
 *
 * The children run `dist/domain/session-worker/worker-entry.js` — Node cannot execute the
 * TS sources (parameter properties are not erasable) — so the suite compiles the backend
 * first. That is exactly the artifact production forks.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import type { Config } from "../../../infra/config/index.js";
import { query, type Pool, type TenantCtx } from "../../../infra/db/index.js";
import {
  hasContainerRuntime,
  startPostgres,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createManagedApp, type ManagedApp } from "../../../app.js";
import { ManagedSessionRuntime } from "../../session-manager/index.js";
import { FakeAgentSessionFactory } from "../../session-manager/__tests__/fake-agent-session.js";
import { createTenant } from "../../tenant/tenant.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/index.js";
import type { InboundEvent, OutboundEvent } from "../../ports.js";
import { shardFor } from "../protocol.js";

const execFileAsync = promisify(execFile);
const TEST_KEY = "0".repeat(64);
const silentLogger = pino({ level: "silent" });
const WORKERS = 2;

const here = dirname(fileURLToPath(import.meta.url));
/** packages/backend */
const backendRoot = resolve(here, "../../../..");
/** repo root (workspace) */
const repoRoot = resolve(backendRoot, "../..");
const overridesModule = join(here, "fixtures", "worker-overrides.mjs");

interface SandboxRecord {
  name: string;
  labels: { tenant: string; session: string };
  provisions: number;
  provisionedByPid: number;
  status: string;
}

interface SandboxState {
  sandboxes: Record<string, SandboxRecord>;
}

function userMessage(content: string): InboundEvent {
  return {
    type: "user.message",
    id: `evt_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    payload: { content },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("shardFor (R7.1)", () => {
  it("is deterministic and bounded", () => {
    for (const id of ["ses_a", "ses_b", "ses_c", "ses_zzz"]) {
      const first = shardFor(id, 4);
      expect(shardFor(id, 4)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(4);
    }
    expect(shardFor("anything", 1)).toBe(0);
  });
});

const d = hasContainerRuntime("session-worker pool suite") ? describe : describe.skip;

d("session-worker process pool (R7.1)", () => {
  let db: TestDb;
  let managed: ManagedApp;
  let pool: Pool;
  let ctx: TenantCtx;
  let statePath: string;
  let sessionA: string; // shard 0
  let sessionB: string; // shard 1

  const sandboxState = (): SandboxState =>
    JSON.parse(readFileSync(statePath, "utf8")) as SandboxState;

  /** The sandbox provisioned for `sessionId` (the VM name is slugified; labels are not). */
  const sandboxOf = (sessionId: string): SandboxRecord | undefined =>
    Object.values(sandboxState().sandboxes).find(
      (sb) => sb.labels?.session === sessionId,
    );

  beforeAll(async () => {
    process.env.VAULT_KEY = TEST_KEY;

    // The children run the compiled entry (production's artifact) — build it.
    await execFileAsync(
      process.execPath,
      [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", backendRoot],
      { cwd: backendRoot },
    );

    db = await startPostgres();

    const dir = mkdtempSync(join(tmpdir(), "pi-session-workers-"));
    statePath = join(dir, "sandboxes.json");
    writeFileSync(statePath, JSON.stringify({ sandboxes: {} }));
    // Inherited by every forked worker (the fake sandbox's cross-process registry).
    process.env.PI_TEST_SANDBOX_STATE = statePath;

    const config = {
      port: 3000,
      logLevel: "silent",
      objectStoreRoot: join(dir, "objectstore"),
      sessionLocalDir: join(dir, "sessions"),
      sandboxRuntime: "disabled", // the PARENT needs no sandbox in pool mode
      sandboxMode: "single",
      dbUrl: db.connectionString,
      sessionWorkerMode: "pool",
      sessionWorkerCount: WORKERS,
      sessionWorkerMaxSessions: 8,
      sessionWorkerOverridesModule: overridesModule,
    } as Config;

    managed = await createManagedApp({ config, logger: silentLogger });
    pool = managed.pool;

    const tenant = await createTenant(pool, { name: "Pool Tenant" });
    ctx = { tenantId: tenant.id };
    const agent = await createAgent(pool, ctx, {
      name: "pool-agent",
      model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
    const env = await createEnvironment(pool, ctx, {
      name: "pool-env",
      type: "cloud",
    });

    // Two sessions that shard onto DIFFERENT workers (ids are random, so create until we
    // have one on each shard — the shard function is deterministic, so this is stable).
    const byShard = new Map<number, string>();
    for (let i = 0; i < 40 && byShard.size < WORKERS; i++) {
      const s = await createSession(pool, ctx, {
        agent: agent.id,
        environmentId: env.id,
      });
      const shard = shardFor(s.id, WORKERS);
      if (!byShard.has(shard)) byShard.set(shard, s.id);
    }
    sessionA = byShard.get(0)!;
    sessionB = byShard.get(1)!;
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await managed?.close();
    await db?.container.stop();
    delete process.env.PI_TEST_SANDBOX_STATE;
  });

  it("(a) runs sessions in child processes, and their events reach the fan-out + projection", async () => {
    const workers = managed.sessionWorkers!;
    expect(workers.workerCount).toBe(WORKERS);

    const rtA = await managed.sessionManager.getOrCreate(sessionA);
    const rtB = await managed.sessionManager.getOrCreate(sessionB);

    // The registry holds proxies, NOT in-process runtimes.
    expect(managed.sessionManager.getRuntime(sessionA)).toBeUndefined();
    expect(managed.sessionManager.getRuntime(sessionB)).toBeUndefined();

    const pidA = workers.pidFor(sessionA);
    const pidB = workers.pidFor(sessionB);
    expect(pidA).toBeDefined();
    expect(pidB).toBeDefined();
    expect(pidA).not.toBe(process.pid);
    expect(pidB).not.toBe(process.pid);
    expect(pidA).not.toBe(pidB); // different shards ⇒ different processes

    // Ground truth from the sandbox registry: each session's VM was provisioned BY its
    // worker's process, not by ours.
    expect(sandboxOf(sessionA)?.provisionedByPid).toBe(pidA);
    expect(sandboxOf(sessionB)?.provisionedByPid).toBe(pidB);

    // Live fan-out: the SSE path (`subscribe()`) sees the child's events…
    const seen: OutboundEvent[] = [];
    const iterator = rtA.subscribe()[Symbol.asyncIterator]();
    const collect = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value);
        if (seen.length >= 2) return;
      }
    })();

    await rtA.sendEvent(userMessage("hello from the parent"));
    await rtB.sendEvent(userMessage("hello from the parent"));
    await collect;

    expect(seen.map((e) => e.type)).toContain("session.status_run_started");
    // …and the child persisted the SAME numbered events into `session_events` (R4.1).
    const { rows } = await query<{ n: string }>(
      pool,
      `SELECT count(*) AS n FROM session_events WHERE session_id = $1`,
      [sessionA],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    expect(await managed.eventsStore.head(sessionA)).toBeGreaterThan(0);
  }, 60_000);

  it("(b) killing one child leaves sessions on other children untouched", async () => {
    const workers = managed.sessionWorkers!;
    const pidA = workers.pidFor(sessionA)!;
    const pidB = workers.pidFor(sessionB)!;
    const headBBefore = await managed.eventsStore.head(sessionB);

    process.kill(pidA, "SIGKILL");
    // The parent observes the exit, forgets A's session, and respawns worker 0.
    expect(await waitFor(() => workers.pidFor(sessionA) !== pidA)).toBe(true);

    // B's worker is untouched and B's session is still live and still driving turns.
    expect(workers.pidFor(sessionB)).toBe(pidB);
    const rtB = managed.sessionManager.activeRuntime(sessionB)!;
    expect(rtB).toBeDefined();
    await rtB.sendEvent(userMessage("still alive?"));
    expect(await managed.eventsStore.head(sessionB)).toBeGreaterThan(headBBefore);
    expect(rtB.status()).toBe("idle");
  }, 60_000);

  it("(c) a killed child's session recovers (re-attach) on the next getOrCreate", async () => {
    const workers = managed.sessionWorkers!;
    const provisionsBefore = sandboxOf(sessionA)!.provisions;
    expect(provisionsBefore).toBe(1);
    const { rows: before } = await query<{ h: string | null }>(
      pool,
      `SELECT sandbox_handle AS h FROM sessions WHERE id = $1`,
      [sessionA],
    );

    // The proxy was dropped when the child died (blast radius = that child's sessions).
    expect(managed.sessionManager.activeRuntime(sessionA)).toBeUndefined();

    const rtA = await managed.sessionManager.getOrCreate(sessionA);
    const newPid = workers.pidFor(sessionA);
    expect(newPid).toBeDefined();
    expect(newPid).not.toBe(process.pid);

    // Re-attached the SAME sandbox rather than provisioning a second one (R2.9 path),
    // and the persisted handle is unchanged.
    expect(sandboxOf(sessionA)!.provisions).toBe(provisionsBefore);
    const { rows: after } = await query<{ h: string | null }>(
      pool,
      `SELECT sandbox_handle AS h FROM sessions WHERE id = $1`,
      [sessionA],
    );
    expect(after[0]!.h).toBe(before[0]!.h);

    // And the recovered session drives turns again.
    const headBefore = await managed.eventsStore.head(sessionA);
    await rtA.sendEvent(userMessage("back from the dead"));
    expect(await managed.eventsStore.head(sessionA)).toBeGreaterThan(headBefore);
  }, 60_000);

  it("(d) inproc mode (the default) is unchanged: the runtime is in-process, no pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-inproc-"));
    const inproc = await createManagedApp({
      config: {
        port: 3000,
        logLevel: "silent",
        objectStoreRoot: join(dir, "objectstore"),
        sessionLocalDir: join(dir, "sessions"),
        sandboxRuntime: "disabled",
        sandboxMode: "single",
        dbUrl: db.connectionString,
        sessionWorkerMode: "inproc",
      } as Config,
      logger: silentLogger,
      sandboxProvider: new FakeSandboxProvider(),
      factory: new FakeAgentSessionFactory(),
      skipMigrations: true,
    });
    try {
      expect(inproc.sessionWorkers).toBeUndefined();

      const agent = await createAgent(pool, ctx, {
        name: "inproc-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      });
      const env = await createEnvironment(pool, ctx, {
        name: "inproc-env",
        type: "cloud",
      });
      const session = await createSession(pool, ctx, {
        agent: agent.id,
        environmentId: env.id,
      });

      const rt = await inproc.sessionManager.getOrCreate(session.id);
      expect(rt).toBeInstanceOf(ManagedSessionRuntime);
      expect(inproc.sessionManager.getRuntime(session.id)).toBeInstanceOf(
        ManagedSessionRuntime,
      );
      await rt.sendEvent(userMessage("inproc turn"));
      expect(rt.status()).toBe("idle");
    } finally {
      await inproc.close();
    }
  }, 60_000);
});
