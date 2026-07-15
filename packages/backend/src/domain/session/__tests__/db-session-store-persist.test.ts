/**
 * DbSessionStore durable-persistence tests (R2.8 — real Postgres).
 *
 *  - `saveSandboxHandle` writes the provider handle name to the row (and `null` clears it);
 *  - `saveStatus` writes status + stop_reason so `GET /sessions` reflects the truth.
 *
 * Uses testcontainers-postgres (real migrations, incl. 029 synced_etag). Skips without a
 * container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession, getSession, fetchSessionRow } from "../index.js";
import { DbSessionStore } from "../db-session-store.js";
import type { SandboxHandle } from "../../ports.js";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import { reattachSurvivingSandboxes } from "../../../app.js";
import type { Logger } from "pino";

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
    name: "persist-runner",
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

describe.skipIf(!RUNTIME)("DbSessionStore persistence (R2.8)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;
  let store: DbSessionStore;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    const { runMigrations } = await import("../../../infra/db/index.js");
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Persist Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "persist-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 1024 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
    store = new DbSessionStore(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  it("saveSandboxHandle persists the handle name onto the row (and null clears it)", async () => {
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    // A fresh row has no handle.
    expect((await fetchSessionRow(pool, ctx, s.id))?.sandbox_handle).toBeNull();

    const handle: SandboxHandle = {
      id: "t-s-vm",
      name: "t-s-vm",
      labels: { tenant: ctx.tenantId, session: s.id },
    };
    await store.saveSandboxHandle(s.id, handle);
    expect((await fetchSessionRow(pool, ctx, s.id))?.sandbox_handle).toBe("t-s-vm");

    // A subsequent get() reconstructs the full handle from the persisted name.
    const record = await store.get(s.id);
    expect(record?.sandboxHandle?.name).toBe("t-s-vm");

    // Clearing writes NULL.
    await store.saveSandboxHandle(s.id, null);
    expect((await fetchSessionRow(pool, ctx, s.id))?.sandbox_handle).toBeNull();
  });

  it("saveStatus persists status + stop_reason (GET /sessions reflects it)", async () => {
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    expect((await getSession(pool, ctx, s.id))?.status).toBe("idle");

    await store.saveStatus(s.id, "running", null);
    const running = await getSession(pool, ctx, s.id);
    expect(running?.status).toBe("running");
    expect(running?.stopReason).toBeNull();

    await store.saveStatus(s.id, "idle", "completed");
    const settled = await getSession(pool, ctx, s.id);
    expect(settled?.status).toBe("idle");
    expect(settled?.stopReason).toBe("completed");
  });

  it("save* resolve the tenant even without a prior get() (by-id lookup)", async () => {
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    // Fresh store instance — no cached tenant for this session id.
    const fresh = new DbSessionStore(pool);
    await fresh.saveStatus(s.id, "running", null);
    expect((await getSession(pool, ctx, s.id))?.status).toBe("running");
  });

  it("boot recovery resets stale running/rescheduling sessions to idle (finding #6)", async () => {
    // A kill -9 mid-turn leaves the row at `running`; after a restart no turn is in flight,
    // so `GET /sessions` must not keep reporting "running" (and `session_not_idle` guards
    // must not spuriously reject). Boot recovery truthfully resets it to idle.
    const s = await createSession(pool, ctx, { agent: agentId, environmentId: envId });
    await store.saveStatus(s.id, "running", "requires_action");
    expect((await getSession(pool, ctx, s.id))?.status).toBe("running");

    await reattachSurvivingSandboxes({
      pool,
      sandboxProvider: new FakeSandboxProvider(),
      sessions: store,
      logger: silentLogger,
    });

    const after = await getSession(pool, ctx, s.id);
    expect(after?.status).toBe("idle");
    expect(after?.stopReason).toBeNull();
  });
});
