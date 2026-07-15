/**
 * Sessions domain + reads integration tests (WP-1.6, §29.1 verify).
 *
 * Covers the done criteria:
 *  - 3 agent forms (bare ID → latest version; pinned → exact; overrides → blob stored);
 *  - override matrix (omit→inherit, null→clear, value→full replace, no merge);
 *  - idle-only update rejection (409 `session_not_idle`) + full-replacement PATCH;
 *  - fork sharing (shared `jsonl_object_key`) + edit-after-fork isolation;
 *  - delete independence (agent/env/vault survive session deletion);
 *  - entries/tree/messages/usage reads.
 *
 * Uses testcontainers-postgres (real migrations). Skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  createPool,
  closePool,
  query,
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
import {
  createAgent,
  getAgent,
} from "../../agent/agent.js";
import { createEnvironment, getEnvironment } from "../../environment/environment.js";
import { createVault, getVault } from "../../vault/vault.js";
import { FilesystemObjectStore } from "../../../infra/objectstore/filesystem.js";
import { ApiError } from "../../errors.js";
import {
  createSession,
  forkSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  fetchSessionRow,
  readSessionOverrides,
  resolveEffectiveConfig,
  getSessionEntries,
  getSessionTree,
  getSessionMessages,
  getSessionUsage,
} from "../index.js";

const RUNTIME = hasContainerRuntime();

const MODEL = { provider: "anthropic", id: "claude-sonnet-4" };

function baseAgentConfig() {
  return {
    name: "session-runner",
    model: MODEL,
    systemPrompt: "BASE",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" as const },
      configs: { bash: { permissionPolicy: "always_ask" as const } },
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
  return { statusCode: err.statusCode, code: err.code };
}

/** Make a ReadableStream of UTF-8 text (for seeding the object store). */
function textStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe.skipIf(!RUNTIME)("sessions domain (WP-1.6)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let agentId: string;
  let envId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    // This suite creates ~13 sessions + forks for one tenant to cover the
    // override matrix, delete-independence, and read paths — not quota
    // enforcement (that's domain/quota's suite). The default plan's 10-session
    // concurrent cap is too small for that fixture load, so give this tenant
    // headroom via the enterprise plan (50 concurrent, docs/capacity.md).
    const t = await createTenant(pool, { name: "Session Tenant", quotaPlan: "enterprise" });
    ctx = { tenantId: t.id };
    const agent = await createAgent(pool, ctx, baseAgentConfig());
    agentId = agent.id;
    const env = await createEnvironment(pool, ctx, {
      name: "py-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 1024 },
      networking: { mode: "unrestricted" },
    });
    envId = env.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  }, 120_000);

  // --- 3 agent forms -------------------------------------------------------
  describe("agent field — 3 forms", () => {
    it("form 1 (bare ID) pins the latest version with no overrides", async () => {
      const s = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
        title: "bare",
      });
      expect(s.id).toMatch(/^sess_/);
      expect(s.status).toBe("idle");
      expect(s.agentId).toBe(agentId);
      const agent = await getAgent(pool, ctx, agentId);
      expect(s.agentVersion).toBe(agent.currentVersion);
      expect(s.forkedFromSessionId).toBeNull();
      const ovr = await readSessionOverrides(pool, ctx, s.id);
      expect(ovr).toBeNull();
    });

    it("form 2 (pinned version) pins the exact version", async () => {
      // Bump the agent to v2 so pinning v1 differs from latest.
      await updateAgentViaRepo(pool, ctx, agentId, { systemPrompt: "v2prompt" });
      const s = await createSession(pool, ctx, {
        agent: { id: agentId, version: 1 },
        environmentId: envId,
      });
      expect(s.agentVersion).toBe(1);
      const latest = await getAgent(pool, ctx, agentId);
      expect(latest.currentVersion).toBe(2);
      expect(s.agentVersion).toBeLessThan(latest.currentVersion);
    });

    it("form 3 (overrides) pins latest + stores the overrides blob", async () => {
      const s = await createSession(pool, ctx, {
        agent: { id: agentId, overrides: { systemPrompt: "OVR" } },
        environmentId: envId,
      });
      const latest = await getAgent(pool, ctx, agentId);
      expect(s.agentVersion).toBe(latest.currentVersion);
      const ovr = await readSessionOverrides(pool, ctx, s.id);
      expect(ovr).toEqual({ systemPrompt: "OVR" });
    });
  });

  // --- override matrix (omit / null / value) -------------------------------
  describe("override matrix (§6.3: omit→inherit, null→clear, value→replace)", () => {
    it("omitted field is inherited from the pinned version", async () => {
      const s = await createSession(pool, ctx, {
        agent: { id: agentId, overrides: { extensions: [] } },
        environmentId: envId,
      });
      const eff = await resolveEffectiveConfig(pool, ctx, s.id);
      // systemPrompt omitted → inherited from the latest version config.
      expect(eff.systemPrompt).toBe("v2prompt");
    });

    it("null clears the field (removed from the effective config)", async () => {
      const s = await createSession(pool, ctx, {
        agent: { id: agentId, overrides: { systemPrompt: null } },
        environmentId: envId,
      });
      const eff = await resolveEffectiveConfig(pool, ctx, s.id);
      expect(eff.systemPrompt).toBeUndefined();
      const ovr = await readSessionOverrides(pool, ctx, s.id);
      expect(ovr).toEqual({ systemPrompt: null });
    });

    it("value fully replaces (no merge) — tools.configs is replaced, not merged", async () => {
      const s = await createSession(pool, ctx, {
        agent: {
          id: agentId,
          overrides: {
            tools: {
              defaultConfig: { enabled: false, permissionPolicy: "always_deny" },
              configs: {},
            },
          },
        },
        environmentId: envId,
      });
      const eff = await resolveEffectiveConfig(pool, ctx, s.id);
      // Base had configs.bash; the override replaces the whole tools blob.
      expect(eff.tools?.configs).toEqual({});
      expect(eff.tools?.defaultConfig.permissionPolicy).toBe("always_deny");
    });
  });

  // --- idle-only update rejection + full-replacement -----------------------
  describe("PATCH (idle-only, full-replacement)", () => {
    it("updates tools when idle, full-replacing on re-patch", async () => {
      const s = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
      });
      const toolsA = {
        defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
        configs: { bash: { permissionPolicy: "always_allow" } },
      };
      await updateSession(pool, ctx, s.id, { tools: toolsA });
      expect(await readSessionOverrides(pool, ctx, s.id)).toEqual({ tools: toolsA });

      const toolsB = {
        defaultConfig: { enabled: false, permissionPolicy: "always_deny" },
        configs: {},
      };
      await updateSession(pool, ctx, s.id, { tools: toolsB });
      // Full replacement: toolsB fully supplants toolsA (not merged).
      expect(await readSessionOverrides(pool, ctx, s.id)).toEqual({ tools: toolsB });
    });

    it("rejects with 409 session_not_idle when running", async () => {
      const s = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
      });
      // Force the session into `running` (the runtime would do this on user.message).
      await query(pool, `UPDATE sessions SET status = 'running' WHERE id = $1`, [s.id]);
      const err = await updateSession(pool, ctx, s.id, {
        tools: { defaultConfig: { enabled: true, permissionPolicy: "always_allow" }, configs: {} },
      }).then(
        () => null,
        (e) => e,
      );
      expect(apiErr(err)).toEqual({ statusCode: 409, code: "session_not_idle" });
    });
  });

  // --- fork sharing + edit-after-fork isolation ----------------------------
  describe("fork (§30 item 8 — Pi-native tree fork)", () => {
    it("shares the JSONL object key and sets forkedFromSessionId", async () => {
      const parent = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
        title: "origin",
      });
      const fork = await forkSession(pool, ctx, parent.id);
      expect(fork.forkedFromSessionId).toBe(parent.id);
      expect(fork.status).toBe("idle");

      const parentRow = await fetchSessionRow(pool, ctx, parent.id);
      const forkRow = await fetchSessionRow(pool, ctx, fork.id);
      // Shared JSONL tree (NOT a copy).
      expect(forkRow?.jsonl_object_key).toBe(parentRow?.jsonl_object_key);
    });

    it("edit-after-fork isolation — patching the fork leaves the original untouched", async () => {
      const parent = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
      });
      const fork = await forkSession(pool, ctx, parent.id);
      await updateSession(pool, ctx, fork.id, {
        tools: { defaultConfig: { enabled: true, permissionPolicy: "always_allow" }, configs: {} },
      });
      // Fork gained the override; the parent's overrides are still null.
      expect(await readSessionOverrides(pool, ctx, fork.id)).toBeDefined();
      expect(await readSessionOverrides(pool, ctx, parent.id)).toBeNull();
      // Parent row itself is unchanged (still idle, no overrides).
      const parentRow = await fetchSessionRow(pool, ctx, parent.id);
      expect(parentRow?.status).toBe("idle");
    });
  });

  // --- delete independence -------------------------------------------------
  describe("delete (archives JSONL; independent resources untouched)", () => {
    it("deleting a session leaves the agent/env/vault intact", async () => {
      const vault = await createVault(pool, ctx, { name: `v-${Date.now()}` });
      const agent = await createAgent(pool, ctx, { ...baseAgentConfig(), name: `a-${Date.now()}` });
      const env = await createEnvironment(pool, ctx, {
        name: `e-${Date.now()}`,
        type: "cloud",
      });
      const s = await createSession(pool, ctx, {
        agent: agent.id,
        environmentId: env.id,
        vaultIds: [vault.id],
      });
      const deleted = await deleteSession(pool, ctx, s.id);
      expect(deleted).toBe(true);
      // Session is gone (404-shaped: getSession → null).
      expect(await getSession(pool, ctx, s.id)).toBeNull();
      // Idempotent: second delete returns false.
      expect(await deleteSession(pool, ctx, s.id)).toBe(false);

      // Independent resources survive.
      expect((await getAgent(pool, ctx, agent.id)).id).toBe(agent.id);
      expect((await getEnvironment(pool, ctx, env.id))?.id).toBe(env.id);
      expect((await getVault(pool, ctx, vault.id))?.id).toBe(vault.id);
    });
  });

  // --- reads: entries / tree / messages / usage ---------------------------
  describe("reads (entries/tree/messages/usage)", () => {
    let store: FilesystemObjectStore;
    let jsonlKey: string;
    let seededSessionId: string;

    beforeAll(async () => {
      const root = mkdtempSync(join(tmpdir(), "pi-session-jsonl-"));
      store = new FilesystemObjectStore({ root });
      const s = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
      });
      seededSessionId = s.id;
      const row = await fetchSessionRow(pool, ctx, s.id);
      jsonlKey = row!.jsonl_object_key;
      // Seed a 2-entry JSONL tree.
      const log = [
        JSON.stringify({
          type: "user.message",
          id: "e1",
          parentId: null,
          timestamp: "2026-07-13T12:00:00Z",
          message: { role: "user", content: "hi" },
        }),
        JSON.stringify({
          type: "assistant.message",
          id: "e2",
          parentId: "e1",
          timestamp: "2026-07-13T12:00:01Z",
          message: { role: "assistant", content: "hello" },
        }),
      ].join("\n");
      await store.put(jsonlKey, textStream(log));
    });

    it("usage returns zero cumulative counts for an idle session", async () => {
      const usage = await getSessionUsage(pool, ctx, seededSessionId);
      expect(usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usdCost: 0,
      });
    });

    it("entries returns a positional slice with seq + type + processedAt", async () => {
      const { data, nextCursor } = await getSessionEntries(store, jsonlKey, { limit: 50 });
      expect(data).toHaveLength(2);
      expect((data[0] as { seq: number; type: string; processedAt: string }).seq).toBe(0);
      expect((data[0] as { type: string }).type).toBe("user.message");
      expect((data[0] as { processedAt: string }).processedAt).toBe("2026-07-13T12:00:00Z");
      expect((data[1] as { seq: number }).seq).toBe(1);
      expect(nextCursor).toBeNull();
    });

    it("entries honors `from` + `limit`", async () => {
      const { data, nextCursor } = await getSessionEntries(store, jsonlKey, {
        from: 0,
        limit: 1,
      });
      expect(data).toHaveLength(1);
      expect((data[0] as { seq: number }).seq).toBe(0);
      // A second entry exists beyond the first page → a cursor is returned.
      expect(nextCursor).not.toBeNull();
    });

    it("tree returns the parsed branch structure", async () => {
      const tree = (await getSessionTree(store, jsonlKey)) as {
        root: string;
        branches: Array<{ id: string; parentId: string | null }>;
      };
      expect(tree.root).toBe("e1");
      expect(tree.branches).toHaveLength(2);
    });

    it("messages returns the message-bearing entries", async () => {
      const messages = (await getSessionMessages(store, jsonlKey)) as Array<{
        role: string;
        content: string;
      }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    it("reads return empty for a session whose JSONL object is absent", async () => {
      const empty = await getSessionEntries(store, "tenants/x/sessions/y/log.jsonl", {});
      expect(empty).toEqual({ data: [], nextCursor: null });
      const tree = await getSessionTree(store, "tenants/x/sessions/y/log.jsonl");
      expect((tree as { branches: unknown[] }).branches).toEqual([]);
      const msgs = await getSessionMessages(store, "tenants/x/sessions/y/log.jsonl");
      expect(msgs).toEqual([]);
    });
  });

  // --- list + filters ------------------------------------------------------
  describe("list", () => {
    it("paginates and filters by status", async () => {
      const s = await createSession(pool, ctx, {
        agent: agentId,
        environmentId: envId,
      });
      const res = await listSessions(pool, ctx, { limit: 1, status: "idle" });
      expect(res.data.length).toBeGreaterThanOrEqual(1);
      expect(res.data.every((x) => x.status === "idle")).toBe(true);
      // The newest session is first.
      expect(res.data[0].id).toBe(s.id);
      expect(res.nextCursor).not.toBeNull();
    });
  });
});

/**
 * Bump the agent to a new version (PATCH creates an immutable version) via the
 * domain repo so the pinned-version form can be exercised against a non-latest.
 */
async function updateAgentViaRepo(
  pool: Pool,
  ctx: TenantCtx,
  id: string,
  patch: { systemPrompt?: string },
) {
  // Re-exported agent update lives in the agent domain; import lazily to keep the
  // top-level imports focused on the sessions surface.
  const { updateAgent } = await import("../../agent/agent.js");
  return updateAgent(pool, ctx, id, patch);
}
