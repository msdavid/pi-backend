/**
 * Fail-soft suspension enforcement (console spec §11.1, WP-C5.1) — HTTP level,
 * real Postgres.
 *
 * Pins the §11.1 contract at the request boundary: a saas tenant at balance ≤ 0
 * cannot start NEW work (session create/fork, turn start) but reads still work;
 * solo/team (`BILLING_ENABLED` off) are NEVER blocked. The enforcement reads only
 * local ledger state — no payment engine anywhere in the path.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { FakeSessionRuntime } from "@pi-managed/testkit";
import type { Session } from "@pi-managed/contracts";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { appendEntry, ensureBillingRow } from "../../domain/billing/index.js";
import { eventRoutes } from "../events.js";
import { ApiError } from "../../domain/errors.js";

describe("suspension enforcement (HTTP, integration)", () => {
  let db: TestDb;
  let pool: Pool;
  let saasApp: FastifyInstance; // BILLING_ENABLED=true
  let soloApp: FastifyInstance; // BILLING_ENABLED unset (self-hosted)

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const logger = pino({ level: "error" });
    saasApp = await createApp({
      config: loadConfig({ env: { BILLING_ENABLED: "true", LOG_LEVEL: "error" } }),
      logger,
      pool,
    });
    soloApp = await createApp({
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger,
      pool,
    });
  }, 120_000);

  afterAll(async () => {
    if (saasApp) await saasApp.close();
    if (soloApp) await soloApp.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function tenantWithKey(): Promise<{ tenantId: string; auth: string }> {
    const t = await createTenant(pool, { name: `Enf ${Math.random()}` });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k", scopes: ["admin"] });
    return { tenantId: t.id, auth: `Bearer ${issued.key}` };
  }

  const idem = () => ({ "idempotency-key": `k-${Math.random()}` });

  it("blocks new-session create for an unverified trial (balance 0) — 402, reason trial_unverified", async () => {
    const { tenantId, auth } = await tenantWithKey();
    await ensureBillingRow(pool, tenantId); // trial, balance 0, unverified

    const res = await saasApp.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: auth, ...idem() },
      payload: { agent: { id: "agent_x" }, environmentId: "env_x" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("budget_exhausted");
    expect(res.json().error.details.reason).toBe("trial_unverified");
  });

  it("still allows READS for a suspended tenant (fail-soft)", async () => {
    const { tenantId, auth } = await tenantWithKey();
    await ensureBillingRow(pool, tenantId);
    const res = await saasApp.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
  });

  it("blocks create for a drained (suspended) tenant — reason balance_exhausted", async () => {
    const { tenantId, auth } = await tenantWithKey();
    await appendEntry(pool, { tenantId, kind: "topup", amountMicros: 500_000, idempotencyKey: "up" });
    await appendEntry(pool, { tenantId, kind: "debit", amountMicros: -500_000, idempotencyKey: "down" });

    const res = await saasApp.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: auth, ...idem() },
      payload: { agent: { id: "agent_x" }, environmentId: "env_x" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.details.reason).toBe("balance_exhausted");
  });

  it("passes the gate for a funded tenant (reaches body validation → 422, not 402)", async () => {
    const { tenantId, auth } = await tenantWithKey();
    await appendEntry(pool, { tenantId, kind: "topup", amountMicros: 5_000_000, idempotencyKey: "fund" });

    const res = await saasApp.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: auth, ...idem() },
      payload: { garbage: true },
    });
    // Not blocked by the ledger gate — the request reaches createSession, which
    // rejects the malformed body. The point is it is NOT a 402.
    expect(res.statusCode).not.toBe(402);
    expect(res.statusCode).toBe(422);
  });

  it("never blocks a solo/team deployment (BILLING_ENABLED off), even at balance 0", async () => {
    const { tenantId, auth } = await tenantWithKey();
    await ensureBillingRow(pool, tenantId); // balance 0

    const res = await soloApp.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: auth, ...idem() },
      payload: { garbage: true },
    });
    expect(res.statusCode).not.toBe(402);
    expect(res.statusCode).toBe(422);
  });

  it("blocks a turn-start user.message for a suspended tenant, allows it when funded", async () => {
    // A focused HTTP test of the turn-start checkpoint: real pool + ledger, with
    // the session store / runtime as scripted collaborators (fakes). Seeds the
    // ledger to flip the gate; asserts the enforcement decision, not the runtime.
    const t = await createTenant(pool, { name: `Turn ${Math.random()}` });
    const ctx: TenantCtx = { tenantId: t.id, scopes: ["admin"] };
    await ensureBillingRow(pool, t.id); // balance 0

    const idleSession: Session = {
      id: "sess_turn",
      agentId: "agent_x",
      agentVersion: 1,
      environmentId: "env_x",
      status: "idle",
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      vaultIds: [],
      resources: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      forkedFromSessionId: null,
    };

    const app = Fastify({ genReqId: () => "req" });
    app.addHook("onRequest", async (req) => {
      req.tenantCtx = ctx;
    });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiError) return reply.status(err.statusCode).send({ error: { code: err.code, details: err.details } });
      return reply.status(500).send({ error: { code: "internal_error" } });
    });
    await app.register(eventRoutes, {
      pool,
      billingEnabled: true,
      resolveSession: async () => idleSession,
      resolveRuntime: async () => new FakeSessionRuntime(),
    });

    const message = {
      method: "POST" as const,
      url: "/v1/sessions/sess_turn/events",
      headers: { "idempotency-key": "turn-1" },
      payload: { type: "user.message", content: "hi" },
    };

    // Balance 0 ⇒ turn start blocked.
    const blocked = await app.inject(message);
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("budget_exhausted");

    // Fund the tenant ⇒ the same turn-start is accepted (202).
    await appendEntry(pool, { tenantId: t.id, kind: "topup", amountMicros: 5_000_000, idempotencyKey: "fund" });
    const ok = await app.inject({ ...message, headers: { "idempotency-key": "turn-2" } });
    expect(ok.statusCode).toBe(202);

    await app.close();
  });
});
