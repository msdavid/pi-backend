/**
 * `tenantScopedClientQuery` helper tests (R5.6, §27.1 verify).
 *
 * The client-scoped variant of {@link tenantScopedQuery}: it runs a tenant-scoped
 * statement on an already-acquired {@link PoolClient} (needed inside an open
 * transaction, e.g. `work-queue.claim`'s `FOR UPDATE SKIP LOCKED`). It enforces
 * the SAME runtime assertion:
 *  - throws {@link TenantScopeError} when the SQL omits a `tenant_id` reference;
 *  - throws when the SQL names `tenant_id` but the params omit the tenant id;
 *  - passes (executes on the client) when both are present.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPool, closePool, query, type TenantCtx } from "../index.js";
import { tenantScopedClientQuery, TenantScopeError } from "../tenant-scoped.js";
import { runMigrations } from "../migrate.js";
import { startPostgres, hasContainerRuntime, type TestDb } from "./test-runtime.js";
import { createTenant } from "../../../domain/tenant/tenant.js";
import { createAgent } from "../../../domain/agent/agent.js";
import { createEnvironment } from "../../../domain/environment/environment.js";
import { createSession } from "../../../domain/session/create.js";
import {
  enqueue,
  claim,
  issueWorkerKey,
} from "../../../domain/self-hosted/index.js";

const RUNTIME = hasContainerRuntime();

describe.skipIf(!RUNTIME)("tenantScopedClientQuery", () => {
  let db: TestDb;
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    client = await pool.connect();
  }, 120_000);

  afterAll(async () => {
    if (client) client.release();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("rejects a query whose SQL omits tenant_id", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_a" };
    await expect(
      tenantScopedClientQuery(client, tenantCtx, "SELECT * FROM agents", []),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("rejects a query that names tenant_id but omits the binding value", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_a" };
    await expect(
      tenantScopedClientQuery(
        client,
        tenantCtx,
        "SELECT * FROM agents WHERE tenant_id = $1 AND status = $2",
        ["active"],
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("executes a properly scoped query on the passed client", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_client_ok" };
    await query(pool, "INSERT INTO tenants (id, name) VALUES ($1, 'OK')", [
      tenantCtx.tenantId,
    ]);
    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantCtx.tenantId,
      "agent_client_ok_1",
      "client-ok-agent",
    ]);
    const { rows } = await tenantScopedClientQuery<{ name: string }>(
      client,
      tenantCtx,
      "SELECT name FROM agents WHERE tenant_id = $1",
      [tenantCtx.tenantId],
    );
    expect(rows.map((r) => r.name)).toEqual(["client-ok-agent"]);
  });

  it("shares the client's open transaction (rolled back → no rows persist)", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_client_txn" };
    await query(pool, "INSERT INTO tenants (id, name) VALUES ($1, 'TXN')", [
      tenantCtx.tenantId,
    ]);
    await client.query("BEGIN");
    await tenantScopedClientQuery(
      client,
      tenantCtx,
      "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)",
      [tenantCtx.tenantId, "agent_txn_1", "txn-agent"],
    );
    await client.query("ROLLBACK");
    const { rows } = await query<{ name: string }>(
      pool,
      "SELECT name FROM agents WHERE tenant_id = $1",
      [tenantCtx.tenantId],
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// work-queue.claim() cross-tenant isolation (routed through the client wrapper)
// ---------------------------------------------------------------------------

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

function baseAgentConfig() {
  return {
    name: "sh-runner",
    model: MODEL,
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

describe.skipIf(!RUNTIME)("work-queue.claim() tenant isolation (R5.6)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("does not let tenant B claim tenant A's queued work item", async () => {
    // Tenant A: environment + session + queued work item.
    const tA = await createTenant(pool, { name: "Tenant A" });
    const ctxA: TenantCtx = { tenantId: tA.id };
    const agentA = await createAgent(pool, ctxA, baseAgentConfig());
    const envA = await createEnvironment(pool, ctxA, {
      name: "sh-A",
      type: "self_hosted",
    });
    const sessA = await createSession(pool, ctxA, {
      agent: agentA.id,
      environmentId: envA.id,
    });
    await enqueue(pool, ctxA, sessA.id, envA.id, { initialEvents: [] });

    // Tenant B: its own environment + worker key.
    const tB = await createTenant(pool, { name: "Tenant B" });
    const ctxB: TenantCtx = { tenantId: tB.id };
    const envB = await createEnvironment(pool, ctxB, {
      name: "sh-B",
      type: "self_hosted",
    });
    const wkB = await issueWorkerKey(pool, ctxB, envB.id, "worker-B");

    // Tenant B claiming against tenant A's environment id under B's ctx finds
    // nothing (the SELECT is filtered on tenant B's tenant_id) — no cross-tenant
    // claim. The tenantScopedClientQuery assertion also binds ctxB.tenantId.
    const stolen = await claim(pool, ctxB, envA.id, wkB.id);
    expect(stolen).toBeNull();

    // Tenant A can still claim its own item.
    const wkA = await issueWorkerKey(pool, ctxA, envA.id, "worker-A");
    const claimed = await claim(pool, ctxA, envA.id, wkA.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("claimed");
  });
});
