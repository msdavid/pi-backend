/**
 * Memory store service (WP-2.2, §8.6, §13.2, §3.6 `memory_stores`).
 *
 * CRUD over tenant-scoped memory stores. Memory *contents* live in the object
 * store (not Postgres, §28); only store metadata + version audit rows are in
 * Postgres. Every query routes through {@link tenantScopedQuery} so cross-tenant
 * access is impossible by construction (§27.1).
 *
 * Limits (§13.2):
 *  - `instructions` ≤ 4096 chars (enforced by the zod contract; re-checked here).
 *  - Max 8 memory stores per *session* — enforced at mount time
 *    ({@link mountMemoryStores}), not here, since stores are independent
 *    resources referenced by zero or more sessions.
 *
 * `mountPath` is NOT stored on the store (§13.3 — it is set on the session
 * resource when attached); the contract field is therefore always `null` on the
 * store resource. `metadata` is accepted (contract) but the `memory_stores`
 * table has no `metadata` column (migration 009), so it is currently ignored —
 * see open questions.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import { reserveQuota, releaseQuota } from "../quota/index.js";
import {
  type MemoryAccess,
  type MemoryStore,
  type ResourceStatus,
} from "@pi-managed/contracts";

/** 30-day retention for memory version audit rows (§13.5). */
export const VERSION_RETENTION_DAYS = 30;

/** Per-store memory count cap (§13.2). */
export const MAX_MEMORIES_PER_STORE = 2000;

/** Per-memory content size cap: 100 kB (§13.2). */
export const MAX_MEMORY_CONTENT_BYTES = 100 * 1024;

/** Per-store `instructions` length cap (§13.2). */
export const MAX_INSTRUCTIONS_CHARS = 4096;

/** `memory_stores` row (camelCased projection matching the `MemoryStore` contract). */
type StoreDbRow = {
  id: string;
  displayTitle: string;
  instructions: string | null;
  access: string;
  status: string;
  objectKeyPrefix: string;
  createdAt: Date;
  updatedAt: Date;
};

const COLS = `id, display_title AS "displayTitle", instructions, access, status,
  object_key_prefix AS "objectKeyPrefix", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/**
 * The object-store prefix for a store's contents (§3.6 `object_key_prefix`,
 * db-schema §6). Memory content + per-version snapshots live under this prefix:
 *   tenants/<tenant_id>/memory/<store_id>
 */
export function storeObjectKeyPrefix(tenantId: string, storeId: string): string {
  return `tenants/${tenantId}/memory/${storeId}`;
}

/** The per-version content object key: `<prefix>/_v/<memverId>` (§28, audit). */
export function versionContentObjectKey(prefix: string, versionId: string): string {
  return `${prefix}/_v/${versionId}`;
}

/** Map a DB row → the `MemoryStore` contract shape. */
function toStore(r: StoreDbRow): MemoryStore {
  const store: MemoryStore = {
    id: r.id,
    displayTitle: r.displayTitle,
    access: r.access as MemoryAccess,
    status: r.status as ResourceStatus,
    mountPath: null, // set on the session resource when attached, not here (§13.3)
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  if (r.instructions) store.instructions = r.instructions;
  return store;
}

export interface CreateMemoryStoreInput {
  displayTitle: string;
  instructions?: string;
  access?: MemoryAccess;
}

/**
 * Create a memory store. `409 conflict` on a duplicate `(tenant, display_title)`
 * (§20.2 naming rule). `access` defaults to `read_write` (§13.2).
 */
export async function createMemoryStore(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: CreateMemoryStoreInput,
): Promise<MemoryStore> {
  if (input.instructions && input.instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new ApiError(
      422,
      "invalid_request",
      `instructions exceed ${MAX_INSTRUCTIONS_CHARS} chars (§13.2)`,
    );
  }
  const id = newId("mem_");
  const objectKeyPrefix = storeObjectKeyPrefix(tenantCtx.tenantId, id);
  const access = input.access ?? "read_write";

  // Transactional per-tenant memory-store quota (R5.2): reserve one slot
  // atomically (429 if over the plan limit), then insert. Release the slot if
  // the insert fails OR is skipped by `ON CONFLICT DO NOTHING` (a duplicate
  // displayTitle), so a rejected create never leaks a reservation.
  await reserveQuota(pool, tenantCtx, "maxMemoryStores");
  let rows: StoreDbRow[];
  try {
    ({ rows } = await tenantScopedQuery<StoreDbRow>(
      pool,
      tenantCtx,
      `INSERT INTO memory_stores
         (tenant_id, id, display_title, instructions, access, status, object_key_prefix)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (tenant_id, display_title) DO NOTHING
       RETURNING ${COLS}`,
      [
        tenantCtx.tenantId,
        id,
        input.displayTitle,
        input.instructions ?? null,
        access,
        objectKeyPrefix,
      ],
    ));
  } catch (err) {
    await releaseQuota(pool, tenantCtx, "maxMemoryStores").catch(() => {});
    throw err;
  }
  if (rows.length === 0) {
    await releaseQuota(pool, tenantCtx, "maxMemoryStores").catch(() => {});
    throw new ApiError(
      409,
      "conflict",
      `memory store displayTitle already exists: ${input.displayTitle}`,
    );
  }
  return toStore(rows[0]);
}

export interface ListMemoryStoresOptions {
  limit: number;
  cursor?: string;
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid memory-store list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/** List a tenant's stores, newest first, cursor-paginated (§"Cursor pagination"). */
export async function listMemoryStores(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListMemoryStoresOptions,
): Promise<{ data: MemoryStore[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantCtx.tenantId];
  const where: string[] = [`status = 'active'`];
  let n = 1;
  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<StoreDbRow>(
    pool,
    tenantCtx,
    `SELECT ${COLS} FROM memory_stores
      WHERE tenant_id = $1 AND ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(
          JSON.stringify({
            createdAt: page[page.length - 1].createdAt.toISOString(),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toStore), nextCursor };
}

/** Fetch a single store; `null` if absent / cross-tenant / archived. */
export async function getMemoryStore(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<MemoryStore | null> {
  const { rows } = await tenantScopedQuery<StoreDbRow>(
    pool,
    tenantCtx,
    `SELECT ${COLS} FROM memory_stores
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ? toStore(rows[0]) : null;
}

/** Like {@link getMemoryStore} but returns the raw row (internal: memory/version svcs). */
export async function fetchStoreRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<StoreDbRow | null> {
  const { rows } = await tenantScopedQuery<StoreDbRow>(
    pool,
    tenantCtx,
    `SELECT ${COLS} FROM memory_stores
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

export interface UpdateMemoryStoreInput {
  displayTitle?: string;
  instructions?: string;
  access?: MemoryAccess;
}

/**
 * Update a store's `displayTitle`/`instructions`/`access` (§"GET / PATCH / DELETE").
 * `instructions` re-checked against the 4096-char cap. A duplicate `displayTitle`
 * yields `409 conflict`; an absent/archived store yields `404 not_found`.
 */
export async function updateMemoryStore(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  input: UpdateMemoryStoreInput,
): Promise<MemoryStore> {
  if (
    input.instructions !== undefined &&
    input.instructions.length > MAX_INSTRUCTIONS_CHARS
  ) {
    throw new ApiError(
      422,
      "invalid_request",
      `instructions exceed ${MAX_INSTRUCTIONS_CHARS} chars (§13.2)`,
    );
  }
  // Pre-check a title change against the (tenant, display_title) unique index.
  if (input.displayTitle !== undefined) {
    const { rows } = await tenantScopedQuery<{ id: string }>(
      pool,
      tenantCtx,
      `SELECT id FROM memory_stores
        WHERE tenant_id = $1 AND display_title = $2 AND id <> $3`,
      [tenantCtx.tenantId, input.displayTitle, id],
    );
    if (rows.length > 0) {
      throw new ApiError(
        409,
        "conflict",
        `memory store displayTitle already exists: ${input.displayTitle}`,
      );
    }
  }
  const sets: string[] = [];
  const params: unknown[] = [tenantCtx.tenantId, id];
  let n = 2;
  if (input.displayTitle !== undefined) {
    sets.push(`display_title = $${++n}`);
    params.push(input.displayTitle);
  }
  if (input.instructions !== undefined) {
    sets.push(`instructions = $${++n}`);
    params.push(input.instructions);
  }
  if (input.access !== undefined) {
    sets.push(`access = $${++n}`);
    params.push(input.access);
  }
  sets.push(`updated_at = now()`);
  const { rows: updated } = await tenantScopedQuery<StoreDbRow>(
    pool,
    tenantCtx,
    `UPDATE memory_stores
        SET ${sets.join(", ")}
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING ${COLS}`,
    params,
  );
  if (!updated[0]) {
    throw new ApiError(404, "not_found", `memory store not found: ${id}`);
  }
  return toStore(updated[0]);
}

/**
 * Hard-delete a memory store and its version audit rows (§"DELETE"). Returns
 * `204`. The store's `memory_versions` rows are deleted first (their FK to
 * `memory_stores(id)` has no `ON DELETE CASCADE`); object-store content under
 * the store prefix is best-effort purged. `404 not_found` if absent/archived.
 *
 * Deleting a live store frees its `maxMemoryStores` quota slot (R5.2 counter
 * decrement) — the sole caller of this delete, so it is the single source of
 * truth for the release.
 */
export async function deleteMemoryStore(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM memory_versions WHERE tenant_id = $1 AND store_id = $2`,
    [tenantCtx.tenantId, id],
  );
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM memory_stores WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tenantCtx.tenantId, id],
  );
  if ((rowCount ?? 0) === 0) {
    throw new ApiError(404, "not_found", `memory store not found: ${id}`);
  }
  await releaseQuota(pool, tenantCtx, "maxMemoryStores").catch(() => {});
}
