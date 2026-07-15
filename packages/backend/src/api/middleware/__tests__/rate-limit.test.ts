/**
 * Rate-limit middleware tests (WP-P0.5, §"Rate limiting").
 *
 * - 429 + Retry-After after the token bucket is exhausted.
 * - X-RateLimit-Limit / Remaining / Reset headers present on normal responses.
 * - No tenant context → no-op (no headers, no throttling).
 */

import { beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { rateLimitMiddleware } from "../rate-limit.js";
import type { TenantCtx } from "../../../infra/db/index.js";

const TENANT: TenantCtx = { tenantId: "tnt_rl" };

async function buildApp(rpm: number, withTenant = true): Promise<FastifyInstance> {
  const app = Fastify();
  if (withTenant) {
    app.addHook("onRequest", async (req) => {
      req.tenantCtx = TENANT;
    });
  }
  rateLimitMiddleware(app, { rpm });
  app.get("/ping", async (_req, reply) => reply.status(200).send({ ok: true }));
  return app;
}

describe("rate-limit middleware", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(3);
  }, 30_000);

  it("sets X-RateLimit-* headers on a normal response", async () => {
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("returns 429 + Retry-After once the bucket is exhausted", async () => {
    // rpm=3 → capacity 3. The previous test consumed 1; consume the rest, then
    // the next request must be throttled.
    await app.inject({ method: "GET", url: "/ping" });
    await app.inject({ method: "GET", url: "/ping" });
    const blocked = await app.inject({ method: "GET", url: "/ping" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    const parsed = JSON.parse(blocked.body);
    expect(parsed.error.code).toBe("rate_limited");
    expect(parsed.error.type).toBe("rate_limited");
  });

  it("falls back to per-IP limiting without a tenant context (WP-R0.8)", async () => {
    // Anonymous requests are no longer un-throttled: they key on the client IP
    // with the `anonRpm` capacity. Same IP → shared bucket → 429 once drained.
    const anonApp = Fastify();
    rateLimitMiddleware(anonApp, { anonRpm: 1 });
    anonApp.get("/ping", async (_req, reply) => reply.status(200).send({ ok: true }));
    try {
      const first = await anonApp.inject({ method: "GET", url: "/ping", remoteAddress: "203.0.113.1" });
      const second = await anonApp.inject({ method: "GET", url: "/ping", remoteAddress: "203.0.113.1" });
      expect(first.statusCode).toBe(200);
      expect(first.headers["x-ratelimit-limit"]).toBe("1");
      expect(second.statusCode).toBe(429);
      expect(second.headers["retry-after"]).toBeDefined();
    } finally {
      await anonApp.close();
    }
  });
});
