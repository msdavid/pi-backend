/**
 * Self-hosted work queue integration tests (WP-4.1, §10.4 / §9.2 / §13.7).
 *
 * Covers the done criteria:
 *  - self_hosted type unlocked (no 422);
 *  - enqueue → claim → postResult round-trip;
 *  - work-stats ({depth, pending, oldestQueuedAt, workersPolling});
 *  - work.stop (force + clean, org-key auth);
 *  - worker-key scoping (env A key cannot claim env B's work);
 *  - unsupported-features matrix (memory store + env-var creds → 422).
 *
 * Uses testcontainers-postgres (real migrations). Skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  tenantScopedQuery,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { issueApiKey } from "../../tenant/api-key.js";
import { createAgent } from "../../agent/agent.js";
import { createEnvironment } from "../../environment/environment.js";
import { createSession } from "../../session/create.js";
import { createVault } from "../../vault/vault.js";
import { ApiError } from "../../errors.js";
import {
  enqueue,
  claim,
  postResult,
  completeWorkItem,
  getWorkStats,
  stopWork,
  issueWorkerKey,
  resolveWorkerKey,
  requireWorkerKeyForEnv,
  assertOrgKey,
  assertSelfHostedSessionConstraints,
} from "../index.js";

const RUNTIME = hasContainerRuntime();
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

/** ApiError → envelope triple for assertion. */
function apiErr(err: unknown) {
  if (!(err instanceof ApiError)) throw err;
  return { statusCode: err.statusCode, code: err.code, message: err.message };
}

describe.skipIf(!RUNTIME)("self-hosted work queue (WP-4.1)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envA: string;
  let envB: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "SH Tenant" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const eA = await createEnvironment(pool, ctx, {
      name: "self-hosted-A",
      type: "self_hosted",
    });
    envA = eA.id;
    const eB = await createEnvironment(pool, ctx, {
      name: "self-hosted-B",
      type: "self_hosted",
    });
    envB = eB.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  /** Create an idle session on the given environment (for the session_id FK). */
  async function newSession(envId: string): Promise<string> {
    const sess = await createSession(pool, ctx, {
      agent: agentId,
      environmentId: envId,
    });
    return sess.id;
  }

  // -------------------------------------------------------------------------
  // self_hosted type unlocked
  // -------------------------------------------------------------------------

  it("unlocks self_hosted environments (no 422)", () => {
    expect(envA).toMatch(/^env_/);
  });

  // -------------------------------------------------------------------------
  // enqueue → claim → postResult round-trip + work-stats
  // -------------------------------------------------------------------------

  it("round-trips enqueue → claim → postResult with work-stats transitions", async () => {
    const sessionId = await newSession(envA);
    const item = await enqueue(pool, ctx, sessionId, envA, {
      initialEvents: [{ type: "user.message", content: "run tests" }],
    });
    expect(item.status).toBe("queued");
    expect(item.workSpec.initialEvents).toHaveLength(1);
    expect(item.environmentId).toBe(envA);

    // Stats: one pending, no workers polling.
    let stats = await getWorkStats(pool, ctx, envA);
    expect(stats).toMatchObject({ depth: 1, pending: 1, workersPolling: 0 });
    expect(stats.oldestQueuedAt).not.toBeNull();

    // Issue a worker key scoped to envA and claim the item.
    const wk = await issueWorkerKey(pool, ctx, envA, "worker-A");
    expect(wk.key).toMatch(/^pmb_live_/);
    expect(wk.environmentId).toBe(envA);

    const claimed = await claim(pool, ctx, envA, wk.id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(item.id);
    expect(claimed!.status).toBe("claimed");
    expect(claimed!.claimedBy).toBe(wk.id);
    expect(claimed!.claimedAt).not.toBeNull();

    // Stats: still depth 1, but pending 0 and one worker polling.
    stats = await getWorkStats(pool, ctx, envA);
    expect(stats).toMatchObject({ depth: 1, pending: 0, workersPolling: 1 });

    // A second claim finds nothing (queue drained).
    const empty = await claim(pool, ctx, envA, wk.id);
    expect(empty).toBeNull();

    // Worker posts a user.tool_result (§9.2).
    const after = await postResult(pool, ctx, sessionId, {
      type: "user.tool_result",
      tool: "bash",
      output: "all green",
    });
    expect(after.results).toHaveLength(1);
    expect((after.results[0] as { type: string }).type).toBe("user.tool_result");

    // Complete the work item → depth 0.
    const done = await completeWorkItem(pool, ctx, sessionId);
    expect(done!.status).toBe("done");
    stats = await getWorkStats(pool, ctx, envA);
    expect(stats).toMatchObject({ depth: 0, pending: 0, workersPolling: 0 });
    expect(stats.oldestQueuedAt).toBeNull();
  });

  it("returns zero work-stats for an empty environment queue", async () => {
    const stats = await getWorkStats(pool, ctx, envB);
    expect(stats).toEqual({
      depth: 0,
      pending: 0,
      oldestQueuedAt: null,
      workersPolling: 0,
    });
  });

  it("claims the oldest item first (FIFO by queued_at)", async () => {
    const s1 = await newSession(envA);
    const i1 = await enqueue(pool, ctx, s1, envA, { initialEvents: [] });
    const s2 = await newSession(envA);
    const i2 = await enqueue(pool, ctx, s2, envA, { initialEvents: [] });
    const wk = await issueWorkerKey(pool, ctx, envA, "worker-fifo");
    const first = await claim(pool, ctx, envA, wk.id);
    expect(first!.id).toBe(i1.id);
    // cleanup
    await claim(pool, ctx, envA, wk.id); // claims i2
    await completeWorkItem(pool, ctx, s1);
    await completeWorkItem(pool, ctx, s2);
    void i2;
  });

  // -------------------------------------------------------------------------
  // work.stop (force + clean)
  // -------------------------------------------------------------------------

  it("work.stop clean marks stop_requested without terminating", async () => {
    const sessionId = await newSession(envA);
    await enqueue(pool, ctx, sessionId, envA, { initialEvents: [] });
    const wk = await issueWorkerKey(pool, ctx, envA, "worker-stop-clean");
    await claim(pool, ctx, envA, wk.id);

    const stopped = await stopWork(pool, ctx, sessionId, { force: false });
    expect(stopped).not.toBeNull();
    expect(stopped!.stopRequested).toBe("clean");
    expect(stopped!.status).toBe("claimed"); // cooperative — not yet stopped
    expect(stopped!.stopRequestedAt).not.toBeNull();

    // Results can still be posted (cooperative stop).
    const after = await postResult(pool, ctx, sessionId, {
      type: "user.tool_result",
      output: "finishing up",
    });
    expect(after.results).toHaveLength(1);
    await completeWorkItem(pool, ctx, sessionId);
  });

  it("work.stop force terminates immediately and blocks further results", async () => {
    const sessionId = await newSession(envA);
    await enqueue(pool, ctx, sessionId, envA, { initialEvents: [] });
    const wk = await issueWorkerKey(pool, ctx, envA, "worker-stop-force");
    await claim(pool, ctx, envA, wk.id);

    const stopped = await stopWork(pool, ctx, sessionId, { force: true });
    expect(stopped!.status).toBe("stopped");
    expect(stopped!.stopRequested).toBe("force");

    // Idempotent on an already-stopped item.
    const again = await stopWork(pool, ctx, sessionId, { force: true });
    expect(again!.status).toBe("stopped");

    // Further results are rejected (409 conflict).
    await expect(
      postResult(pool, ctx, sessionId, { type: "user.tool_result", output: "x" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("work.stop returns null for an unknown session", async () => {
    const res = await stopWork(pool, ctx, "sess_unknown", { force: true });
    expect(res).toBeNull();
  });

  // -------------------------------------------------------------------------
  // worker-key scoping (env A key cannot claim env B's work)
  // -------------------------------------------------------------------------

  it("scopes worker keys to their environment", async () => {
    const wkA = await issueWorkerKey(pool, ctx, envA, "worker-A-scoped");
    // resolveWorkerKey returns the envA binding.
    const resolved = await resolveWorkerKey(pool, ctx, wkA.key);
    expect(resolved).not.toBeNull();
    expect(resolved!.environmentId).toBe(envA);
    expect(resolved!.apiKeyId).toBe(wkA.id);

    // The worker key for envA is permitted on envA.
    await expect(
      requireWorkerKeyForEnv(pool, ctx, wkA.key, envA),
    ).resolves.toMatchObject({ environmentId: envA });

    // The worker key for envA is FORBIDDEN on envB (§10.4).
    await expect(requireWorkerKeyForEnv(pool, ctx, wkA.key, envB)).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });

    // A worker key cannot be claimed against envB's queue. Enqueue work in envB,
    // then attempt to claim with envA's worker key via the route-layer guard.
    const sB = await newSession(envB);
    await enqueue(pool, ctx, sB, envB, { initialEvents: [] });
    await expect(requireWorkerKeyForEnv(pool, ctx, wkA.key, envB)).rejects.toThrow();
    // (envB's item is left queued; it does not affect envA's stats.)
  });

  it("rejects a non-worker (org) key as a worker key", async () => {
    const org = await issueApiKey(pool, ctx, { name: "org-key" });
    expect(await resolveWorkerKey(pool, ctx, org.key)).toBeNull();
    await expect(requireWorkerKeyForEnv(pool, ctx, org.key, envA)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("assertOrgKey rejects worker keys but allows org keys", async () => {
    const org = await issueApiKey(pool, ctx, { name: "org-key-2" });
    await expect(assertOrgKey(pool, ctx, org.key)).resolves.toBeUndefined();

    const wk = await issueWorkerKey(pool, ctx, envA, "worker-org-check");
    await expect(assertOrgKey(pool, ctx, wk.key)).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });
  });

  // -------------------------------------------------------------------------
  // unsupported-features matrix (memory stores + env-var creds → 422)
  // -------------------------------------------------------------------------

  it("rejects memory stores on self-hosted (§13.7)", async () => {
    const env = { id: envA, type: "self_hosted" } as never;
    const err = await assertSelfHostedSessionConstraints(pool, ctx, env, {
      memoryStoreIds: ["mem_01JXXXX"],
    }).catch(apiErr);
    expect(err).toMatchObject({ statusCode: 422, code: "invalid_request" });
  });

  it("rejects memory store refs in resources on self-hosted (§13.7)", async () => {
    const env = { id: envA, type: "self_hosted" } as never;
    const err = await assertSelfHostedSessionConstraints(pool, ctx, env, {
      resources: ["file_01", "mem_01JYYYY"],
    }).catch(apiErr);
    expect(err).toMatchObject({ statusCode: 422, code: "invalid_request" });
  });

  it("rejects env-var credentials on self-hosted (§10.4)", async () => {
    const vault = await createVault(pool, ctx, { name: "sh-vault" });
    // Insert an environment_variable credential directly (the constraints check
    // only reads category; we bypass the crypto path for the test).
    await tenantScopedQuery(
      pool,
      ctx,
      `INSERT INTO vault_credentials
         (tenant_id, id, vault_id, key, category, status, metadata)
       VALUES ($1, $2, $3, $4, 'environment_variable', 'active', '{}'::jsonb)`,
      [ctx.tenantId, `vcred_${Math.random().toString(36).slice(2)}`, vault.id, "GIT_TOKEN"],
    );

    const env = { id: envA, type: "self_hosted" } as never;
    const err = await assertSelfHostedSessionConstraints(pool, ctx, env, {
      vaultIds: [vault.id],
    }).catch(apiErr);
    expect(err).toMatchObject({ statusCode: 422, code: "invalid_request" });
    expect((err as { message: string }).message).toMatch(/environment_variable/);
  });

  it("allows static_bearer credentials on self-hosted", async () => {
    const vault = await createVault(pool, ctx, { name: "sh-vault-ok" });
    await tenantScopedQuery(
      pool,
      ctx,
      `INSERT INTO vault_credentials
         (tenant_id, id, vault_id, key, category, status, metadata)
       VALUES ($1, $2, $3, $4, 'static_bearer', 'active', '{}'::jsonb)`,
      [ctx.tenantId, `vcred_${Math.random().toString(36).slice(2)}`, vault.id, "https://api.github.com"],
    );
    const env = { id: envA, type: "self_hosted" } as never;
    await expect(
      assertSelfHostedSessionConstraints(pool, ctx, env, { vaultIds: [vault.id] }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for cloud environments", async () => {
    const cloudEnv = await createEnvironment(pool, ctx, {
      name: "cloud-env",
      type: "cloud",
    });
    // Memory stores + env-var creds are fine on cloud (no rejection).
    await expect(
      assertSelfHostedSessionConstraints(
        pool,
        ctx,
        { id: cloudEnv.id, type: "cloud" } as never,
        { memoryStoreIds: ["mem_01"], vaultIds: [] },
      ),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getWorkStats rejects cloud environments
  // -------------------------------------------------------------------------

  it("getWorkStats rejects a cloud environment with 422", async () => {
    const cloudEnv = await createEnvironment(pool, ctx, {
      name: "cloud-env-stats",
      type: "cloud",
    });
    await expect(getWorkStats(pool, ctx, cloudEnv.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_request",
    });
  });
});
