/**
 * API-key scope matrix (R0.1).
 *
 * The scope guard (`requireScopeByMethod`, wired as a plugin-level preHandler on
 * every route plugin) enforces: `GET`/`HEAD` need `read`, mutating methods need
 * `write`, and an `admin` key passes everything. This suite proves it against a
 * real Postgres testcontainer + `createApp`, so the assertions exercise the
 * shipped middleware chain (auth → requireScopeByMethod → handler), not a fake.
 *
 * A least-privilege `read` key must be 403 on every mutating route (POST/DELETE)
 * and 200 on reads; an `admin` key must pass the same mutating routes.
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
import { FakeObjectStore } from "@pi-managed/testkit";

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

describe("API-key scope matrix (R0.1)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let adminKey: string;
  let readKey: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Scope Matrix Tenant" });
    adminKey = (
      await issueApiKey(pool, { tenantId: t.id }, { name: "admin", scopes: ["admin"] })
    ).key;
    readKey = (
      await issueApiKey(pool, { tenantId: t.id }, { name: "read", scopes: ["read"] })
    ).key;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("read key → 403 on a mutating POST (POST /v1/vaults)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vaults",
      headers: {
        ...auth(readKey),
        "idempotency-key": "sm-vault-read",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "should-not-create" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("read key → 403 on a mutating DELETE (DELETE /v1/vaults/:id)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/vaults/vault_doesnotexist",
      headers: auth(readKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("read key → 403 on POST /v1/api-keys (cannot mint keys)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        ...auth(readKey),
        "idempotency-key": "sm-key-read",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "nope" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("read key → 200 on a GET (GET /v1/vaults)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults",
      headers: auth(readKey),
    });
    expect(res.statusCode).toBe(200);
  });

  it("admin key passes the same mutating routes (POST/DELETE)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/vaults",
      headers: {
        ...auth(adminKey),
        "idempotency-key": "sm-vault-admin",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "admin-vault" }),
    });
    expect(create.statusCode).toBe(201);
    const vaultId = create.json().id as string;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/vaults/${vaultId}`,
      headers: auth(adminKey),
    });
    expect(del.statusCode).toBe(204);

    const mint = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        ...auth(adminKey),
        "idempotency-key": "sm-key-admin",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "minted", scopes: ["read"] }),
    });
    expect(mint.statusCode).toBe(201);
  });
});
