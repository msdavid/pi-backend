/**
 * `GET /v1/sessions/:id/metrics` — per-session sandbox metrics (W8.3, §26.4).
 *
 * HTTP-level coverage over a real Postgres testcontainer + `FakeSandboxProvider`. The
 * fake is what makes the *plumbing* assertable without a VM: route mounting, `read`
 * scope, tenant scoping, the 404s (unknown session / never-provisioned / stopped VM),
 * and the wire shape. That the NUMBERS are real is asserted by
 * `infra/sandbox/__tests__/@kvm.metrics.test.ts` against a live microVM — a fake can
 * never prove that.
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
import { FakeObjectStore, FakeSandboxProvider } from "@pi-managed/testkit";
import type { SandboxMetrics } from "../../domain/ports.js";
import type { TenantCtx } from "../../infra/db/pool.js";

const MODEL = {
  provider: "anthropic",
  id: "claude-sonnet-4",
  thinkingLevel: "high" as const,
};

function agentBody(name: string) {
  return {
    name,
    model: MODEL,
    systemPrompt: "You are a careful assistant.",
    tools: { defaultConfig: { enabled: true, permissionPolicy: "always_allow" }, configs: {} },
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

/** A sample distinguishable from the fake's baseline, so we know it came from the port. */
const SAMPLE: SandboxMetrics = {
  cpuPercent: 42.5,
  memoryBytes: 123_456_789,
  memoryLimitBytes: 536_870_912,
  diskReadBytes: 4_096,
  diskWriteBytes: 8_192,
  netRxBytes: 1_024,
  netTxBytes: 2_048,
  uptimeMs: 61_000,
  sampledAt: "2026-07-14T12:00:00.000Z",
};

describe("GET /v1/sessions/:id/metrics", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let sandbox: FakeSandboxProvider;
  let apiKey: string;
  let tenantId: string;
  let ctx: TenantCtx;
  /** Session with a live (running) fake VM. */
  let liveSessionId: string;
  /** Session that never provisioned a VM (lazy sandbox — `sandbox_handle` is NULL). */
  let coldSessionId: string;

  /** Create a session via the API and return its id. */
  async function newSession(idemKey: string, environmentId: string, agentId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: {
        ...auth(apiKey),
        "idempotency-key": idemKey,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ agent: agentId, environmentId }),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    sandbox = new FakeSandboxProvider();
    app = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
      sandboxProvider: sandbox,
    });

    const t = await createTenant(pool, { name: "Metrics Tenant" });
    tenantId = t.id;
    ctx = { tenantId };
    apiKey = (await issueApiKey(pool, { tenantId }, { name: "k" })).key;

    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: {
        ...auth(apiKey),
        "idempotency-key": "m-agent",
        "content-type": "application/json",
      },
      payload: JSON.stringify(agentBody("metrics-agent")),
    });
    const agentId = agent.json().id;
    const env = await createEnvironment(pool, ctx, {
      name: "metrics-env",
      type: "cloud",
      image: "ubuntu:22.04",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });

    liveSessionId = await newSession("m-sess-1", env.id, agentId);
    coldSessionId = await newSession("m-sess-2", env.id, agentId);

    // Give the live session a running VM: provision it in the fake and persist the
    // handle name on the row, exactly as the session manager does on first wake.
    const vmName = `t${tenantId}-s${liveSessionId}`;
    await sandbox.provision({
      name: vmName,
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      labels: { tenant: tenantId, session: liveSessionId },
    });
    sandbox.scriptMetrics(vmName, SAMPLE);
    await tenantScopedQuery(
      pool,
      ctx,
      `UPDATE sessions SET sandbox_handle = $1 WHERE tenant_id = $2 AND id = $3`,
      [vmName, tenantId, liveSessionId],
    );
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("returns the running VM's sample (200)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${liveSessionId}/metrics`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: liveSessionId, ...SAMPLE });
    // The sample came through the port, not from a cached/synthesized value.
    expect(sandbox.calls.some((c) => c.kind === "metrics")).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${liveSessionId}/metrics`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires the `read` scope (403 for a write-only key)", async () => {
    const writeOnly = (
      await issueApiKey(pool, { tenantId }, { name: "w", scopes: ["write"] })
    ).key;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${liveSessionId}/metrics`,
      headers: auth(writeOnly),
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s a session with no VM yet (lazy sandbox — never provisioned)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${coldSessionId}/metrics`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404s an unknown session id", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/sess_does_not_exist/metrics`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s another tenant's session (tenant-scoped)", async () => {
    const other = await createTenant(pool, { name: "Other Tenant" });
    const otherKey = (await issueApiKey(pool, { tenantId: other.id }, { name: "k2" })).key;
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${liveSessionId}/metrics`,
      headers: auth(otherKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s once the VM is stopped — no fabricated zero sample", async () => {
    const handle = sandbox.handleForName(`t${tenantId}-s${liveSessionId}`);
    await sandbox.stop(handle);
    const res = await app.inject({
      method: "GET",
      url: `/v1/sessions/${liveSessionId}/metrics`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(404);
    // Restore for any later test ordering.
    await sandbox.start(handle);
  });
});
