/**
 * Agent domain lifecycle tests (WP-1.1, §29.1 verify).
 *
 * Covers: create → get → update (new version) → list versions → get version;
 * duplicate name → 409; archive is terminal (cannot update archived; cannot
 * reference archived); list pagination; cross-tenant isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  archiveAgent,
  listVersions,
  getVersion,
  isAgentArchived,
} from "../agent.js";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4", thinkingLevel: "high" };

function baseConfig() {
  return {
    name: "code-reviewer",
    model: MODEL,
    systemPrompt: "You are a meticulous code reviewer.",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: { bash: { permissionPolicy: "always_ask" as const } },
    },
    skills: [{ type: "prebuilt" as const, skillId: "skill_pdf" }],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: { team: "platform" },
  };
}

describe("agent domain lifecycle", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Agent Tenant" });
    ctx = { tenantId: t.id };
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("create → get → update → list versions → get version (full lifecycle)", async () => {
    const created = await createAgent(pool, ctx, baseConfig());
    expect(created.id).toMatch(/^agent_/);
    expect(created.currentVersion).toBe(1);
    expect(created.status).toBe("active");
    expect(created.metadata).toEqual({ team: "platform" });

    // Retrieve returns the current-version config expanded.
    const got = await getAgent(pool, ctx, created.id);
    expect(got.config?.model.id).toBe("claude-sonnet-4");
    expect(got.config?.systemPrompt).toBe("You are a meticulous code reviewer.");

    // Update → new immutable version (currentVersion increments).
    const updated = await updateAgent(pool, ctx, created.id, {
      systemPrompt: "You are an even more meticulous reviewer.",
      metadata: { team: "infra" },
    });
    expect(updated.currentVersion).toBe(2);
    expect(updated.config?.systemPrompt).toBe("You are an even more meticulous reviewer.");
    expect(updated.config?.model.id).toBe("claude-sonnet-4"); // inherited
    expect(updated.metadata).toEqual({ team: "infra" });
    expect(updated.name).toBe("code-reviewer");

    // Versions list reflects both versions, newest first.
    const versions = await listVersions(pool, ctx, created.id, { limit: 50 });
    expect(versions.data.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.data[0].config.systemPrompt).toBe(
      "You are an even more meticulous reviewer.",
    );
    expect(versions.data[1].config.systemPrompt).toBe(
      "You are a meticulous code reviewer.",
    );

    // Retrieve a specific version.
    const v1 = await getVersion(pool, ctx, created.id, 1);
    expect(v1.version).toBe(1);
    expect(v1.config.systemPrompt).toBe("You are a meticulous code reviewer.");
    expect(v1.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("duplicate name → 409 conflict", async () => {
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "dup-name" });
    await expect(createAgent(pool, ctx, { ...baseConfig(), name: "dup-name" })).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    });
    // Different name is fine.
    await createAgent(pool, ctx, { ...baseConfig(), name: "dup-name-2" });
    // The original still resolves.
    expect((await getAgent(pool, ctx, a.id)).name).toBe("dup-name");
  });

  it("rename to an existing name → 409 conflict", async () => {
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "rename-a" });
    await createAgent(pool, ctx, { ...baseConfig(), name: "rename-b" });
    await expect(
      updateAgent(pool, ctx, a.id, { name: "rename-b" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("archive is terminal: cannot update an archived agent", async () => {
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "to-archive" });
    const archived = await archiveAgent(pool, ctx, a.id);
    expect(archived.status).toBe("archived");
    expect(archived.currentVersion).toBe(1);

    // Update must be rejected.
    await expect(
      updateAgent(pool, ctx, a.id, { systemPrompt: "nope" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "resource_archived" });

    // isAgentArchived guards new-session creation (§6.1).
    expect(await isAgentArchived(pool, ctx, a.id)).toBe(true);
  });

  it("archive is idempotent (re-archive returns archived resource)", async () => {
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "idem-archive" });
    await archiveAgent(pool, ctx, a.id);
    const again = await archiveAgent(pool, ctx, a.id);
    expect(again.status).toBe("archived");
  });

  it("isAgentArchived is false for active and absent agents", async () => {
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "active-check" });
    expect(await isAgentArchived(pool, ctx, a.id)).toBe(false);
    expect(await isAgentArchived(pool, ctx, "agent_nonexistent")).toBe(false);
  });

  it("getAgent / getVersion on missing → 404 not_found", async () => {
    await expect(getAgent(pool, ctx, "agent_missing")).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "ver-404" });
    await expect(getVersion(pool, ctx, a.id, 999)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    await expect(listVersions(pool, ctx, "agent_missing", { limit: 50 })).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });

  it("invalid config → 422 invalid_request", async () => {
    // Missing required `model` field → contracts reject.
    const { model: _drop, ...noModel } = baseConfig();
    await expect(
      createAgent(pool, ctx, { ...noModel, name: "bad-config" }),
    ).rejects.toMatchObject({ statusCode: 422, code: "invalid_request" });
  });

  it("list pagination + name + metadata filters", async () => {
    // Create a distinct batch so the filters isolate them.
    for (let i = 0; i < 3; i++) {
      await createAgent(pool, ctx, {
        ...baseConfig(),
        name: `page-${i}`,
        metadata: { team: "paging", idx: String(i) },
      });
    }

    // Name filter.
    const byName = await listAgents(pool, ctx, { limit: 50, name: "page-1" });
    expect(byName.data).toHaveLength(1);
    expect(byName.data[0].name).toBe("page-1");

    // Metadata filter.
    const byMeta = await listAgents(pool, ctx, { limit: 50, metadata: { team: "paging" } });
    expect(byMeta.data.length).toBe(3);
    expect(byMeta.data.every((a) => a.metadata?.team === "paging")).toBe(true);

    // Pagination: limit=2 → first page has 2 + nextCursor; second page continues.
    const first = await listAgents(pool, ctx, { limit: 2, metadata: { team: "paging" } });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAgents(pool, ctx, {
      limit: 2,
      cursor: first.nextCursor!,
      metadata: { team: "paging" },
    });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // No overlap between pages.
    const firstIds = first.data.map((a) => a.id);
    expect(second.data.map((a) => a.id).some((id) => firstIds.includes(id))).toBe(false);
  });

  it("cross-tenant: agent A is invisible to tenant B", async () => {
    const tb = await createTenant(pool, { name: "Other Tenant" });
    const ctxB: TenantCtx = { tenantId: tb.id };
    const a = await createAgent(pool, ctx, { ...baseConfig(), name: "x-tenant-a" });

    // B cannot fetch A's agent (404 — same response to avoid leakage).
    await expect(getAgent(pool, ctxB, a.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    // B's list never includes A's agent.
    const bList = await listAgents(pool, ctxB, { limit: 50 });
    expect(bList.data.map((x) => x.id)).not.toContain(a.id);
    // isAgentArchived is scoped: A's agent is not archived for B.
    expect(await isAgentArchived(pool, ctxB, a.id)).toBe(false);
    // A's name is free for B to reuse.
    const reused = await createAgent(pool, ctxB, { ...baseConfig(), name: "x-tenant-a" });
    expect(reused.name).toBe("x-tenant-a");
  });
});
