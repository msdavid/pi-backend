/**
 * Files API + session-outputs (WP-1.12, §8.9, §21, §16.6, §24.8).
 *
 * HTTP-level coverage for the Files CRUD over a real Postgres testcontainer +
 * FakeObjectStore: upload→download round-trip, list with session filter, delete
 * independence (§21 — files survive session deletion). Domain-level coverage for
 * the session-outputs slice against a FakeSandboxProvider: scripted `ls`/`cat`,
 * idle-only enforcement (409 when running), path-traversal rejection.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  tenantScopedQuery,
  type Pool,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { createEnvironment } from "../../domain/environment/environment.js";
import {
  listSessionOutputs,
  downloadSessionOutput,
  type SessionSandboxResolver,
} from "../../domain/file/index.js";
import { deleteSession } from "../../domain/session/index.js";
import { FakeObjectStore } from "@pi-managed/testkit";
import { FakeSandboxProvider } from "@pi-managed/testkit";
import type { TenantCtx } from "../../infra/db/pool.js";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4", thinkingLevel: "high" as const };

function agentBody(name: string) {
  return {
    name,
    model: MODEL,
    systemPrompt: "You are a meticulous code reviewer.",
    tools: {
      defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
      configs: {},
    },
    skills: [],
    extensions: [],
    mcpServers: [],
    multiagent: { roster: [] },
    metadata: {},
  };
}

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

/** Build a multipart/form-data body + content-type header from named parts. */
function multipart(
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer | string;
  }>,
): { headers: Record<string, string>; body: Buffer } {
  const boundary = `----piTestBoundary${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) disp += `; filename="${p.filename}"`;
    chunks.push(Buffer.from(`${disp}\r\n`));
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(typeof p.data === "string" ? Buffer.from(p.data) : p.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  };
}

describe("files API (HTTP)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let apiKey: string;
  let tenantId: string;
  let sessionId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({
      config,
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Files HTTP Tenant" });
    tenantId = t.id;
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    apiKey = issued.key;

    const ctx: TenantCtx = { tenantId };
    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "fa-agent", "content-type": "application/json" },
      payload: JSON.stringify(agentBody("files-agent")),
    });
    const agentId = agent.json().id;
    const env = await createEnvironment(pool, ctx, {
      name: "files-env",
      type: "cloud",
      image: "ubuntu:22.04",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    const sess = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(apiKey), "idempotency-key": "fa-sess", "content-type": "application/json" },
      payload: JSON.stringify({ agent: agentId, environmentId: env.id }),
    });
    sessionId = sess.json().id;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("upload requires auth + Idempotency-Key", async () => {
    const mp = multipart([{ name: "file", filename: "a.txt", data: "x" }]);
    const noAuth = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: mp.headers,
      payload: mp.body,
    });
    expect(noAuth.statusCode).toBe(401);

    const noIdem = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), ...mp.headers },
      payload: mp.body,
    });
    expect(noIdem.statusCode).toBe(400);
    expect(noIdem.json().error.code).toBe("invalid_request");
  });

  it("upload → download round-trip (content matches)", async () => {
    const content = Buffer.from("hello files api\n", "utf8");
    const mp = multipart([
      { name: "file", filename: "round-trip.txt", contentType: "text/plain", data: content },
      { name: "metadata", data: JSON.stringify({ origin: "test" }) },
    ]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), "idempotency-key": "rt-1", ...mp.headers },
      payload: mp.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const file = uploaded.json();
    expect(file.id).toMatch(/^file_/);
    expect(file.name).toBe("round-trip.txt");
    expect(file.contentType).toBe("text/plain");
    expect(file.sizeBytes).toBe(content.byteLength);
    expect(file.metadata).toEqual({ origin: "test" });

    // GET metadata.
    const meta = await app.inject({ method: "GET", url: `/v1/files/${file.id}`, headers: auth(apiKey) });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().id).toBe(file.id);

    // GET content → raw bytes match.
    const dl = await app.inject({
      method: "GET",
      url: `/v1/files/${file.id}/content`,
      headers: auth(apiKey),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("text/plain");
    expect(Buffer.from(dl.rawPayload).equals(content)).toBe(true);
  });

  it("upload with sessionId + list filter", async () => {
    const mp = multipart([
      { name: "file", filename: "output.txt", data: "session output" },
      { name: "sessionId", data: sessionId },
    ]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), "idempotency-key": "sf-1", ...mp.headers },
      payload: mp.body,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().sessionId).toBe(sessionId);

    // Filtered list returns the session-scoped file.
    const filtered = await app.inject({
      method: "GET",
      url: `/v1/files?sessionId=${sessionId}`,
      headers: auth(apiKey),
    });
    expect(filtered.statusCode).toBe(200);
    const rows = filtered.json().data;
    expect(rows.every((r: { sessionId: string }) => r.sessionId === sessionId)).toBe(true);
    expect(rows.map((r: { name: string }) => r.name)).toContain("output.txt");

    // Unfiltered list includes both session and non-session files.
    const all = await app.inject({ method: "GET", url: "/v1/files", headers: auth(apiKey) });
    expect(all.statusCode).toBe(200);
    expect(all.json().data.length).toBeGreaterThanOrEqual(2);
  });

  it("delete is hard (204 then 404); files are independent of sessions (§21)", async () => {
    const mp = multipart([{ name: "file", filename: "to-delete.txt", data: "bye" }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), "idempotency-key": "del-1", ...mp.headers },
      payload: mp.body,
    });
    const id = uploaded.json().id;

    const deleted = await app.inject({ method: "DELETE", url: `/v1/files/${id}`, headers: auth(apiKey) });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({ method: "GET", url: `/v1/files/${id}`, headers: auth(apiKey) });
    expect(gone.statusCode).toBe(404);

    // Delete the session → its surviving files remain (§21).
    const ctx: TenantCtx = { tenantId };
    const survivor = multipart([
      { name: "file", filename: "survivor.txt", data: "lives on" },
      { name: "sessionId", data: sessionId },
    ]);
    const survivorUpload = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), "idempotency-key": "del-2", ...survivor.headers },
      payload: survivor.body,
    });
    expect(survivorUpload.statusCode).toBe(201);
    const sessionFile = survivorUpload.json();

    const ok = await deleteSession(pool, ctx, sessionId);
    expect(ok).toBe(true);

    const stillThere = await app.inject({
      method: "GET",
      url: `/v1/files/${sessionFile.id}`,
      headers: auth(apiKey),
    });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json().name).toBe("survivor.txt");
  });

  it("get/download missing file → 404", async () => {
    const meta = await app.inject({ method: "GET", url: "/v1/files/file_missing", headers: auth(apiKey) });
    expect(meta.statusCode).toBe(404);
    const dl = await app.inject({ method: "GET", url: "/v1/files/file_missing/content", headers: auth(apiKey) });
    expect(dl.statusCode).toBe(404);
  });

  it("cross-tenant: tenant B cannot see tenant A's files", async () => {
    const mp = multipart([{ name: "file", filename: "secret.txt", data: "private" }]);
    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...auth(apiKey), "idempotency-key": "xt-1", ...mp.headers },
      payload: mp.body,
    });
    const id = uploaded.json().id;

    const tb = await createTenant(pool, { name: "Other Files Tenant" });
    const bKey = (await issueApiKey(pool, { tenantId: tb.id }, { name: "bk" })).key;

    const got = await app.inject({ method: "GET", url: `/v1/files/${id}`, headers: auth(bKey) });
    expect(got.statusCode).toBe(404);
  });
});

describe("session outputs (domain, FakeSandboxProvider)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let apiKey: string;
  let tenantId: string;
  let idleSessionId: string;
  let provider: FakeSandboxProvider;
  let resolver: SessionSandboxResolver;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({
      config,
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Outputs Tenant" });
    tenantId = t.id;
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    apiKey = issued.key;

    const ctx: TenantCtx = { tenantId };
    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { ...auth(apiKey), "idempotency-key": "out-agent", "content-type": "application/json" },
      payload: JSON.stringify(agentBody("outputs-agent")),
    });
    const env = await createEnvironment(pool, ctx, {
      name: "outputs-env",
      type: "cloud",
      image: "ubuntu:22.04",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    const sess = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...auth(apiKey), "idempotency-key": "out-sess", "content-type": "application/json" },
      payload: JSON.stringify({ agent: agent.json().id, environmentId: env.id }),
    });
    idleSessionId = sess.json().id;

    provider = new FakeSandboxProvider();
    resolver = {
      async resolve(_ctx, sid) {
        return provider.handleForName(sandboxName(tenantId, sid));
      },
    };
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("lists outputs from a scripted `ls` (idle session)", async () => {
    const ctx: TenantCtx = { tenantId };
    await provider.provision({
      name: sandboxName(tenantId, idleSessionId),
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      labels: { tenant: tenantId, session: idleSessionId },
      detached: true,
    });
    provider.scriptExec(sandboxName(tenantId, idleSessionId), [
      { stdout: "report.md\ndata.csv\n" },
    ]);
    const result = await listSessionOutputs(pool, ctx, provider, resolver, idleSessionId);
    expect(result.data.map((d) => d.name).sort()).toEqual(["data.csv", "report.md"]);
  });

  it("downloads an output (scripted `cat`)", async () => {
    const ctx: TenantCtx = { tenantId };
    provider.scriptExec(sandboxName(tenantId, idleSessionId), [
      { stdout: "# Report\nfinal content\n" },
    ]);
    const dl = await downloadSessionOutput(pool, ctx, provider, resolver, idleSessionId, "report.md");
    expect(dl.name).toBe("report.md");
    const bytes = await drain(dl.stream);
    expect(Buffer.from(bytes).toString("utf8")).toBe("# Report\nfinal content\n");
  });

  it("idle-only enforcement: running session → 409 session_not_idle", async () => {
    const ctx: TenantCtx = { tenantId };
    await tenantScopedQuery(
      pool,
      ctx,
      `UPDATE sessions SET status = 'running' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, idleSessionId],
    );
    await expect(
      listSessionOutputs(pool, ctx, provider, resolver, idleSessionId),
    ).rejects.toMatchObject({ statusCode: 409, code: "session_not_idle" });

    await expect(
      downloadSessionOutput(pool, ctx, provider, resolver, idleSessionId, "report.md"),
    ).rejects.toMatchObject({ statusCode: 409, code: "session_not_idle" });

    // Restore idle for subsequent suites.
    await tenantScopedQuery(
      pool,
      ctx,
      `UPDATE sessions SET status = 'idle' WHERE tenant_id = $1 AND id = $2`,
      [tenantId, idleSessionId],
    );
  });

  it("path traversal in filename → 422", async () => {
    const ctx: TenantCtx = { tenantId };
    await expect(
      downloadSessionOutput(pool, ctx, provider, resolver, idleSessionId, "../etc/passwd"),
    ).rejects.toMatchObject({ statusCode: 422, code: "invalid_request" });
  });
});

/** Sandbox name per the tenant-namespacing convention (§27.2). */
function sandboxName(tenantId: string, sessionId: string): string {
  return `t${tenantId}-s${sessionId}`;
}

/** Drain a `ReadableStream<Uint8Array>` into a `Uint8Array`. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
