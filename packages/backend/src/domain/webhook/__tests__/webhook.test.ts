/**
 * Webhook service integration tests (WP-2.5, §23.3).
 *
 * Covers: register (returns `whsec_` secret once, hashed-at-rest), list/retrieve
 * (never return the secret), delete, and endpoint-URL validation. Uses
 * testcontainers-postgres with real migrations.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  EndpointValidationError,
} from "../webhook.js";

// Stable encryption key so the signing-secret round-trip is deterministic.
const TEST_KEY = "0".repeat(64); // 32 bytes hex

describe("webhook service (WP-2.5)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantCtx: TenantCtx;

  beforeAll(async () => {
    process.env.MSB_SECRET_ENCRYPTION_KEY = TEST_KEY;
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const tenant = await createTenant(pool, { name: "Webhook Tenant" });
    tenantCtx = { tenantId: tenant.id };
  }, 120_000);

  afterAll(async () => {
    await closePool(pool);
    await db.container.stop();
  });

  const VALID_URL = "https://hooks.example.com/pi-managed";
  const EVENT_TYPES = ["session.status_idle", "session.status_terminated", "job.run_failed"];

  it("registers a webhook and returns the signing secret once", async () => {
    const created = await createWebhook(pool, tenantCtx, {
      url: VALID_URL,
      eventTypes: EVENT_TYPES,
    });
    expect(created.id).toMatch(/^wh_/);
    expect(created.url).toBe(VALID_URL);
    expect(created.eventTypes).toEqual(EVENT_TYPES);
    expect(created.status).toBe("active");
    expect(created.signingSecret).toMatch(/^whsec_/);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
  });

  it("list and retrieve never expose the signing secret", async () => {
    const created = await createWebhook(pool, tenantCtx, {
      url: "https://hooks.example.com/another",
      eventTypes: ["session.status_idle"],
    });
    const listed = await listWebhooks(pool, tenantCtx);
    const found = listed.find((w) => w.id === created.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty("signingSecret");

    const got = await getWebhook(pool, tenantCtx, created.id);
    expect(got).toBeTruthy();
    expect(got!.id).toBe(created.id);
    expect(got).not.toHaveProperty("signingSecret");
  });

  it("returns null for a webhook in another tenant (no leakage)", async () => {
    const other = await createTenant(pool, { name: "Other Tenant" });
    const created = await createWebhook(pool, { tenantId: other.id }, {
      url: VALID_URL,
      eventTypes: ["session.status_idle"],
    });
    const got = await getWebhook(pool, tenantCtx, created.id);
    expect(got).toBeNull();
  });

  it("deletes a webhook (204 path); subsequent retrieve is null", async () => {
    const created = await createWebhook(pool, tenantCtx, {
      url: "https://hooks.example.com/gone",
      eventTypes: ["session.status_idle"],
    });
    expect(await deleteWebhook(pool, tenantCtx, created.id)).toBe(true);
    expect(await getWebhook(pool, tenantCtx, created.id)).toBeNull();
    // Deleting again returns false (404 path).
    expect(await deleteWebhook(pool, tenantCtx, created.id)).toBe(false);
  });

  it("rejects non-https endpoints", async () => {
    await expect(
      createWebhook(pool, tenantCtx, {
        url: "http://hooks.example.com/insecure",
        eventTypes: ["session.status_idle"],
      }),
    ).rejects.toBeInstanceOf(EndpointValidationError);
  });

  it("rejects endpoints not on port 443", async () => {
    await expect(
      createWebhook(pool, tenantCtx, {
        url: "https://hooks.example.com:8443/insecure",
        eventTypes: ["session.status_idle"],
      }),
    ).rejects.toBeInstanceOf(EndpointValidationError);
  });

  it("rejects empty eventTypes", async () => {
    await expect(
      createWebhook(pool, tenantCtx, {
        url: VALID_URL,
        eventTypes: [],
      }),
    ).rejects.toBeInstanceOf(EndpointValidationError);
  });
});
