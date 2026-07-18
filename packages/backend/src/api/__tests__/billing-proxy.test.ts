/**
 * Tenant billing link-out proxy (console spec §11.7–11.8, WP-C5.3 F4) — the
 * `/v1/tenant/billing/{checkout,portal,auto-charge}` routes that forward to the
 * billing adapter over the machine channel.
 *
 * These tests exercise the proxy logic in isolation (Fastify `inject`, a stubbed
 * tenant ctx, a fake `fetch` standing in for the adapter transport). They pin the
 * two behaviors the wire seam turns on:
 *  - **no-adapter degradation** — with no adapter configured every route is
 *    `404 no_adapter`, the state the console renders as "no adapter" (§11.8);
 *  - **forward + relay + error mapping** — with an adapter configured the tenant is
 *    resolved here and forwarded (Bearer machine secret + tenant id); a 2xx relays,
 *    an adapter 4xx surfaces as-is, a 401/5xx collapses to `502` (never leaks).
 *
 * The end-to-end round-trip against a REAL adapter handler lives in
 * `billing-adapter`'s `checkout-portal-seam.integration.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { billingRoutes, type BillingAdapterProxy } from "../billing.js";
import { ApiError } from "../../domain/errors.js";
import type { EmailSender } from "../../domain/ports.js";
import type { Pool } from "../../infra/db/index.js";

const NOOP_EMAIL: EmailSender = { send: async () => {} };
const DUMMY_POOL = {} as Pool;
const MACHINE_TOKEN = "test-only-machine-secret-not-a-real-credential";

/** A full, valid contract `AutoChargeConfig` the fake adapter returns. */
const ADAPTER_CONFIG = {
  enabled: true,
  thresholdMicros: 5_000_000,
  thresholdUsd: 5,
  amountMicros: 20_000_000,
  amountUsd: 20,
  dailyCapMicros: 100_000_000,
  dailyCapUsd: 100,
  monthlyCapMicros: 1_000_000_000,
  monthlyCapUsd: 1000,
  lastChargeAt: null,
  lastChargeUsd: null,
  disabledReason: null,
};

interface Captured {
  url: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

/** Build an app with billingRoutes, a stubbed admin tenant ctx, and an ApiError handler. */
async function buildApp(adapter?: BillingAdapterProxy): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ code: err.code, message: err.message });
    }
    return reply.status(500).send({ code: "internal_error", message: (err as Error).message });
  });
  // Stub the auth chain: attach an admin tenant ctx (real auth is tested elsewhere).
  app.addHook("preHandler", async (req: FastifyRequest) => {
    (req as FastifyRequest & { tenantCtx: { tenantId: string; scopes: string[] } }).tenantCtx = {
      tenantId: "tenant_proxy",
      scopes: ["admin"],
    };
  });
  await app.register(billingRoutes, {
    pool: DUMMY_POOL,
    emailSender: NOOP_EMAIL,
    ...(adapter ? { adapter } : {}),
  });
  await app.ready();
  return app;
}

/** A fake adapter transport: records each call and replies with a scripted response. */
function fakeFetch(script: (captured: Captured) => { status: number; body?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(captured);
    const { status, body } = script(captured);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("billing link-out proxy — no adapter configured (§11.8 no-adapter state)", () => {
  it("404 no_adapter on every one of the four routes", async () => {
    app = await buildApp(undefined);
    const routes: Array<[string, string]> = [
      ["GET", "/v1/tenant/billing/auto-charge"],
      ["PATCH", "/v1/tenant/billing/auto-charge"],
      ["POST", "/v1/tenant/billing/checkout"],
      ["POST", "/v1/tenant/billing/portal"],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as "GET", url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().code).toBe("not_found");
    }
  });
});

describe("billing link-out proxy — adapter configured (forward + relay)", () => {
  it("GET auto-charge forwards the tenant id + machine bearer and relays the config", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: ADAPTER_CONFIG }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({ method: "GET", url: "/v1/tenant/billing/auto-charge" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, thresholdMicros: 5_000_000 });
    expect(calls[0].url).toBe("http://adapter.test/internal/adapter/auto-charge?tenantId=tenant_proxy");
    expect(calls[0].authorization).toBe(`Bearer ${MACHINE_TOKEN}`);
  });

  it("PATCH auto-charge forwards the tenant id + USD update body and relays the config", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: ADAPTER_CONFIG }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({
      method: "PATCH",
      url: "/v1/tenant/billing/auto-charge",
      payload: { enabled: true, thresholdUsd: 5, amountUsd: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual({
      tenantId: "tenant_proxy",
      enabled: true,
      thresholdUsd: 5,
      amountUsd: 20,
    });
  });

  it("checkout relays the hosted link", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { url: "https://checkout.test/pay" },
    }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({
      method: "POST",
      url: "/v1/tenant/billing/checkout",
      payload: { amountUsd: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://checkout.test/pay" });
    expect(calls[0].body).toEqual({ tenantId: "tenant_proxy", amountUsd: 25 });
  });

  it("portal relays the hosted link", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { url: "https://portal.test/p" } }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({ method: "POST", url: "/v1/tenant/billing/portal", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://portal.test/p" });
  });

  it("an adapter 4xx (e.g. 409 no saved card) surfaces with its own status", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 409,
      body: { error: "no_saved_customer", message: "no saved payment method" },
    }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({ method: "POST", url: "/v1/tenant/billing/portal", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("conflict");
  });

  it("an adapter 401 (backend misconfig) collapses to 502 — never surfaced as an auth error", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401 }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({ method: "GET", url: "/v1/tenant/billing/auto-charge" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("internal_error");
  });

  it("an adapter 5xx collapses to 502", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 500 }));
    app = await buildApp({ baseUrl: "http://adapter.test", provisionToken: MACHINE_TOKEN, fetchImpl });

    const res = await app.inject({ method: "POST", url: "/v1/tenant/billing/checkout", payload: {} });
    expect(res.statusCode).toBe(502);
  });
});
