/**
 * Quota enforcement + tier mapping tests (WP-4.4, §27.3).
 *
 * Covers:
 *  - Tier mapping: free < pro < enterprise across all dimensions.
 *  - Unknown/null plan → default fallback.
 *  - getCurrentUsage rolls up real counts from Postgres.
 *  - checkQuota exceeded on each resource type (concurrent sessions, jobs,
 *    vault credentials, memory stores, file storage, monthly token spend).
 *  - Pro tier does NOT exceed at free's limit (tier scoping).
 *
 * Uses testcontainers-postgres (real Postgres + migrations), matching the
 * established domain-test pattern.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  runMigrations,
  query,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import {
  DEFAULT_QUOTA_PLANS,
  planForName,
  getQuotaPlanForTenant,
  getCurrentUsage,
  checkQuota,
  reserveQuotaDelta,
  releaseQuotaDelta,
  reconcileQuotaCounter,
} from "../index.js";

/** Prefixed id helper (IDs are opaque text; schema does not enforce ULID payload). */
function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Insert a minimal FK-valid agent row (for sessions/jobs FKs). */
async function insertAgent(pool: Pool, tenantId: string): Promise<string> {
  const agentId = id("agent");
  await query(
    pool,
    `INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)`,
    [tenantId, agentId, `agent-${agentId}`],
  );
  return agentId;
}

/** Insert a minimal FK-valid environment row. */
async function insertEnv(pool: Pool, tenantId: string): Promise<string> {
  const envId = id("env");
  await query(
    pool,
    `INSERT INTO environments
       (tenant_id, id, name, type, image, resources, networking)
     VALUES ($1, $2, $3, 'cloud', 'ubuntu:22.04', '{}', '{"mode":"unrestricted"}')`,
    [tenantId, envId, `env-${envId}`],
  );
  return envId;
}

/** Insert a session row with a given status (default 'idle'). */
async function insertSession(
  pool: Pool,
  tenantId: string,
  agentId: string,
  envId: string,
  status = "idle",
): Promise<string> {
  const sid = id("sess");
  await query(
    pool,
    `INSERT INTO sessions
       (tenant_id, id, agent_id, agent_version, environment_id, jsonl_object_key, status)
     VALUES ($1, $2, $3, 1, $4, $5, $6)`,
    [tenantId, sid, agentId, envId, `key-${sid}`, status],
  );
  return sid;
}

describe("quota enforcement + tier mapping (WP-4.4)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Quota Tenant", quotaPlan: "free" });
    ctx = { tenantId: t.id };
    agentId = await insertAgent(pool, t.id);
    envId = await insertEnv(pool, t.id);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  // --- Tier mapping (pure) ------------------------------------------------

  it("free < pro < enterprise across all dimensions", () => {
    const free = planForName("free");
    const pro = planForName("pro");
    const ent = planForName("enterprise");
    expect(free.concurrentSessions).toBeLessThan(pro.concurrentSessions);
    expect(pro.concurrentSessions).toBeLessThan(ent.concurrentSessions);
    expect(free.maxJobs).toBeLessThan(pro.maxJobs);
    expect(pro.maxJobs).toBeLessThan(ent.maxJobs);
    expect(free.maxVaultCredentials).toBeLessThan(pro.maxVaultCredentials);
    expect(free.maxMemoryStores).toBeLessThan(pro.maxMemoryStores);
    expect(free.maxFileStorageBytes).toBeLessThan(pro.maxFileStorageBytes);
    expect(free.monthlyTokenSpendUsd).toBeLessThan(pro.monthlyTokenSpendUsd);
  });

  it("unknown / null plan → default fallback (= pro)", () => {
    expect(planForName(null)).toEqual(DEFAULT_QUOTA_PLANS.default);
    expect(planForName("nonsense")).toEqual(DEFAULT_QUOTA_PLANS.default);
    expect(planForName(undefined)).toEqual(DEFAULT_QUOTA_PLANS.default);
  });

  it("getQuotaPlanForTenant resolves the tenant's stored plan", async () => {
    const plan = await getQuotaPlanForTenant(pool, ctx.tenantId);
    expect(plan).toEqual(DEFAULT_QUOTA_PLANS.free);
  });

  // --- getCurrentUsage (empty) -------------------------------------------

  it("getCurrentUsage is all-zero for a fresh tenant", async () => {
    const usage = await getCurrentUsage(pool, ctx.tenantId);
    expect(usage).toEqual({
      concurrentSessions: 0,
      concurrentSandboxes: 0,
      jobs: 0,
      vaultSize: 0,
      memorySize: 0,
      fileStorage: 0,
      tokenSpendUsd: 0,
    });
  });

  // --- Concurrent sessions enforcement -----------------------------------

  it("concurrent sessions: not exceeded below limit, exceeded at limit (free=2)", async () => {
    // 0 → not exceeded.
    expect((await checkQuota(pool, ctx.tenantId, "concurrentSessions")).exceeded).toBe(false);

    // 1 active idle session → still under (limit 2).
    const s1 = await insertSession(pool, ctx.tenantId, agentId, envId, "idle");
    const u1 = await getCurrentUsage(pool, ctx.tenantId);
    expect(u1.concurrentSessions).toBe(1);
    expect(u1.concurrentSandboxes).toBe(0); // idle is not a live sandbox
    expect((await checkQuota(pool, ctx.tenantId, "concurrentSessions")).exceeded).toBe(false);

    // 2 active → at limit → exceeded (creating a 3rd is blocked).
    const s2 = await insertSession(pool, ctx.tenantId, agentId, envId, "running");
    const u2 = await getCurrentUsage(pool, ctx.tenantId);
    expect(u2.concurrentSessions).toBe(2);
    expect(u2.concurrentSandboxes).toBe(1); // running = live sandbox
    expect((await checkQuota(pool, ctx.tenantId, "concurrentSessions")).exceeded).toBe(true);

    // A terminated session does NOT count toward concurrency.
    await query(pool, `UPDATE sessions SET status='terminated' WHERE id=$1`, [s2]);
    const u3 = await getCurrentUsage(pool, ctx.tenantId);
    expect(u3.concurrentSessions).toBe(1);
    expect((await checkQuota(pool, ctx.tenantId, "concurrentSessions")).exceeded).toBe(false);

    // cleanup s1 (leave the terminated row; it does not count)
    await query(pool, `DELETE FROM sessions WHERE id IN ($1,$2)`, [s1, s2]);
  });

  it("concurrent sandboxes: only running/rescheduling count", async () => {
    await insertSession(pool, ctx.tenantId, agentId, envId, "rescheduling");
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.concurrentSandboxes).toBe(1);
    expect(u.concurrentSessions).toBe(1);
    // cleanup
    await query(
      pool,
      `DELETE FROM sessions WHERE tenant_id=$1 AND status='rescheduling'`,
      [ctx.tenantId],
    );
  });

  // --- Jobs enforcement ---------------------------------------------------

  it("jobs: exceeded at free limit (maxJobs=5)", async () => {
    const plan = planForName("free");
    for (let i = 0; i < plan.maxJobs; i++) {
      await query(
        pool,
        `INSERT INTO jobs
           (tenant_id, id, name, agent_id, agent_version, environment_id,
            initial_events, schedule_cron, schedule_tz)
         VALUES ($1,$2,$3,$4,1,$5,'[{"type":"user.message","content":"x"}]','0 7 * * 1-5','UTC')`,
        [ctx.tenantId, id("job"), `job-${i}`, agentId, envId],
      );
    }
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.jobs).toBe(plan.maxJobs);
    expect((await checkQuota(pool, ctx.tenantId, "maxJobs")).exceeded).toBe(true);
    // Archived jobs do not count.
    await query(
      pool,
      `UPDATE jobs SET status='archived' WHERE tenant_id=$1`,
      [ctx.tenantId],
    );
    expect((await checkQuota(pool, ctx.tenantId, "maxJobs")).exceeded).toBe(false);
    await query(pool, `DELETE FROM jobs WHERE tenant_id=$1`, [ctx.tenantId]);
  });

  // --- Vault credentials enforcement -------------------------------------

  it("vault credentials: exceeded at free limit (maxVaultCredentials=10)", async () => {
    const vaultId = id("vault");
    await query(pool, `INSERT INTO vaults (tenant_id, id, name) VALUES ($1,$2,$3)`, [
      ctx.tenantId,
      vaultId,
      `vault-${vaultId}`,
    ]);
    const plan = planForName("free");
    for (let i = 0; i < plan.maxVaultCredentials; i++) {
      await query(
        pool,
        `INSERT INTO vault_credentials (tenant_id, vault_id, key, category, id)
         VALUES ($1,$2,$3,'static_bearer',$4)`,
        [ctx.tenantId, vaultId, `https://api.example.com/${i}`, id("vcred")],
      );
    }
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.vaultSize).toBe(plan.maxVaultCredentials);
    expect((await checkQuota(pool, ctx.tenantId, "maxVaultCredentials")).exceeded).toBe(true);
    // cleanup
    await query(pool, `DELETE FROM vault_credentials WHERE tenant_id=$1`, [ctx.tenantId]);
    await query(pool, `DELETE FROM vaults WHERE tenant_id=$1`, [ctx.tenantId]);
  });

  // --- Memory stores enforcement -----------------------------------------

  it("memory stores: exceeded at free limit (maxMemoryStores=3)", async () => {
    const plan = planForName("free");
    for (let i = 0; i < plan.maxMemoryStores; i++) {
      await query(
        pool,
        `INSERT INTO memory_stores (tenant_id, id, display_title, object_key_prefix)
         VALUES ($1,$2,$3,$4)`,
        [ctx.tenantId, id("mem"), `mem-${i}`, `prefix-${i}`],
      );
    }
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.memorySize).toBe(plan.maxMemoryStores);
    expect((await checkQuota(pool, ctx.tenantId, "maxMemoryStores")).exceeded).toBe(true);
    await query(pool, `DELETE FROM memory_stores WHERE tenant_id=$1`, [ctx.tenantId]);
  });

  // --- File storage enforcement ------------------------------------------

  it("file storage: exceeded at free limit with delta (500 MiB)", async () => {
    const _plan = planForName("free");
    // Seed existing files at 400 MiB.
    await query(
      pool,
      `INSERT INTO files (tenant_id, id, name, size_bytes, object_key)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.tenantId, id("file"), "big.bin", 400 * 1024 * 1024, "k1"],
    );
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.fileStorage).toBe(400 * 1024 * 1024);
    // 400 + 200 (delta) = 600 MiB >= 500 MiB limit → exceeded.
    const check = await checkQuota(pool, ctx.tenantId, "maxFileStorageBytes", {
      fileStorageDelta: 200 * 1024 * 1024,
    });
    expect(check.exceeded).toBe(true);
    expect(check.current).toBe(600 * 1024 * 1024);
    // A small delta that stays under is not exceeded.
    const ok = await checkQuota(pool, ctx.tenantId, "maxFileStorageBytes", {
      fileStorageDelta: 50 * 1024 * 1024,
    });
    expect(ok.exceeded).toBe(false);
    await query(pool, `DELETE FROM files WHERE tenant_id=$1`, [ctx.tenantId]);
  });

  // --- Monthly token-spend enforcement -----------------------------------

  it("monthly token spend: exceeded at free limit ($5)", async () => {
    const _plan = planForName("free");
    // Need a session to attach usage_records to (session_id FK).
    const sid = await insertSession(pool, ctx.tenantId, agentId, envId, "idle");
    // Seed $4.00 of usage (under the $5 limit).
    await query(
      pool,
      `INSERT INTO usage_records (tenant_id, session_id, model, usd_cost)
       VALUES ($1,$2,'anthropic/claude-sonnet-4',4.0)`,
      [ctx.tenantId, sid],
    );
    const u = await getCurrentUsage(pool, ctx.tenantId);
    expect(u.tokenSpendUsd).toBeCloseTo(4.0, 6);
    expect((await checkQuota(pool, ctx.tenantId, "monthlyTokenSpendUsd")).exceeded).toBe(false);
    // A $2 delta → 4 + 2 = 6 >= 5 → exceeded.
    const check = await checkQuota(pool, ctx.tenantId, "monthlyTokenSpendUsd", {
      tokenSpendDelta: 2.0,
    });
    expect(check.exceeded).toBe(true);
    // Seed past the limit outright ($6) → exceeded with no delta.
    await query(
      pool,
      `INSERT INTO usage_records (tenant_id, session_id, model, usd_cost)
       VALUES ($1,$2,'anthropic/claude-sonnet-4',2.0)`,
      [ctx.tenantId, sid],
    );
    const u2 = await getCurrentUsage(pool, ctx.tenantId);
    expect(u2.tokenSpendUsd).toBeCloseTo(6.0, 6);
    expect(
      (await checkQuota(pool, ctx.tenantId, "monthlyTokenSpendUsd")).exceeded,
    ).toBe(true);
    // cleanup
    await query(pool, `DELETE FROM usage_records WHERE tenant_id=$1`, [ctx.tenantId]);
    await query(pool, `DELETE FROM sessions WHERE id=$1`, [sid]);
  });

  // --- Amount reservations + reconcile (ROB-15 / ROB-20) -----------------

  /** Read a raw counter value for a tenant+resource key, or 0 if absent. */
  async function counterValue(tenantId: string, key: string): Promise<number> {
    const { rows } = await query<{ count: string }>(
      pool,
      `SELECT count FROM tenant_quota_counters WHERE tenant_id = $1 AND resource = $2`,
      [tenantId, key],
    );
    return Number(rows[0]?.count ?? 0);
  }

  it("checkQuota admits an amount landing exactly on the limit (ROB-20 off-by-one)", async () => {
    const limit = planForName("free").maxFileStorageBytes;
    // Exactly at the limit → NOT exceeded (previously `>=` made the limit unreachable).
    const at = await checkQuota(pool, ctx.tenantId, "maxFileStorageBytes", {
      fileStorageDelta: limit,
    });
    expect(at.exceeded).toBe(false);
    expect(at.current).toBe(limit);
    // One byte over → exceeded.
    const over = await checkQuota(pool, ctx.tenantId, "maxFileStorageBytes", {
      fileStorageDelta: limit + 1,
    });
    expect(over.exceeded).toBe(true);
  });

  it("reserveQuotaDelta admits up to the byte limit and rejects the overflow", async () => {
    const t = await createTenant(pool, { name: "Byte Reserve", quotaPlan: "free" });
    const c: TenantCtx = { tenantId: t.id };
    const limit = planForName("free").maxFileStorageBytes;

    // Reserve exactly the limit → admitted; counter settles at the limit.
    await reserveQuotaDelta(pool, c, "maxFileStorageBytes", limit);
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(limit);

    // One more byte overflows → 429; the counter is unchanged (guard wrote nothing).
    await expect(
      reserveQuotaDelta(pool, c, "maxFileStorageBytes", 1),
    ).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(limit);

    // Releasing frees the amount; the freed room is reusable.
    await releaseQuotaDelta(pool, c, "maxFileStorageBytes", limit);
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(0);
    await reserveQuotaDelta(pool, c, "maxFileStorageBytes", 1);
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(1);
  });

  it("reserveQuotaDelta is a no-op for non-positive amounts", async () => {
    const t = await createTenant(pool, { name: "Zero Reserve", quotaPlan: "free" });
    const c: TenantCtx = { tenantId: t.id };
    await reserveQuotaDelta(pool, c, "maxFileStorageBytes", 0);
    await reserveQuotaDelta(pool, c, "maxFileStorageBytes", -5);
    // No row is created for a 0/negative reserve.
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(0);
  });

  it("token spend reserves as micro-USD under a monthly period key", async () => {
    const t = await createTenant(pool, { name: "Token Reserve", quotaPlan: "free" });
    const c: TenantCtx = { tenantId: t.id };
    const now = new Date();
    const periodKey = `monthlyTokenSpendUsd:${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, "0")}`;

    // free monthlyTokenSpendUsd = $5. Two $2 reserves fit ($4 ≤ $5).
    await reserveQuotaDelta(pool, c, "monthlyTokenSpendUsd", 2);
    await reserveQuotaDelta(pool, c, "monthlyTokenSpendUsd", 2);
    // Stored scaled to micro-USD ($4 → 4_000_000), keyed by the current month.
    expect(await counterValue(t.id, periodKey)).toBe(4_000_000);

    // A third $2 would reach $6 > $5 → rejected; error reports unscaled USD.
    await expect(
      reserveQuotaDelta(pool, c, "monthlyTokenSpendUsd", 2),
    ).rejects.toMatchObject({
      statusCode: 429,
      details: { resource: "monthlyTokenSpendUsd", limit: 5, current: 4 },
    });
  });

  it("reconcileQuotaCounter resets a drifted byte counter to the real SUM", async () => {
    const t = await createTenant(pool, { name: "Byte Reconcile", quotaPlan: "free" });
    // Two 100-byte files → true SUM is 200.
    for (let i = 0; i < 2; i++) {
      await query(
        pool,
        `INSERT INTO files (tenant_id, id, name, size_bytes, object_key)
         VALUES ($1,$2,$3,100,$4)`,
        [t.id, id("file"), `f-${i}`, `k-${i}`],
      );
    }
    // Simulate crash-leaked drift: counter overstates at 999.
    await query(
      pool,
      `INSERT INTO tenant_quota_counters (tenant_id, resource, count) VALUES ($1,'maxFileStorageBytes',999)`,
      [t.id],
    );
    const res = await reconcileQuotaCounter(pool, t.id, "maxFileStorageBytes");
    expect(res.before).toBe(999);
    expect(res.after).toBe(200);
    expect(res.drift).toBe(-799);
    expect(await counterValue(t.id, "maxFileStorageBytes")).toBe(200);
  });

  it("reconcileQuotaCounter resets a drifted count counter to the real COUNT", async () => {
    const t = await createTenant(pool, { name: "Count Reconcile", quotaPlan: "free" });
    const a = await insertAgent(pool, t.id);
    const e = await insertEnv(pool, t.id);
    await insertSession(pool, t.id, a, e, "idle");
    await insertSession(pool, t.id, a, e, "running");
    // Drift the counter high; reconcile pulls it back to the real active count (2).
    await query(
      pool,
      `INSERT INTO tenant_quota_counters (tenant_id, resource, count) VALUES ($1,'concurrentSessions',7)`,
      [t.id],
    );
    const res = await reconcileQuotaCounter(pool, t.id, "concurrentSessions");
    expect(res.before).toBe(7);
    expect(res.after).toBe(2);
    expect(await counterValue(t.id, "concurrentSessions")).toBe(2);
  });

  // --- Tier scoping -------------------------------------------------------

  it("pro tier does NOT exceed at free's limits", async () => {
    // Create a pro tenant and load it up to free's concurrent-session limit.
    const t = await createTenant(pool, { name: "Pro Tenant", quotaPlan: "pro" });
    const a = await insertAgent(pool, t.id);
    const e = await insertEnv(pool, t.id);
    const free = planForName("free");
    for (let i = 0; i < free.concurrentSessions; i++) {
      await insertSession(pool, t.id, a, e, "idle");
    }
    const u = await getCurrentUsage(pool, t.id);
    expect(u.concurrentSessions).toBe(free.concurrentSessions);
    // pro limit is higher → not exceeded.
    const check = await checkQuota(pool, t.id, "concurrentSessions");
    expect(check.exceeded).toBe(false);
    expect(check.limit).toBe(planForName("pro").concurrentSessions);
    // cleanup
    await query(pool, `DELETE FROM sessions WHERE tenant_id=$1`, [t.id]);
    await query(pool, `DELETE FROM environments WHERE tenant_id=$1`, [t.id]);
    await query(pool, `DELETE FROM agents WHERE tenant_id=$1`, [t.id]);
    await query(pool, `DELETE FROM tenants WHERE id=$1`, [t.id]);
  });
});
