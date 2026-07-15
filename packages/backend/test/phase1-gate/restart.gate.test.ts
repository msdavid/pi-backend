/**
 * GATE-1 / §29.2 — Restart test (R2.8 + R2.9, single-node).
 *
 * Proves the durable-recovery invariant with REAL persistence (no in-memory re-seed hack):
 *   - `wake()` persists the provisioned sandbox handle to Postgres (R2.8);
 *   - a `kill -9` (runtime dispose) leaves the DETACHED VM alive (survives in the provider);
 *   - boot-time re-attach (`reattachSurvivingSandboxes`, R2.9) rediscovers the surviving VM
 *     by tenant/session labels and reconciles its handle onto the row even after the stored
 *     handle was lost;
 *   - a fresh `wake()` re-attaches the SAME VM (no re-provision) and resumes.
 *
 * Uses a real testcontainers Postgres + `DbSessionStore`. The `FakeSandboxProvider` models
 * the hypervisor: its detached VMs survive the backend "process" (the runtime instances) and
 * its `reattachByLabels` returns the surviving handle. Skips without a container runtime.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import {
  FakeObjectStore,
  FakeSandboxProvider,
  FakeSecretStore,
  FakeUsageRecorder,
} from "@pi-managed/testkit";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../src/infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../src/infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../src/domain/tenant/tenant.js";
import { createAgent } from "../../src/domain/agent/agent.js";
import { createEnvironment } from "../../src/domain/environment/environment.js";
import { createSession, fetchSessionRow } from "../../src/domain/session/index.js";
import {
  DbSessionStore,
  sessionLocalJsonlPathIn,
} from "../../src/domain/session/db-session-store.js";
import { ManagedSessionRuntime } from "../../src/domain/session-manager/runtime.js";
import { FakeAgentSessionFactory } from "../../src/domain/session-manager/__tests__/fake-agent-session.js";
import { reattachSurvivingSandboxes } from "../../src/app.js";
import { query } from "../../src/infra/db/index.js";

const RUNTIME = hasContainerRuntime();

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

function baseAgentConfig() {
  return {
    name: "restart-runner",
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    systemPrompt: "BASE",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: {},
    },
    skills: [],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: {},
  };
}

describe.skipIf(!RUNTIME)("GATE-1 §29.2: restart — detached VM survives + is re-attached (@gate)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;
  let localDir: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Restart Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "restart-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
    localDir = mkdtempSync(join(tmpdir(), "pi-restart-jsonl-"));
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  function deps(sandbox: FakeSandboxProvider, store: DbSessionStore) {
    return {
      sandbox,
      objects: new FakeObjectStore(),
      usage: new FakeUsageRecorder(),
      secrets: new FakeSecretStore(),
      sessions: store,
      factory: new FakeAgentSessionFactory(),
    };
  }

  it("persists the handle, survives kill -9, re-attaches by labels, resumes without re-provision", async () => {
    const store = new DbSessionStore(pool, { localDir });
    const sandbox = new FakeSandboxProvider();
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    const sessionId = s.id;

    // Seed a local JSONL header so the sync path has a real file.
    const jsonlPath = sessionLocalJsonlPathIn(localDir, sessionId);
    mkdirSync(dirname(jsonlPath), { recursive: true });
    writeFileSync(
      jsonlPath,
      `{"type":"session","version":3,"id":"${sessionId}","timestamp":"${new Date().toISOString()}","cwd":"${localDir}"}\n`,
    );

    // 1. Boot runtime1 + wake → provisions a detached VM (handle H1) and PERSISTS it (R2.8).
    const runtime1 = new ManagedSessionRuntime(deps(sandbox, store));
    await runtime1.wake(sessionId);
    const h1 = runtime1.sandboxHandle!;
    expect(h1).toBeDefined();
    const provisionsBefore = sandbox.calls.filter((c) => c.kind === "provision").length;
    expect(provisionsBefore).toBe(1);
    // The handle was written durably to Postgres.
    expect((await fetchSessionRow(pool, ctx, sessionId))?.sandbox_handle).toBe(h1.name);

    // 2. kill -9: dispose the runtime. The detached VM survives in the provider.
    runtime1.dispose();
    const status = await sandbox.status(h1);
    expect(["running", "stopped"]).toContain(status);

    // 3. Model a crash mid-flight where the handle flush was lost: NULL the stored handle
    //    and mark the row `running`. Boot-recovery must rediscover the VM by labels.
    await query(
      pool,
      `UPDATE sessions SET sandbox_handle = NULL, status = 'running' WHERE id = $1`,
      [sessionId],
    );
    expect((await fetchSessionRow(pool, ctx, sessionId))?.sandbox_handle).toBeNull();

    // 4. Boot-time re-attach (R2.9): reconciles the surviving VM's handle onto the row.
    await reattachSurvivingSandboxes({
      pool,
      sandboxProvider: sandbox,
      sessions: store,
      logger: silentLogger,
    });
    expect((await fetchSessionRow(pool, ctx, sessionId))?.sandbox_handle).toBe(h1.name);

    // 5. A fresh runtime wakes and re-attaches the SAME VM — no new provision.
    const runtime2 = new ManagedSessionRuntime(deps(sandbox, store));
    await runtime2.wake(sessionId);
    expect(runtime2.status()).toBe("idle");
    expect(runtime2.sandboxHandle?.name).toBe(h1.name);
    const provisionsAfter = sandbox.calls.filter((c) => c.kind === "provision").length;
    expect(provisionsAfter).toBe(provisionsBefore);

    runtime2.dispose();
  }, 60_000);
});
