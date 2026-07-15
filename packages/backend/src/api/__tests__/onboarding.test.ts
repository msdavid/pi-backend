/**
 * Onboarding API (HTTP-level, WP-5.2, §29.6 / §24.3 verify).
 *
 * Exercises the public `POST /v1/onboarding/signup` route against a real
 * Postgres testcontainer via the full `createApp` stack:
 * - sign-up creates a tenant + admin key + returns the install instructions;
 * - idempotent on `adminEmail` (no duplicate tenant; a fresh key each call);
 * - `onboarding.enabled = false` → `403 forbidden`.
 *
 * Auth bypass: the route is in `PUBLIC_PATHS`, so no Bearer key is required.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
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
import { verifyApiKey } from "../../domain/tenant/api-key.js";

describe("onboarding API (HTTP)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function makeApp(onboardingEnabled: boolean): Promise<FastifyInstance> {
    const config = loadConfig({ env: { LOG_LEVEL: "error", ONBOARDING_ENABLED: String(onboardingEnabled) } });
    return createApp({ config, logger: pino({ level: "error" }), pool });
  }

  function body(email: string, tenantName = "Acme") {
    return JSON.stringify({ tenantName, adminEmail: email, backendUrl: "https://api.example" });
  }

  it("sign-up creates a tenant + admin key + returns install instructions", async () => {
    app = await makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: { "content-type": "application/json" },
      payload: body("onboard@example.com"),
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.tenantId).toMatch(/^tnt_/);
    expect(json.apiKey.key).toMatch(/^pmb_live_/);
    expect(json.apiKey.id).toMatch(/^apikey_/);
    expect(json.installCommand).toBe("pi install npm:@pi-managed/client");
    expect(json.extensionConfig).toEqual({
      backendUrl: "https://api.example",
      apiKeyRef: "pi-managed-backend",
    });
    expect(json.backendUrl).toBe("https://api.example");

    // The issued key authenticates and resolves to the new tenant with the
    // admin scope (the signup bootstrap key is minted as `["admin"]`).
    const ctx = await verifyApiKey(pool, json.apiKey.key);
    expect(ctx).toEqual({ tenantId: json.tenantId, scopes: ["admin"] });

    // The raw key is never stored — only the argon2id hash.
    const { rows } = await query<{ key_hash: string }>(
      pool,
      "SELECT key_hash FROM api_keys WHERE id = $1",
      [json.apiKey.id],
    );
    expect(rows[0].key_hash.startsWith("$argon2")).toBe(true);
    expect(rows[0].key_hash).not.toContain(json.apiKey.key);
  });

  it("is idempotent on adminEmail (no duplicate tenant; no key re-issued — R0.3)", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: { "content-type": "application/json" },
      payload: body("idem@example.com", "Idem Co"),
    });
    expect(res1.statusCode).toBe(201);
    const j1 = res1.json();

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: { "content-type": "application/json" },
      payload: body("idem@example.com", "Idem Co 2"),
    });
    expect(res2.statusCode).toBe(201);
    const j2 = res2.json();

    // Same tenant; no duplicate created.
    expect(j2.tenantId).toBe(j1.tenantId);
    const { rows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM tenants WHERE id = $1",
      [j1.tenantId],
    );
    expect(rows[0].count).toBe("1");
    const { rows: signupRows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM onboarding_signups WHERE admin_email = $1",
      ["idem@example.com"],
    );
    expect(signupRows[0].count).toBe("1");

    // The repeat sign-up issues NO credential (R0.3): re-issuing an admin key
    // to an unauthenticated caller who merely knows a registered adminEmail
    // would be a tenant takeover. The response shape is otherwise identical.
    expect(j2.apiKey).toBeUndefined();
    expect(j2.backendUrl).toBe(j1.backendUrl);
    expect(j2.installCommand).toBe(j1.installCommand);
    expect(j2.extensionConfig).toEqual(j1.extensionConfig);

    // Exactly one API key exists for the tenant — nothing was re-minted.
    const { rows: keyRows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM api_keys WHERE tenant_id = $1",
      [j1.tenantId],
    );
    expect(keyRows[0].count).toBe("1");

    // The original key is still valid and resolves to the tenant as admin.
    expect(await verifyApiKey(pool, j1.apiKey.key)).toEqual({
      tenantId: j1.tenantId,
      scopes: ["admin"],
    });
  });

  it("returns 422 on an invalid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ tenantName: "", adminEmail: "not-an-email" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("requires no Bearer auth (public route)", async () => {
    // An explicit (bogus) Authorization header must not block sign-up: the
    // route is on the PUBLIC_PATHS allowlist and bypasses auth entirely.
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bogus",
      },
      payload: body("public@example.com"),
    });
    expect(res.statusCode).toBe(201);
  });

  it("returns 403 when onboarding is disabled", async () => {
    await app.close();
    app = await makeApp(false);
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/signup",
      headers: { "content-type": "application/json" },
      payload: body("disabled@example.com"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });
});
