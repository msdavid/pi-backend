/**
 * Agents API (HTTP-level, WP-1.1, §29.1 verify).
 *
 * Exercises the full `createApp` stack against a real Postgres testcontainer:
 * create → get → update (new version) → list versions → get version; duplicate
 * name → 409; archive terminal (update blocked, isAgentArchived guard); list
 * pagination; cross-tenant isolation; Idempotency-Key requirements.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { isAgentArchived } from "../../domain/agent/agent.js";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4", thinkingLevel: "high" };

function baseBody(name: string) {
  return {
    name,
    model: MODEL,
    systemPrompt: "You are a meticulous code reviewer.",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: { bash: { permissionPolicy: "always_ask" } },
    },
    skills: [{ type: "prebuilt", skillId: "skill_pdf" }],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: { team: "platform" },
  };
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

describe("agents API (HTTP)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let apiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({ config, logger: pino({ level: "error" }), pool });
    const t = await createTenant(pool, { name: "Agents HTTP Tenant" });
    tenantId = t.id;
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    apiKey = issued.key;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("create requires auth + Idempotency-Key", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/agents",
      payload: baseBody("no-auth"),
    });
    expect(noAuth.statusCode).toBe(401);

    const noIdem = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      payload: JSON.stringify(baseBody("no-idem")),
    });
    expect(noIdem.statusCode).toBe(400);
    expect(noIdem.json().error.code).toBe("invalid_request");
  });

  it("full lifecycle: create → get → update → versions → get version", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "lc-1", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("lifecycle")),
    });
    expect(created.statusCode).toBe(201);
    const agent = created.json();
    expect(agent.id).toMatch(/^agent_/);
    expect(agent.currentVersion).toBe(1);
    expect(agent.status).toBe("active");
    expect(agent.metadata).toEqual({ team: "platform" });
    // 201 response omits the config blob (per api-reference example).
    expect(agent.config).toBeUndefined();

    // GET retrieves with config expanded.
    const got = await app.inject({ method: "GET", url: `/v1/agents/${agent.id}`, headers: auth(apiKey) });
    expect(got.statusCode).toBe(200);
    expect(got.json().config.model.id).toBe("claude-sonnet-4");

    // PATCH creates a new version.
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${agent.id}`,
      headers: { ...auth(apiKey), "content-type": "application/json" },
      payload: JSON.stringify({ systemPrompt: "new prompt", metadata: { team: "infra" } }),
    });
    expect(patched.statusCode).toBe(200);
    const updated = patched.json();
    expect(updated.currentVersion).toBe(2);
    expect(updated.config.systemPrompt).toBe("new prompt");
    expect(updated.config.model.id).toBe("claude-sonnet-4");
    expect(updated.metadata).toEqual({ team: "infra" });

    // Versions list.
    const versions = await app.inject({
      method: "GET",
      url: `/v1/agents/${agent.id}/versions`,
      headers: auth(apiKey),
    });
    expect(versions.statusCode).toBe(200);
    const vbody = versions.json();
    expect(vbody.data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(vbody.nextCursor).toBeNull();

    // Get a specific version.
    const v1 = await app.inject({
      method: "GET",
      url: `/v1/agents/${agent.id}/versions/1`,
      headers: auth(apiKey),
    });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().config.systemPrompt).toBe("You are a meticulous code reviewer.");
  });

  it("duplicate name → 409 conflict", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "dup-1", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("dup-name")),
    });
    expect(a.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "dup-2", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("dup-name")),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
  });

  it("invalid config → 422 invalid_request", async () => {
    // Missing required `model` field → contracts reject.
    const { model: _drop, ...noModel } = baseBody("bad-config");
    const bad = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "bad-1", "content-type": "application/json" },
      payload: JSON.stringify(noModel),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("invalid_request");
  });

  it("archive is terminal (requires Idempotency-Key; blocks update)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "arc-1", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("to-archive")),
    });
    const id = created.json().id;

    // Archive requires Idempotency-Key.
    const noIdem = await app.inject({
      method: "POST",
      url: `/v1/agents/${id}/archive`,
      headers: auth(apiKey),
    });
    expect(noIdem.statusCode).toBe(400);

    const archived = await app.inject({
      method: "POST",
      url: `/v1/agents/${id}/archive`,
      headers: { ...auth(apiKey), "idempotency-key": "arc-2" },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe("archived");

    // Update is now blocked.
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/agents/${id}`,
      headers: { ...auth(apiKey), "content-type": "application/json" },
      payload: JSON.stringify({ systemPrompt: "nope" }),
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe("resource_archived");

    // Domain guard for WP-1.6: the archived agent blocks new sessions.
    expect(await isAgentArchived(pool, { tenantId }, id)).toBe(true);
  });

  it("list paginates and accepts name/metadata filters", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: { ...auth(apiKey), "idempotency-key": `pg-${i}`, "content-type": "application/json" },
        payload: JSON.stringify({ ...baseBody(`http-page-${i}`), metadata: { team: "http-paging", idx: String(i) } }),
      });
    }

    // Metadata filter.
    const byMeta = await app.inject({
      method: "GET",
      url: "/v1/agents?metadata.team=http-paging",
      headers: auth(apiKey),
    });
    expect(byMeta.statusCode).toBe(200);
    expect(byMeta.json().data).toHaveLength(3);

    // Pagination.
    const first = await app.inject({
      method: "GET",
      url: "/v1/agents?metadata.team=http-paging&limit=2",
      headers: auth(apiKey),
    });
    expect(first.json().data).toHaveLength(2);
    expect(first.json().nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: `/v1/agents?metadata.team=http-paging&limit=2&cursor=${first.json().nextCursor}`,
      headers: auth(apiKey),
    });
    expect(second.json().data).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
  });

  it("get / version on missing agent → 404", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/v1/agents/agent_missing",
      headers: auth(apiKey),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  it("cross-tenant: tenant B cannot see tenant A's agents", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "xt-1", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("x-tenant")),
    });
    const id = created.json().id;

    // Tenant B with its own key.
    const tb = await createTenant(pool, { name: "Other HTTP Tenant" });
    const bKey = (await issueApiKey(pool, { tenantId: tb.id }, { name: "bk" })).key;

    const got = await app.inject({
      method: "GET",
      url: `/v1/agents/${id}`,
      headers: auth(bKey),
    });
    expect(got.statusCode).toBe(404);

    // B can reuse A's name (per-tenant uniqueness).
    const reused = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(bKey), "idempotency-key": "xt-2", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("x-tenant")),
    });
    expect(reused.statusCode).toBe(201);
  });

  it("Idempotency-Key replays return the stored response byte-for-byte", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "idem-replay", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("idem-replay")),
    });
    expect(first.statusCode).toBe(201);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "idem-replay", "content-type": "application/json" },
      payload: JSON.stringify(baseBody("idem-replay")),
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
  });
});
