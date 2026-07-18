/**
 * Machine credit-surface (console spec §11.7, WP-C5.1) — HTTP level, real
 * Postgres.
 *
 * Pins the §11.7 / §13 contract: the surface the billing adapter calls to credit
 * the ledger accepts ONLY the machine credential (constant-time bearer, NOT a
 * tenant key), is fail-closed when no secret is configured, and credits the
 * ledger EXACTLY once under webhook replay.
 *
 * The token below is a locally-generated, obviously test-only string — NOT a
 * provider credential (CONVENTIONS: never place provider credentials anywhere).
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
import { getBillingRow } from "../../domain/billing/index.js";
import { BILLING_CREDIT_PATH } from "../billing-internal.js";

const MACHINE_TOKEN = "test-only-machine-provision-secret-not-a-real-credential";

describe("machine credit-surface (HTTP, integration)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance; // BILLING_PROVISION_TOKEN configured
  let appNoSecret: FastifyInstance; // no token → fail-closed

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const logger = pino({ level: "error" });
    app = await createApp({
      config: loadConfig({
        env: { BILLING_PROVISION_TOKEN: MACHINE_TOKEN, LOG_LEVEL: "error" },
      }),
      logger,
      pool,
    });
    appNoSecret = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger,
      pool,
    });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (appNoSecret) await appNoSecret.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function freshTenant(): Promise<string> {
    const t = await createTenant(pool, { name: `Credit ${Math.random()}` });
    return t.id;
  }

  it("credits the ledger with the machine credential and is idempotent under replay", async () => {
    const tenantId = await freshTenant();
    const body = {
      tenantId,
      amountMicros: 5_000_000,
      idempotencyKey: "stripe-evt_123",
      source: "stripe",
    };
    const first = await app.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().applied).toBe(true);
    expect(first.json().balanceMicros).toBe(5_000_000);

    // Replay the same idempotency key → credited exactly once (console spec §13).
    const replay = await app.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().applied).toBe(false);
    expect(replay.json().balanceMicros).toBe(5_000_000);

    expect((await getBillingRow(pool, tenantId))?.balanceMicros).toBe(5_000_000);
  });

  it("rejects a wrong machine token (401) and does not credit", async () => {
    const tenantId = await freshTenant();
    const res = await app.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: "Bearer wrong-token" },
      payload: { tenantId, amountMicros: 1_000, idempotencyKey: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(await getBillingRow(pool, tenantId)).toBeNull();
  });

  it("rejects a tenant API key — this is NOT a tenant-authenticated route", async () => {
    const tenantId = await freshTenant();
    const issued = await issueApiKey(pool, { tenantId }, { name: "k", scopes: ["admin"] });
    const res = await app.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: `Bearer ${issued.key}` },
      payload: { tenantId, amountMicros: 1_000, idempotencyKey: "y" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is fail-closed with no secret configured (rejects even a blank/any token)", async () => {
    const tenantId = await freshTenant();
    const withToken = await appNoSecret.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: { tenantId, amountMicros: 1_000, idempotencyKey: "z" },
    });
    expect(withToken.statusCode).toBe(401);

    const blank = await appNoSecret.inject({
      method: "POST",
      url: BILLING_CREDIT_PATH,
      headers: { authorization: "Bearer " },
      payload: { tenantId, amountMicros: 1_000, idempotencyKey: "z2" },
    });
    expect(blank.statusCode).toBe(401);
  });
});
