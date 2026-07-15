/**
 * `tenantScoped` helper tests (WP-P0.2, §29.1 verify).
 *
 * - Compile-time: the helper cannot be called without a {@link TenantCtx}
 *   (verified via `@ts-expect-error`).
 * - Runtime negative: an unscoped query (no `tenant_id` reference) throws, and a
 *   query that names the column but omits the binding value throws.
 * - Cross-tenant read: inserting two tenants' rows and querying with tenant A's
 *   context returns only A's rows (tenant B's rows are absent) — §27.1, §29.1.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPool,
  closePool,
  query,
  tenantScopedQuery,
  tenantScopedAll,
  TenantScopeError,
  type Pool,
  type TenantCtx,
} from "../index.js";
import { runMigrations } from "../migrate.js";
import { startPostgres, type TestDb } from "./test-runtime.js";

// ---------------------------------------------------------------------------
// Compile-time guard (§29.1)
// ---------------------------------------------------------------------------

// Calling tenantScopedQuery without a TenantCtx (2nd arg) must NOT typecheck.
// `@ts-expect-error` fails the build if this line ever becomes assignable.
// (Type-level only — not executed at runtime to avoid an unhandled rejection.)
// @ts-expect-error — 2nd arg must be TenantCtx ({tenantId:string}), not a bare string.
 
const _compileTimeGuard: Promise<unknown> = tenantScopedQuery(
  null as unknown as Pool,
  "tnt_compiletime",
  "SELECT * FROM agents",
);
// Swallow the intentional rejection so it doesn't surface as an unhandled rejection.
_compileTimeGuard.catch(() => {});

// ---------------------------------------------------------------------------
// Runtime tests
// ---------------------------------------------------------------------------

describe("tenantScoped", () => {
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

  it("rejects an unscoped query (SQL without tenant_id)", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_a" };
    await expect(
      tenantScopedQuery(pool, tenantCtx, "SELECT * FROM agents", []),
    ).rejects.toBeInstanceOf(TenantScopeError);

    await expect(
      tenantScopedQuery(pool, tenantCtx, "SELECT name FROM agents WHERE status = $1", ["active"]),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("rejects a query that references tenant_id but omits the binding value", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_a" };
    // Names the column but never binds the tenant id.
    await expect(
      tenantScopedQuery(
        pool,
        tenantCtx,
        "SELECT * FROM agents WHERE tenant_id = $1 AND status = $2",
        ["active"],
      ),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it("executes a properly scoped query", async () => {
    const tenantCtx: TenantCtx = { tenantId: "tnt_ok" };
    await query(pool, "INSERT INTO tenants (id, name) VALUES ($1, 'OK')", [tenantCtx.tenantId]);
    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantCtx.tenantId,
      "agent_ok_1",
      "ok-agent",
    ]);
    const { rows } = await tenantScopedQuery<{ name: string }>(
      pool,
      tenantCtx,
      "SELECT name FROM agents WHERE tenant_id = $1",
      [tenantCtx.tenantId],
    );
    expect(rows.map((r) => r.name)).toEqual(["ok-agent"]);
  });

  it("returns only the calling tenant's rows (cross-tenant read is empty)", async () => {
    const tenantA: TenantCtx = { tenantId: "tnt_a" };
    const tenantB: TenantCtx = { tenantId: "tnt_b" };

    await query(pool, "INSERT INTO tenants (id, name) VALUES ($1, 'A')", [tenantA.tenantId]);
    await query(pool, "INSERT INTO tenants (id, name) VALUES ($1, 'B')", [tenantB.tenantId]);

    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantA.tenantId,
      "agent_a_1",
      "a-agent-1",
    ]);
    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantA.tenantId,
      "agent_a_2",
      "a-agent-2",
    ]);
    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantB.tenantId,
      "agent_b_1",
      "b-agent-1",
    ]);
    await query(pool, "INSERT INTO agents (tenant_id, id, name) VALUES ($1, $2, $3)", [
      tenantB.tenantId,
      "agent_b_2",
      "b-agent-2",
    ]);

    // tenantScopedAll with tenant A's context returns ONLY A's two agents.
    const aRows = await tenantScopedAll<{ name: string }>(pool, tenantA, "agents");
    expect(aRows.map((r) => r.name).sort()).toEqual(["a-agent-1", "a-agent-2"]);

    // tenantScopedQuery with tenant A's context returns only A's rows.
    const { rows: aRows2 } = await tenantScopedQuery<{ name: string }>(
      pool,
      tenantA,
      "SELECT name FROM agents WHERE tenant_id = $1 ORDER BY name",
      [tenantA.tenantId],
    );
    expect(aRows2.map((r) => r.name)).toEqual(["a-agent-1", "a-agent-2"]);

    // And tenant B's rows are NOT visible under tenant A's context.
    const aNames = new Set(aRows.map((r) => r.name));
    expect(aNames.has("b-agent-1")).toBe(false);
    expect(aNames.has("b-agent-2")).toBe(false);

    // Sanity: tenant B sees its own.
    const bRows = await tenantScopedAll<{ name: string }>(pool, tenantB, "agents");
    expect(bRows.map((r) => r.name).sort()).toEqual(["b-agent-1", "b-agent-2"]);
  });
});
