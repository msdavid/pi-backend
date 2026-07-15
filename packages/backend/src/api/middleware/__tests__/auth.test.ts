/**
 * Auth middleware + tenant routes (HTTP-level, WP-P0.4, §29.1 verify).
 *
 * Exercises the full `createApp` stack with a real Postgres testcontainer:
 * - `/healthz` is public; `/v1/*` requires a valid bearer key (401 otherwise);
 * - `GET /v1/tenant` returns the caller's tenant + zeroed quota stub;
 * - `POST /v1/api-keys` issues a key shown once and requires `Idempotency-Key`;
 * - cross-tenant negative: key A cannot list or delete tenant B's keys (404);
 * - a revoked key immediately fails auth (401).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { loadConfig } from "../../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../../domain/tenant/tenant.js";
import { issueApiKey } from "../../../domain/tenant/api-key.js";

describe("auth middleware + tenant routes (HTTP)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({
      config,
      logger: pino({ level: "error" }),
      pool,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("/healthz is public (no auth required)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /v1/tenant without auth → 401 unauthorized", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tenant" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    expect(res.json().error.requestId).toBeTruthy();
  });

  it("GET /v1/tenant with an invalid key → 401 unauthorized", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { authorization: "Bearer pmb_live_garbage" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("GET /v1/tenant with a valid key returns the right tenant + zeroed quota", async () => {
    const t = await createTenant(pool, { name: "HTTP Tenant", quotaPlan: "pro" });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(t.id);
    expect(body.name).toBe("HTTP Tenant");
    expect(body.quotaPlan).toBe("pro");
    expect(body.quotaUsage).toEqual({
      concurrentSessions: 0,
      concurrentSandboxes: 0,
      jobs: 0,
      vaultSize: 0,
      memorySize: 0,
      fileStorage: 0,
      tokenSpendUsd: 0,
    });
  });

  it("POST /v1/api-keys requires Idempotency-Key and issues a key shown once", async () => {
    const t = await createTenant(pool, { name: "Issue Co" });
    const seed = await issueApiKey(pool, { tenantId: t.id }, { name: "seed" });

    // Missing Idempotency-Key → 400.
    const noIdem = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${seed.key}`, "content-type": "application/json" },
      payload: JSON.stringify({ name: "new" }),
    });
    expect(noIdem.statusCode).toBe(400);
    expect(noIdem.json().error.code).toBe("invalid_request");

    // With Idempotency-Key → 201 + raw key shown once.
    const ok = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        authorization: `Bearer ${seed.key}`,
        "idempotency-key": "req-1",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "new", scopes: ["read"] }),
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body.id).toMatch(/^apikey_/);
    expect(body.key).toMatch(/^pmb_live_/);
    expect(body.name).toBe("new");
    expect(body.scopes).toEqual(["read"]);
    expect(body.createdAt).toBeTruthy();
  });

  it("GET /v1/api-keys lists keys without the raw key", async () => {
    const t = await createTenant(pool, { name: "List HTTP" });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "l" });
    const res = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(issued.id);
    expect(body.data[0]).not.toHaveProperty("key");
    expect(JSON.stringify(body)).not.toContain(issued.key);
  });

  it("cross-tenant: key A cannot list or delete tenant B's keys", async () => {
    const ta = await createTenant(pool, { name: "A2" });
    const tb = await createTenant(pool, { name: "B2" });
    const aKey = await issueApiKey(pool, { tenantId: ta.id }, { name: "a" });
    const bKey = await issueApiKey(pool, { tenantId: tb.id }, { name: "b" });

    // A lists keys → only A's key, never B's.
    const list = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: { authorization: `Bearer ${aKey.key}` },
    });
    expect(list.statusCode).toBe(200);
    const ids: string[] = list.json().data.map((k: { id: string }) => k.id);
    expect(ids).toContain(aKey.id);
    expect(ids).not.toContain(bKey.id);

    // A tries to delete B's key → 404 (not found in A's tenant).
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/api-keys/${bKey.id}`,
      headers: { authorization: `Bearer ${aKey.key}` },
    });
    expect(del.statusCode).toBe(404);
    expect(del.json().error.code).toBe("not_found");

    // B's key still authenticates and resolves to B.
    const bTenant = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { authorization: `Bearer ${bKey.key}` },
    });
    expect(bTenant.statusCode).toBe(200);
    expect(bTenant.json().tenantId).toBe(tb.id);
  });

  it("a revoked key immediately fails authentication (401)", async () => {
    const t = await createTenant(pool, { name: "Rev HTTP" });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "r" });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/api-keys/${issued.id}`,
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe("unauthorized");
  });
});
