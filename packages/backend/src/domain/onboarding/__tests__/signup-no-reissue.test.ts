/**
 * Onboarding no-re-issuance regression (R0.3 — unauthenticated takeover fix).
 *
 * `POST /v1/onboarding/signup` is public and idempotent on `adminEmail`. The
 * fix: a repeat sign-up for an already-registered email reuses the tenant but
 * issues **no** credential — otherwise anyone who knows a tenant's admin email
 * could re-issue themselves an admin key and take the tenant over.
 *
 * This drives the production `signup()` service against a real Postgres
 * testcontainer and asserts:
 * - the first sign-up returns a usable `apiKey`;
 * - a second sign-up (same email) returns `apiKey === undefined`;
 * - the `api_keys` row count for that tenant stays at 1 (no key was minted).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { signup } from "../signup.js";

describe("onboarding signup — no key re-issuance (R0.3)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("issues a key on first sign-up but not on a repeat for the same email", async () => {
    const input = {
      tenantName: "Takeover Co",
      adminEmail: "owner@example.com",
      backendUrl: "https://api.example",
    };

    // First sign-up: fresh tenant + a usable admin key (shown once).
    const first = await signup(pool, input);
    expect(first.apiKey).toBeDefined();
    expect(first.apiKey?.key).toMatch(/^pmb_live_/);

    // Second sign-up, same email: reuses the tenant, issues NO credential.
    const second = await signup(pool, input);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.apiKey).toBeUndefined();

    // Non-secret fields are identical — the response never leaks that the email
    // already existed.
    expect(second.backendUrl).toBe(first.backendUrl);
    expect(second.installCommand).toBe(first.installCommand);
    expect(second.extensionConfig).toEqual(first.extensionConfig);

    // Exactly one API key exists for the tenant — nothing was re-minted.
    const { rows } = await query<{ count: string }>(
      pool,
      "SELECT count(*)::text AS count FROM api_keys WHERE tenant_id = $1",
      [first.tenantId],
    );
    expect(rows[0].count).toBe("1");
  });
});
