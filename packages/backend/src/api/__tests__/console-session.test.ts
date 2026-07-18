/**
 * Console sessions — cookie auth + CSRF (WP-C1.2, console spec §4; conformance
 * C§13 items §4.1/§4.5).
 *
 * Integration suite against a real Postgres testcontainer + `createApp`, so the
 * assertions exercise the shipped chain (console serve hook → auth hook with
 * cookie fallback → routes), not a fake:
 *
 * - valid key → cookie → `/v1` reads succeed with cookie only (§4.2–4.3);
 * - cookie-authed mutation without `X-Console-Csrf: 1` → 403 (§4.5);
 * - revoked key → next cookie use 401 (§4.6);
 * - bearer wins when both are present (§4.3);
 * - sliding TTL bump observable (§4.6);
 * - sign-out invalidates the session server-side (§4.4).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import pino from "pino";
import { ConsoleSessionCreateResponse, ConsoleSessionInfo } from "@pi-managed/contracts";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { FakeObjectStore } from "@pi-managed/testkit";

const COOKIE = "pi_console_session";

/** Sign in with `apiKey`; return the raw cookie token from Set-Cookie. */
async function signIn(app: FastifyInstance, apiKey: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/console/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ apiKey }),
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /pi_console_session=([^;]+)/.exec(header ?? "");
  expect(match).not.toBeNull();
  return match![1];
}

function cookie(token: string) {
  return { cookie: `${COOKIE}=${token}` };
}

describe("console sessions: cookie auth + CSRF (WP-C1.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let tenantId: string;
  let adminKey: string;
  let otherTenantId: string;
  let otherAdminKey: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    app = await createApp({
      // Defaults → onboarding off → solo mode → 30-day sliding TTL (§4.6).
      config: loadConfig({ env: { LOG_LEVEL: "error" } }),
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Console Session Tenant" });
    tenantId = t.id;
    adminKey = (
      await issueApiKey(pool, { tenantId }, { name: "admin", scopes: ["admin"] })
    ).key;
    const other = await createTenant(pool, { name: "Other Tenant" });
    otherTenantId = other.id;
    otherAdminKey = (
      await issueApiKey(
        pool,
        { tenantId: otherTenantId },
        { name: "other-admin", scopes: ["admin"] },
      )
    ).key;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("POST /console/session: valid key → cookie + {scopes, tenant}, key never echoed (§4.2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/console/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ apiKey: adminKey }),
    });
    expect(res.statusCode).toBe(201);
    const body = ConsoleSessionCreateResponse.parse(res.json());
    expect(body).toEqual({
      scopes: ["admin"],
      tenant: { id: tenantId, name: "Console Session Tenant" },
    });
    expect(res.body).not.toContain(adminKey);
    const setCookie = res.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(header).toMatch(/^pi_console_session=[A-Za-z0-9_-]+; /);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    // §3.4 security headers on the console-session responses too.
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("POST /console/session: invalid key → 401 standard envelope (§4.2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/console/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ apiKey: "pmb_live_not_a_real_key" }),
    });
    expect(res.statusCode).toBe(401);
    const err = res.json().error;
    expect(err.code).toBe("unauthorized");
    expect(err.requestId).toBeTruthy();
  });

  it("cookie-only /v1 reads succeed with the same identity as the key (§4.3)", async () => {
    const token = await signIn(app, adminKey);
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(tenantId);
  });

  it("GET /console/session: {scopes, tenant, expiresAt} with cookie; 401 without (§4.4)", async () => {
    const token = await signIn(app, adminKey);
    const res = await app.inject({
      method: "GET",
      url: "/console/session",
      headers: cookie(token),
    });
    expect(res.statusCode).toBe(200);
    const body = ConsoleSessionInfo.parse(res.json());
    expect(body.scopes).toEqual(["admin"]);
    expect(body.tenant).toEqual({ id: tenantId, name: "Console Session Tenant" });
    // ~30-day sliding TTL (solo mode): expiresAt is far in the future.
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );

    const bare = await app.inject({ method: "GET", url: "/console/session" });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error.code).toBe("unauthorized");
  });

  it("cookie-authed mutation without X-Console-Csrf → 403; with it → passes (§4.5)", async () => {
    const token = await signIn(app, adminKey);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/v1/vaults",
      headers: {
        ...cookie(token),
        "idempotency-key": "cs-csrf-missing",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "no-csrf-vault" }),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("forbidden");

    const withCsrf = await app.inject({
      method: "POST",
      url: "/v1/vaults",
      headers: {
        ...cookie(token),
        "x-console-csrf": "1",
        "idempotency-key": "cs-csrf-present",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "csrf-vault" }),
    });
    expect(withCsrf.statusCode).toBe(201);
  });

  it("bearer-authed mutations stay CSRF-exempt (§4.5)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vaults",
      headers: {
        authorization: `Bearer ${adminKey}`,
        "idempotency-key": "cs-bearer-exempt",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "bearer-vault" }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("bearer wins when both cookie and bearer are present (§4.3)", async () => {
    // Cookie for tenant A + bearer for tenant B → the bearer's tenant answers.
    const token = await signIn(app, adminKey);
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { ...cookie(token), authorization: `Bearer ${otherAdminKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tenantId).toBe(otherTenantId);

    // An INVALID bearer is a 401 even alongside a valid cookie: bearer wins.
    const badBearer = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { ...cookie(token), authorization: "Bearer pmb_live_garbage" },
    });
    expect(badBearer.statusCode).toBe(401);
  });

  it("ANY present Authorization header wins — non-Bearer schemes never fall through to the cookie (§4.3)", async () => {
    const token = await signIn(app, adminKey);
    // "Basic ..." alongside a valid cookie must be a 401, not the cookie identity.
    const basic = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { ...cookie(token), authorization: "Basic xyz" },
    });
    expect(basic.statusCode).toBe(401);
    expect(basic.json().error.code).toBe("unauthorized");

    // The scheme is matched case-sensitively (the pre-cookie convention:
    // `Bearer `, never `bearer `) — so even a VALID key under a lowercase
    // scheme is a 401 and must not silently authenticate as the cookie.
    const lowercase = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: { ...cookie(token), authorization: `bearer ${adminKey}` },
    });
    expect(lowercase.statusCode).toBe(401);
    expect(lowercase.json().error.code).toBe("unauthorized");
  });

  it("POST /console/session with a query string is still public (pathname match)", async () => {
    // The auth allowlist matches on the pathname, not the raw URL — a
    // sign-in like `?redirect=1` must not 401 (and, being public, must not
    // 403 on CSRF either).
    const res = await app.inject({
      method: "POST",
      url: "/console/session?redirect=1",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ apiKey: adminKey }),
    });
    expect(res.statusCode).toBe(201);
    const setCookie = res.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(header).toMatch(/^pi_console_session=/);
  });

  it("revoked key → next cookie use 401 (§4.6)", async () => {
    const issued = await issueApiKey(
      pool,
      { tenantId },
      { name: "to-revoke", scopes: ["read"] },
    );
    const token = await signIn(app, issued.key);
    // Session works before revocation…
    const before = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(before.statusCode).toBe(200);
    // …revoke the underlying key over the wire (admin bearer)…
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/api-keys/${issued.id}`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(revoke.statusCode).toBe(204);
    // …and the console session dies with it on next use.
    const after = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it("sliding TTL: use re-extends expires_at (§4.6)", async () => {
    const token = await signIn(app, adminKey);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    // Age the session artificially, then use it: the first resolution of a
    // fresh token always bumps (the ~1/min throttle has no record for it).
    await query(
      pool,
      `UPDATE console_sessions SET expires_at = now() + interval '1 hour'
        WHERE token_hash = $1`,
      [tokenHash],
    );
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await query<{ expires_at: Date }>(
      pool,
      `SELECT expires_at FROM console_sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    expect(rows[0].expires_at.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
  });

  it("expired session → 401 even before the sweep deletes the row", async () => {
    const token = await signIn(app, adminKey);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await query(
      pool,
      `UPDATE console_sessions SET expires_at = now() - interval '1 second'
        WHERE token_hash = $1`,
      [tokenHash],
    );
    const res = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(res.statusCode).toBe(401);
  });

  it("sign-in sweeps expired rows out of console_sessions (§4.7)", async () => {
    const token = await signIn(app, adminKey);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await query(
      pool,
      `UPDATE console_sessions SET expires_at = now() - interval '1 second'
        WHERE token_hash = $1`,
      [tokenHash],
    );
    // A new sign-in runs the opportunistic sweep: the expired row must be
    // GONE from the table, not merely rejected on resolution.
    await signIn(app, adminKey);
    const { rows } = await query(
      pool,
      `SELECT 1 FROM console_sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    expect(rows).toHaveLength(0);
  });

  it("DELETE /console/session: sign-out clears the cookie and invalidates server-side (§4.4)", async () => {
    const token = await signIn(app, adminKey);
    // Sign-out is itself a cookie-authed mutation → CSRF header required (§4.5).
    const noCsrf = await app.inject({
      method: "DELETE",
      url: "/console/session",
      headers: cookie(token),
    });
    expect(noCsrf.statusCode).toBe(403);

    const res = await app.inject({
      method: "DELETE",
      url: "/console/session",
      headers: { ...cookie(token), "x-console-csrf": "1" },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers["set-cookie"];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(header).toContain(`${COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    // The destroyed session no longer authenticates anything.
    const after = await app.inject({
      method: "GET",
      url: "/v1/tenant",
      headers: cookie(token),
    });
    expect(after.statusCode).toBe(401);
  });
});
