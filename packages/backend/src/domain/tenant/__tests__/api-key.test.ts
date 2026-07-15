/**
 * Tenant + API-key domain tests (WP-P0.4, §29.1 verify).
 *
 * Covers the done-criteria at the domain layer:
 * - issue→verify round-trip resolves to the issuing tenant's ctx;
 * - the raw key is never stored (only the argon2id hash) and is absent from
 *   list responses (serialization test);
 * - revoke stops auth;
 * - cross-tenant negative: key A cannot resolve to / act on tenant B;
 * - getTenant returns the right tenant; implicit tenant auto-creates (§7.1).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant, getTenant, getOrCreateImplicitTenant } from "../tenant.js";
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "../api-key.js";

describe("tenant + api-key domain", () => {
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

  it("issue→verify round-trip resolves to the issuing tenant ctx", async () => {
    const t = await createTenant(pool, { name: "Acme" });
    const ctx: TenantCtx = { tenantId: t.id };
    const issued = await issueApiKey(pool, ctx, { name: "ci-key" });

    expect(issued.key).toMatch(/^pmb_live_/);
    expect(issued.id).toMatch(/^apikey_/);
    expect(issued.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const resolved = await verifyApiKey(pool, issued.key);
    // verifyApiKey now threads the key's scopes into the ctx (R0.1); a key
    // issued without explicit scopes defaults to `["admin"]` (backward-compat
    // for internal callers, see `issueApiKey`).
    expect(resolved).toEqual({ tenantId: t.id, scopes: ["admin"] });
  });

  it("raw key is never stored; only the argon2id hash is persisted", async () => {
    const t = await createTenant(pool, { name: "Secrets Inc" });
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k1" });

    const { rows } = await query<{ key_hash: string }>(
      pool,
      "SELECT key_hash FROM api_keys WHERE id = $1",
      [issued.id],
    );
    expect(rows[0].key_hash.startsWith("$argon2")).toBe(true);
    expect(rows[0].key_hash).not.toContain(issued.key);
    // The raw secret must not appear anywhere in the stored hash.
    const secret = issued.key.split("_").pop();
    expect(secret).toBeTruthy();
    expect(rows[0].key_hash).not.toContain(secret!);
  });

  it("list response never includes the raw key (serialization test)", async () => {
    const t = await createTenant(pool, { name: "List Co" });
    const ctx: TenantCtx = { tenantId: t.id };
    const issued = await issueApiKey(pool, ctx, { name: "listed", scopes: ["read"] });

    const list = await listApiKeys(pool, ctx);
    expect(list).toHaveLength(1);
    const item = list[0];
    expect(item.id).toBe(issued.id);
    expect(item.name).toBe("listed");
    expect(item.scopes).toEqual(["read"]);
    // The raw key must not be present on the serialized resource.
    expect((item as Record<string, unknown>)["key"]).toBeUndefined();
    expect((item as Record<string, unknown>)["key_hash"]).toBeUndefined();
    // And the raw key string must not appear anywhere in the JSON serialization.
    expect(JSON.stringify(list)).not.toContain(issued.key);
  });

  it("revoke stops authentication", async () => {
    const t = await createTenant(pool, { name: "Rev Corp" });
    const ctx: TenantCtx = { tenantId: t.id };
    const issued = await issueApiKey(pool, ctx, { name: "to-revoke" });

    expect(await verifyApiKey(pool, issued.key)).not.toBeNull();

    const ok = await revokeApiKey(pool, ctx, issued.id);
    expect(ok).toBe(true);

    expect(await verifyApiKey(pool, issued.key)).toBeNull();
  });

  it("revoke returns false for an already-revoked key", async () => {
    const t = await createTenant(pool, { name: "Rev2" });
    const ctx: TenantCtx = { tenantId: t.id };
    const issued = await issueApiKey(pool, ctx, { name: "double" });
    expect(await revokeApiKey(pool, ctx, issued.id)).toBe(true);
    expect(await revokeApiKey(pool, ctx, issued.id)).toBe(false);
  });

  it("cross-tenant: key A cannot resolve to or act on tenant B", async () => {
    const ta = await createTenant(pool, { name: "Tenant A" });
    const tb = await createTenant(pool, { name: "Tenant B" });
    const issued = await issueApiKey(pool, { tenantId: ta.id }, { name: "a-key" });

    // verifyApiKey resolves to A, never B.
    const resolved = await verifyApiKey(pool, issued.key);
    expect(resolved?.tenantId).toBe(ta.id);
    expect(resolved?.tenantId).not.toBe(tb.id);

    // Revoking under tenant B's ctx returns false (row not visible to B).
    const ok = await revokeApiKey(pool, { tenantId: tb.id }, issued.id);
    expect(ok).toBe(false);

    // The key still authenticates (B's failed revoke had no effect).
    expect(await verifyApiKey(pool, issued.key)).not.toBeNull();

    // B cannot list A's keys.
    const bList = await listApiKeys(pool, { tenantId: tb.id });
    expect(bList.map((k) => k.id)).not.toContain(issued.id);
  });

  it("verifyApiKey rejects malformed keys", async () => {
    expect(await verifyApiKey(pool, "not-a-key")).toBeNull();
    expect(await verifyApiKey(pool, "pmb_live_short")).toBeNull();
    expect(await verifyApiKey(pool, "Bearer pmb_live_garbage")).toBeNull();
  });

  it("getTenant returns the right tenant; implicit tenant auto-creates (§7.1)", async () => {
    const t = await createTenant(pool, { name: "Lookup", quotaPlan: "pro" });
    const got = await getTenant(pool, t.id);
    expect(got?.id).toBe(t.id);
    expect(got?.name).toBe("Lookup");
    expect(got?.quotaPlan).toBe("pro");

    // Implicit tenant is idempotent.
    const impl1 = await getOrCreateImplicitTenant(pool);
    const impl2 = await getOrCreateImplicitTenant(pool);
    expect(impl1.id).toBe("tnt_implicit");
    expect(impl2.id).toBe("tnt_implicit");
    expect(await getTenant(pool, "tnt_implicit")).not.toBeNull();
  });
});
