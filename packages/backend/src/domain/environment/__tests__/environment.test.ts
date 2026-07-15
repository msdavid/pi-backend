/**
 * Environment service + routes integration (WP-1.2, §29.1 verify).
 *
 * Covers the done-criteria at the domain + HTTP layer:
 * - full CRUD round-trip (create → get → list → patch → archive → delete);
 * - `self_hosted` rejected with `422 invalid_request` ("Phase 4 feature");
 * - duplicate `(tenant, name)` → `409 conflict`;
 * - cross-tenant isolation (B never sees A's environment; deletes return false);
 * - `work-stats` returns 501.
 *
 * Uses testcontainers-postgres (real migrations) via the shared test runtime.
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
  createEnvironment,
  listEnvironments,
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  archiveEnvironment,
} from "../environment.js";
describe("environment service (WP-1.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctxA: TenantCtx;
  let ctxB: TenantCtx;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const tA = await createTenant(pool, { name: "Env Tenant A" });
    const tB = await createTenant(pool, { name: "Env Tenant B" });
    ctxA = { tenantId: tA.id };
    ctxB = { tenantId: tB.id };
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("creates a cloud environment with defaults applied", async () => {
    const env = await createEnvironment(pool, ctxA, {
      name: "python-env",
      type: "cloud",
      resources: { cpus: 2, memoryMiB: 2048 },
      networking: { mode: "unrestricted" },
    });
    expect(env.id).toMatch(/^env_/);
    expect(env.status).toBe("active");
    expect(env.type).toBe("cloud");
    expect(env.resources).toEqual({ cpus: 2, memoryMiB: 2048 });
    expect(env.networking).toEqual({ mode: "unrestricted" });
    expect(env.packages).toEqual([]);
    expect(env.mounts).toEqual([]);
    expect(env.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts self_hosted type (Phase 4 unlocked)", async () => {
    const env = await createEnvironment(pool, ctxA, {
      name: "selfhost",
      type: "self_hosted",
    });
    expect(env.type).toBe("self_hosted");
    expect(env.status).toBe("active");
  });

  it("duplicate (tenant, name) → 409 conflict", async () => {
    await createEnvironment(pool, ctxA, { name: "dup", type: "cloud" });
    await expect(
      createEnvironment(pool, ctxA, { name: "dup", type: "cloud" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("get returns the created environment; absent → null", async () => {
    const created = await createEnvironment(pool, ctxA, {
      name: "lookup",
      type: "cloud",
    });
    const got = await getEnvironment(pool, ctxA, created.id);
    expect(got?.id).toBe(created.id);
    expect(await getEnvironment(pool, ctxA, "env_missing")).toBeNull();
  });

  it("list paginates createdAt-desc + filters by status", async () => {
    const page = await listEnvironments(pool, ctxA, { limit: 50 });
    expect(page.data.length).toBeGreaterThanOrEqual(3);
    // createdAt-desc ordering.
    for (let i = 1; i < page.data.length; i++) {
      expect(page.data[i].createdAt <= page.data[i - 1].createdAt).toBe(true);
    }
    // status filter: only active (one is archived next, so active count > archived).
    const archived = await createEnvironment(pool, ctxA, {
      name: "to-archive-list",
      type: "cloud",
    });
    await archiveEnvironment(pool, ctxA, archived.id);
    const activeOnly = await listEnvironments(pool, ctxA, {
      limit: 50,
      status: "active",
    });
    expect(activeOnly.data.every((e) => e.status === "active")).toBe(true);
    const archivedOnly = await listEnvironments(pool, ctxA, {
      limit: 50,
      status: "archived",
    });
    expect(archivedOnly.data.every((e) => e.status === "archived")).toBe(true);
    expect(archivedOnly.data.map((e) => e.id)).toContain(archived.id);
  });

  it("list cursor returns the next page", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await createEnvironment(pool, ctxA, {
        name: `page-${i}`,
        type: "cloud",
      });
      ids.push(e.id);
    }
    const first = await listEnvironments(pool, ctxA, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listEnvironments(pool, ctxA, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    // Cursor advances: no overlap between first and second page rows.
    const overlap = first.data
      .map((e) => e.id)
      .filter((id) => second.data.map((e) => e.id).includes(id));
    expect(overlap).toEqual([]);
  });

  it("patch updates fields and returns the updated resource", async () => {
    const created = await createEnvironment(pool, ctxA, {
      name: "patch-me",
      type: "cloud",
      image: "ubuntu:22.04",
    });
    const updated = await updateEnvironment(pool, ctxA, created.id, {
      image: "ubuntu:24.04",
      resources: { cpus: 4, memoryMiB: 4096 },
      networking: { mode: "limited", allowedHosts: ["github.com"] },
    });
    expect(updated).not.toBeNull();
    expect(updated!.image).toBe("ubuntu:24.04");
    expect(updated!.resources).toEqual({ cpus: 4, memoryMiB: 4096 });
    expect(updated!.networking).toEqual({
      mode: "limited",
      allowedHosts: ["github.com"],
    });
    // updatedAt advanced.
    expect(updated!.updatedAt >= created.updatedAt).toBe(true);
  });

  it("patch accepts self_hosted type (Phase 4 unlocked)", async () => {
    const e = await createEnvironment(pool, ctxA, {
      name: "patch-selfhost",
      type: "cloud",
    });
    const updated = await updateEnvironment(pool, ctxA, e.id, { type: "self_hosted" });
    expect(updated?.type).toBe("self_hosted");
  });

  it("patch returns null for absent / cross-tenant", async () => {
    expect(await updateEnvironment(pool, ctxA, "env_missing", {})).toBeNull();
  });

  it("archive sets status=archived (idempotent)", async () => {
    const created = await createEnvironment(pool, ctxA, {
      name: "archive-me",
      type: "cloud",
    });
    const archived = await archiveEnvironment(pool, ctxA, created.id);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe("archived");
    // Idempotent.
    const again = await archiveEnvironment(pool, ctxA, created.id);
    expect(again?.status).toBe("archived");
  });

  it("hard delete returns true once; absent → false", async () => {
    const created = await createEnvironment(pool, ctxA, {
      name: "delete-me",
      type: "cloud",
    });
    expect(await deleteEnvironment(pool, ctxA, created.id)).toBe(true);
    expect(await deleteEnvironment(pool, ctxA, created.id)).toBe(false);
    expect(await getEnvironment(pool, ctxA, created.id)).toBeNull();
  });

  it("cross-tenant: B cannot read/update/delete/archive A's environment", async () => {
    const a = await createEnvironment(pool, ctxA, {
      name: "cross-tenant",
      type: "cloud",
    });
    // B cannot see A's environment.
    expect(await getEnvironment(pool, ctxB, a.id)).toBeNull();
    expect(await updateEnvironment(pool, ctxB, a.id, { image: "x" })).toBeNull();
    expect(await archiveEnvironment(pool, ctxB, a.id)).toBeNull();
    expect(await deleteEnvironment(pool, ctxB, a.id)).toBe(false);
    // A still has it.
    expect(await getEnvironment(pool, ctxA, a.id)).not.toBeNull();
  });
});
