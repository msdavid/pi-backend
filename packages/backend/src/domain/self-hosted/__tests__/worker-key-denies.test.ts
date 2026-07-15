/**
 * Self-hosted worker keys are truly scoped (R0.2, depends on R0.1).
 *
 * A worker key runs on *customer* infrastructure and must be able to do exactly
 * three things: claim work for its environment, post a result for its
 * environment, and nothing else. It carries only a `self_hosted_worker:<envId>`
 * scope, which satisfies none of `read`/`write`/`admin` — so the `requireScope`
 * guard threaded onto every other route (R0.1) denies it by default.
 *
 * This suite proves, against a real Postgres testcontainer + `createApp`:
 *  - a worker key is 403 on `GET /v1/vaults`, `POST /v1/api-keys`, `GET /v1/sessions`;
 *  - it is 403 claiming work for a *different* environment (env binding);
 *  - it succeeds (2xx) claiming work for *its own* environment.
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
import {
  startPostgres,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { createEnvironment } from "../../environment/environment.js";
import { issueWorkerKey } from "../worker-keys.js";
import { FakeObjectStore } from "@pi-managed/testkit";

function auth(key: string) {
  return { authorization: `Bearer ${key}` };
}

const ENV_BODY = (name: string) => ({
  name,
  type: "cloud" as const,
  image: "ubuntu:22.04",
  resources: { cpus: 1, memoryMiB: 512 },
  networking: { mode: "unrestricted" as const },
});

describe("self-hosted worker key is denied everywhere but its work queue (R0.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let workerKey: string;
  let envAId: string;
  let envBId: string;

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
    const t = await createTenant(pool, { name: "Worker Key Tenant" });
    const ctx = { tenantId: t.id };
    const envA = await createEnvironment(pool, ctx, ENV_BODY("worker-env-a"));
    const envB = await createEnvironment(pool, ctx, ENV_BODY("worker-env-b"));
    envAId = envA.id;
    envBId = envB.id;
    // A worker key scoped to env A only (scopes: ["self_hosted_worker:<envAId>"]).
    workerKey = (await issueWorkerKey(pool, ctx, envAId, "worker-a")).key;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("worker key → 403 on GET /v1/vaults", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults",
      headers: auth(workerKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("worker key → 403 on POST /v1/api-keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        ...auth(workerKey),
        "idempotency-key": "wk-mint",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "nope" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("worker key → 403 on GET /v1/sessions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: auth(workerKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("worker key → 403 claiming work for a DIFFERENT environment", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/environments/${envBId}/work-claim`,
      headers: auth(workerKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("worker key → 2xx claiming work for its OWN environment (204 when idle)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/environments/${envAId}/work-claim`,
      headers: auth(workerKey),
    });
    // No queued work for a fresh env → 204 (the worker polls again). The point
    // is that it is NOT 403: the work-claim route carries no scope guard, so the
    // worker key reaches requireWorkerKeyForEnv, which accepts its own env.
    expect(res.statusCode).toBe(204);
  });
});
