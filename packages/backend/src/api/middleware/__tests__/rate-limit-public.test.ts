/**
 * Rate-limit middleware: unauthenticated (public-path) coverage (WP-R0.8).
 *
 * The limiter used to key exclusively on `request.tenantCtx.tenantId` and no-op
 * when it was absent — so every path on the auth allowlist (notably the public
 * `POST /v1/onboarding/signup`, which creates a tenant and runs a deliberately
 * expensive argon2id hash per call) was completely unthrottled.
 *
 * These tests cover:
 * - anonymous requests are throttled per client IP (429 + Retry-After);
 * - buckets are keyed per IP (one IP's flood does not throttle another);
 * - `X-Forwarded-For` is honoured only when the peer is a configured trusted
 *   proxy, and ignored (spoof-proof) otherwise;
 * - idle buckets are evicted so the map stays bounded;
 * - the real `POST /v1/onboarding/signup` route is throttled end-to-end.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { rateLimitMiddleware, PostgresBucketStore } from "../rate-limit.js";
import { createApp } from "../../../server.js";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { loadConfig } from "../../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";

/** A public app: no auth hook, so `request.tenantCtx` is never set. */
function buildPublicApp(opts: Parameters<typeof rateLimitMiddleware>[1] = {}): {
  app: FastifyInstance;
  limiter: ReturnType<typeof rateLimitMiddleware>;
} {
  const app = Fastify();
  const limiter = rateLimitMiddleware(app, opts);
  app.post("/v1/onboarding/signup", async (_req, reply) => reply.status(200).send({ ok: true }));
  return { app, limiter };
}

describe("rate-limit middleware (unauthenticated requests)", () => {
  it("throttles anonymous requests per client IP (429 + Retry-After)", async () => {
    const { app } = buildPublicApp({ anonRpm: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/onboarding/signup",
          remoteAddress: "203.0.113.9",
        });
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(res.headers["retry-after"]).toBeDefined();
          const parsed = JSON.parse(res.body) as { error: { code: string } };
          expect(parsed.error.code).toBe("rate_limited");
        }
      }
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes[3]).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("keys anonymous buckets per IP (one flooder does not throttle others)", async () => {
    const { app } = buildPublicApp({ anonRpm: 2 });
    try {
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: "POST", url: "/v1/onboarding/signup", remoteAddress: "203.0.113.1" });
      }
      const other = await app.inject({
        method: "POST",
        url: "/v1/onboarding/signup",
        remoteAddress: "203.0.113.2",
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("ignores X-Forwarded-For from an untrusted peer (no spoofing past the limit)", async () => {
    const { app } = buildPublicApp({ anonRpm: 2 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/onboarding/signup",
          remoteAddress: "203.0.113.5",
          headers: { "x-forwarded-for": `198.51.100.${i}` }, // spoofed, rotating
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await app.close();
    }
  });

  it("honours X-Forwarded-For from a trusted proxy", async () => {
    const { app } = buildPublicApp({ anonRpm: 2, trustedProxies: ["10.0.0.1"] });
    try {
      // Two distinct forwarded clients behind the same trusted proxy: each gets
      // its own bucket, so neither is throttled at rpm=2.
      for (let i = 0; i < 2; i++) {
        for (const client of ["198.51.100.7", "198.51.100.8"]) {
          const res = await app.inject({
            method: "POST",
            url: "/v1/onboarding/signup",
            remoteAddress: "10.0.0.1",
            headers: { "x-forwarded-for": `${client}, 10.0.0.1` },
          });
          expect(res.statusCode).toBe(200);
        }
      }
      // The third request from one forwarded client exhausts *that* bucket only.
      const blocked = await app.inject({
        method: "POST",
        url: "/v1/onboarding/signup",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("wires config `rateLimitAnonRpm` into the anonymous ceiling (loadConfig → middleware)", async () => {
    // Prove the anon ceiling is config-driven, not hardcoded: RATE_LIMIT_ANON_RPM=2
    // flows through loadConfig and into the middleware, so the 3rd unauthenticated
    // POST /v1/onboarding/signup from one IP is throttled.
    const cfg = loadConfig({ env: { RATE_LIMIT_ANON_RPM: "2" } });
    expect(cfg.rateLimitAnonRpm).toBe(2);
    const { app } = buildPublicApp({
      anonRpm: cfg.rateLimitAnonRpm,
      trustedProxies: cfg.trustedProxies,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/onboarding/signup",
          remoteAddress: "203.0.113.42",
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await app.close();
    }
  });

  it("evicts idle buckets so the map stays bounded", async () => {
    const { app, limiter } = buildPublicApp({ anonRpm: 60, bucketTtlMs: 20, sweepIntervalMs: 0 });
    try {
      await app.inject({ method: "POST", url: "/v1/onboarding/signup", remoteAddress: "203.0.113.20" });
      expect(limiter.bucketCount()).toBe(1);
      await new Promise((r) => setTimeout(r, 40));
      // A request from a *different* IP triggers the sweep: the idle bucket for
      // .20 is dropped, so the map holds only the new one.
      await app.inject({ method: "POST", url: "/v1/onboarding/signup", remoteAddress: "203.0.113.21" });
      expect(limiter.bucketCount()).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("rate-limit middleware: POST /v1/onboarding/signup (HTTP, real stack)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      // A low, test-only ceiling: the default 30rpm bucket refills fast enough
      // under parallel test-suite load that a 31-request flood can race the
      // refill and never observe a 429. A 5-token bucket cannot refill a whole
      // token within the time 6 sequential (argon2id-hashing) HTTP round-trips
      // take, so the cutoff below is deterministic regardless of wall-clock
      // pacing.
      config: loadConfig({
        env: { LOG_LEVEL: "error", ONBOARDING_ENABLED: "true", RATE_LIMIT_ANON_RPM: "5" },
      }),
      logger: pino({ level: "error" }),
      pool,
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("throttles a rapid flood of unauthenticated sign-ups from one IP", async () => {
    const codes: number[] = [];
    let retryAfter: string | undefined;
    // Configured anonymous capacity above is 5 rpm; fire capacity + 1 requests
    // and assert the exact cutoff.
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/onboarding/signup",
        remoteAddress: "203.0.113.77",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          tenantName: `Flood ${i}`,
          adminEmail: `flood-${i}@example.com`,
          backendUrl: "https://api.example",
        }),
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) retryAfter = res.headers["retry-after"] as string | undefined;
    }
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
    expect(retryAfter).toBeDefined();
    // …and the throttled call must not have created a tenant.
    const { rows } = await query<{ n: string }>(pool, "SELECT count(*)::text AS n FROM tenants", []);
    expect(Number(rows[0]!.n)).toBeLessThan(6);
  }, 180_000);

  it("shares one PostgresBucketStore across two limiters (global ceiling)", async () => {
    // Two independent limiter instances backed by ONE shared Postgres store must
    // deplete a single global ceiling — the point of the shared store (a
    // per-process Map would give each app its own full bucket → 2× the ceiling).
    const store = new PostgresBucketStore(pool, { reapIntervalMs: 0 });
    const a = buildPublicApp({ anonRpm: 2, store });
    const b = buildPublicApp({ anonRpm: 2, store });
    const ip = "203.0.113.200";
    const hit = (which: typeof a) =>
      which.app.inject({ method: "POST", url: "/v1/onboarding/signup", remoteAddress: ip });
    try {
      // Capacity 2, shared: one request through each app is allowed…
      expect((await hit(a)).statusCode).toBe(200);
      expect((await hit(b)).statusCode).toBe(200);
      // …the third request (from either app) is throttled by the shared ceiling.
      expect((await hit(a)).statusCode).toBe(429);
      expect((await hit(b)).statusCode).toBe(429);
    } finally {
      await a.app.close();
      await b.app.close();
      store.close();
    }
  }, 180_000);
});
