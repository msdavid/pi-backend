/**
 * Memory service (WP-2.2, §13.2–13.4, §3.6).
 *
 * CRUD over individual memory entries within a store. A "memory" is identified
 * by its `path` within a store — there is NO `memories` table; a memory's live
 * state is *derived* from the immutable {@link memory_versions} rows
 * (§3.6/§13.5). The live head of `(store, path)` = the latest version whose
 * `content_object_key` is non-null:
 *
 *  - **create** inserts the first version; `409` if the path is already live.
 *  - **update** inserts a new head version; `404` if the path isn't live;
 *    `409` on a `contentSha256` precondition mismatch (§13.4 optimistic concurrency).
 *  - **delete** inserts a *tombstone* version (content_object_key NULL) — the
 *    memory is no longer live, but prior version rows survive (§13.5).
 *
 * Each version's content lives in the object store at `<prefix>/_v/<memverId>`
 * (unique per version, so {@link redact} can scrub a specific version's bytes).
 */

import { createHash } from "node:crypto";
import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import type { ObjectStore } from "../ports.js";
import type { Memory, MemorySummary, MemoryUpdate } from "@pi-managed/contracts";
import {
  fetchStoreRow,
  MAX_MEMORIES_PER_STORE,
  MAX_MEMORY_CONTENT_BYTES,
  versionContentObjectKey,
} from "./store.js";

/** `memory_versions` row (camelCased projection). */
type VersionDbRow = {
  id: string;
  storeId: string;
  memoryPath: string | null;
  contentSha256: string;
  contentObjectKey: string | null;
  redacted: boolean;
  createdAt: Date;
  expiresAt: Date | null;
};

const VERSION_COLS = `id, store_id AS "storeId", memory_path AS "memoryPath",
  content_sha256 AS "contentSha256", content_object_key AS "contentObjectKey",
  redacted, created_at AS "createdAt", expires_at AS "expiresAt"`;

/** SHA-256 hex of a UTF-8 string (the optimistic-concurrency hash, §13.4). */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Read an object-store key fully into a UTF-8 string; `null` if absent. */
async function readObjectText(store: ObjectStore, key: string): Promise<string | null> {
  try {
    const stream = await store.get(key);
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
  } catch {
    return null; // object absent (e.g. redacted or never written)
  }
}

/** Write a UTF-8 string to the object store at `key`. */
async function writeObjectText(store: ObjectStore, key: string, content: string): Promise<void> {
  const buf = Buffer.from(content, "utf8");
  await store.put(key, new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  }));
}

/**
 * The latest version for `(store, path)` — the live head if its
 * `content_object_key` is non-null, else a tombstone/redacted marker.
 */
async function latestVersionForPath(
  pool: Pool,
  tenantCtx: TenantCtx,
  storeId: string,
  path: string,
): Promise<VersionDbRow | null> {
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM memory_versions
      WHERE tenant_id = $1 AND store_id = $2 AND memory_path = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantCtx.tenantId, storeId, path],
  );
  return rows[0] ?? null;
}

/** Assert the store exists, is active, and belong to the tenant; returns its row. */
async function requireStore(pool: Pool, tenantCtx: TenantCtx, storeId: string) {
  const row = await fetchStoreRow(pool, tenantCtx, storeId);
  if (!row) {
    throw new ApiError(404, "not_found", `memory store not found: ${storeId}`);
  }
  return row;
}

/** Enforce the 100 kB per-memory content cap (§13.2). */
function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_CONTENT_BYTES) {
    throw new ApiError(
      422,
      "invalid_request",
      `memory content exceeds ${MAX_MEMORY_CONTENT_BYTES} bytes (§13.2)`,
    );
  }
}

/**
 * Internal: write a new immutable version row (+ its content object) for a path.
 * Used by {@link createMemory}, {@link updateMemory}, and the write-back sync.
 * Does NOT enforce preconditions — callers do. Returns the new version row.
 */
export async function writeVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  objectKeyPrefix: string,
  path: string,
  content: string,
  opts: { expiresAt?: Date | null } = {},
): Promise<VersionDbRow> {
  assertContentSize(content);
  const id = newId("memver_");
  const contentObjectKey = versionContentObjectKey(objectKeyPrefix, id);
  const contentSha256 = sha256Hex(content);
  await writeObjectText(objectStore, contentObjectKey, content);
  const expires =
    opts.expiresAt !== undefined ? opts.expiresAt : retentionExpiry();
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `INSERT INTO memory_versions
       (tenant_id, store_id, id, memory_path, content_sha256, content_object_key,
        redacted, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7)
     RETURNING ${VERSION_COLS}`,
    [
      tenantCtx.tenantId,
      storeId,
      id,
      path,
      contentSha256,
      contentObjectKey,
      expires,
    ],
  );
  return rows[0];
}

/** A `now() + 30d` Date for the version retention `expires_at` (§13.5). */
function retentionExpiry(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d;
}

function toSummary(v: VersionDbRow): MemorySummary {
  return {
    path: v.memoryPath ?? "",
    contentSha256: v.contentSha256,
    updatedAt: v.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a memory (first version for a path). `409 conflict` if the path is
 * already live. Enforces the 2,000-memories-per-store cap (§13.2). Returns the
 * memory (with content).
 */
export async function createMemory(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  input: { path: string; content: string },
): Promise<Memory> {
  const store = await requireStore(pool, tenantCtx, storeId);
  const existing = await latestVersionForPath(pool, tenantCtx, storeId, input.path);
  if (existing && existing.contentObjectKey !== null) {
    throw new ApiError(
      409,
      "conflict",
      `memory path already exists: ${input.path}`,
    );
  }
  // Per-store live-memory cap (§13.2).
  const { rows: countRows } = await tenantScopedQuery<{ n: string }>(
    pool,
    tenantCtx,
    `SELECT COUNT(*)::text AS n FROM (
       SELECT memory_path FROM (
         SELECT DISTINCT ON (memory_path) memory_path, content_object_key
           FROM memory_versions
          WHERE tenant_id = $1 AND store_id = $2
          ORDER BY memory_path, created_at DESC, id DESC
       ) h WHERE h.content_object_key IS NOT NULL
     ) live`,
    [tenantCtx.tenantId, storeId],
  );
  if (Number(countRows[0]?.n ?? 0) >= MAX_MEMORIES_PER_STORE) {
    throw new ApiError(
      422,
      "invalid_request",
      `memory store full: max ${MAX_MEMORIES_PER_STORE} memories (§13.2)`,
    );
  }
  const v = await writeVersion(
    pool,
    tenantCtx,
    objectStore,
    storeId,
    store.objectKeyPrefix,
    input.path,
    input.content,
  );
  return { ...toSummary(v), content: input.content };
}

/**
 * Retrieve a memory (with content): the live head version for `path`. `404` if
 * the path has no live head (absent or deleted via tombstone).
 */
export async function getMemory(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  path: string,
): Promise<Memory> {
  await requireStore(pool, tenantCtx, storeId);
  const head = await latestVersionForPath(pool, tenantCtx, storeId, path);
  if (!head || head.contentObjectKey === null) {
    throw new ApiError(404, "not_found", `memory not found: ${path}`);
  }
  const content = await readObjectText(objectStore, head.contentObjectKey);
  if (content === null) {
    throw new ApiError(404, "not_found", `memory content not found: ${path}`);
  }
  return { path, contentSha256: head.contentSha256, updatedAt: head.createdAt.toISOString(), content };
}

/**
 * Update a memory (insert a new head version). `404` if the path isn't live.
 * `409 conflict` (§13.4) if `contentSha256` is supplied and doesn't match the
 * stored head's hash — the client must re-read and retry. Returns the memory.
 */
export async function updateMemory(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  path: string,
  input: MemoryUpdate,
): Promise<Memory> {
  const store = await requireStore(pool, tenantCtx, storeId);
  const head = await latestVersionForPath(pool, tenantCtx, storeId, path);
  if (!head || head.contentObjectKey === null) {
    throw new ApiError(404, "not_found", `memory not found: ${path}`);
  }
  if (input.contentSha256 !== undefined && input.contentSha256 !== head.contentSha256) {
    throw new ApiError(
      409,
      "conflict",
      `contentSha256 mismatch (expected ${head.contentSha256}); re-read and retry (§13.4)`,
    );
  }
  const v = await writeVersion(
    pool,
    tenantCtx,
    objectStore,
    storeId,
    store.objectKeyPrefix,
    path,
    input.content,
  );
  return { ...toSummary(v), content: input.content };
}

/**
 * Delete a memory: insert a tombstone version (content_object_key NULL). The
 * memory is no longer live, but prior version rows survive (§13.5). `404` if the
 * path isn't live. Returns `void` (route maps to `204`).
 */
export async function deleteMemory(
  pool: Pool,
  tenantCtx: TenantCtx,
  storeId: string,
  path: string,
): Promise<void> {
  await requireStore(pool, tenantCtx, storeId);
  const head = await latestVersionForPath(pool, tenantCtx, storeId, path);
  if (!head || head.contentObjectKey === null) {
    throw new ApiError(404, "not_found", `memory not found: ${path}`);
  }
  const id = newId("memver_");
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `INSERT INTO memory_versions
       (tenant_id, store_id, id, memory_path, content_sha256, content_object_key,
        redacted, expires_at)
     VALUES ($1, $2, $3, $4, $5, NULL, false, $6)`,
    [tenantCtx.tenantId, storeId, id, path, head.contentSha256, retentionExpiry()],
  );
}

export interface ListMemoriesOptions {
  limit: number;
  cursor?: string;
}

function decodeMemoryCursor(cursor: string): { path: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { path?: string };
  if (!parsed.path) {
    throw new ApiError(400, "invalid_request", "invalid memory list cursor");
  }
  return { path: parsed.path };
}

/**
 * List live memories in a store (path summaries, no content). A memory is live
 * iff its latest version has `content_object_key` non-null. Cursor-paginated by
 * path ascending (§"Cursor pagination").
 */
export async function listMemories(
  pool: Pool,
  tenantCtx: TenantCtx,
  storeId: string,
  opts: ListMemoriesOptions,
): Promise<{ data: MemorySummary[]; nextCursor: string | null }> {
  await requireStore(pool, tenantCtx, storeId);
  const params: unknown[] = [tenantCtx.tenantId, storeId];
  const where: string[] = ["h.content_object_key IS NOT NULL"];
  let n = 2;
  if (opts.cursor) {
    const { path } = decodeMemoryCursor(opts.cursor);
    where.push(`h.memory_path > $${++n}`);
    params.push(path);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM (
        SELECT DISTINCT ON (memory_path) *
          FROM memory_versions
         WHERE tenant_id = $1 AND store_id = $2
         ORDER BY memory_path, created_at DESC, id DESC
     ) h
     WHERE ${where.join(" AND ")}
     ORDER BY h.memory_path ASC
     LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(JSON.stringify({ path: page[page.length - 1].memoryPath }), "utf8").toString("base64url")
      : null;
  return { data: page.map(toSummary), nextCursor };
}
