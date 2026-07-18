/**
 * Memory version service (WP-2.2, §13.5–13.6, §3.6 `memory_versions`).
 *
 * The immutable audit trail. Versions belong to the *store* (not the memory)
 * and survive memory deletion (§13.5). Each mutation in {@link memory.ts}
 * appends a version row; this service reads + redacts them.
 *
 * Redaction (§13.6): scrubs a version's content (deletes the object-store bytes
 * and nulls `content_object_key`) while preserving the audit row. The version
 * that is the **current head of a live memory** cannot be redacted — `409` —
 * write a new version (or delete the memory) first, then redact the old one.
 *
 * Restore (WP-C4.0, C§9.5): {@link restoreVersion} copies an old version's
 * content server-side into a NEW head version for the same path — history is
 * preserved, nothing rewritten. A redacted/tombstone source (content gone) is a
 * `409 conflict`.
 *
 * Retention (§13.5): 30-day `expires_at`; the most recent versions are always
 * kept regardless of age. {@link purgeExpiredVersions} is the sweep (callers
 * schedule it; the backend does not auto-schedule it here).
 */

import {
  tenantScopedQuery,
  query,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import type { ObjectStore } from "../ports.js";
import type { MemoryVersion } from "@pi-managed/contracts";
import { fetchStoreRow } from "./store.js";
import { readObjectText, writeVersion } from "./memory.js";

/** Default "recent-always-kept" window per store (§13.5). */
export const DEFAULT_KEEP_RECENT = 10;

/** `memory_versions` row (camelCased projection matching `MemoryVersion`). */
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

function toVersion(r: VersionDbRow): MemoryVersion {
  return {
    id: r.id,
    memoryPath: r.memoryPath ?? "",
    contentSha256: r.contentSha256,
    redacted: r.redacted,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  };
}

/** Assert the store exists + is active; returns its row. */
async function requireStore(pool: Pool, tenantCtx: TenantCtx, storeId: string) {
  const row = await fetchStoreRow(pool, tenantCtx, storeId);
  if (!row) {
    throw new ApiError(404, "not_found", `memory store not found: ${storeId}`);
  }
  return row;
}

export interface ListVersionsOptions {
  limit: number;
  cursor?: string;
  /** Optional path filter (audit trail for one memory). */
  memoryPath?: string;
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid version list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/**
 * List memory versions (audit trail) for a store, newest first. Versions belong
 * to the store and survive memory deletion (§13.5). Optional `memoryPath`
 * filter narrows to one memory's history.
 */
export async function listMemoryVersions(
  pool: Pool,
  tenantCtx: TenantCtx,
  storeId: string,
  opts: ListVersionsOptions,
): Promise<{ data: MemoryVersion[]; nextCursor: string | null }> {
  await requireStore(pool, tenantCtx, storeId);
  const params: unknown[] = [tenantCtx.tenantId, storeId];
  const where: string[] = [];
  let n = 2;
  if (opts.memoryPath) {
    where.push(`memory_path = $${++n}`);
    params.push(opts.memoryPath);
  }
  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM memory_versions
      WHERE tenant_id = $1 AND store_id = $2 ${where.length ? `AND ${where.join(" AND ")}` : ""}
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
  return { data: page.map(toVersion), nextCursor };
}

/** Fetch a single version; `null` if absent (or cross-tenant). */
export async function getMemoryVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  storeId: string,
  versionId: string,
): Promise<MemoryVersion | null> {
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM memory_versions
      WHERE tenant_id = $1 AND store_id = $2 AND id = $3`,
    [tenantCtx.tenantId, storeId, versionId],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

/**
 * Redact a version (§13.6): scrub its content (delete the object-store bytes +
 * null `content_object_key`) while preserving the audit row. A version that is
 * the current head of a live memory is rejected with `409 conflict` — write a
 * new version (or delete the memory) first, then redact the old one. Idempotent
 * on an already-redacted version.
 */
export async function redactVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  versionId: string,
): Promise<MemoryVersion> {
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM memory_versions
      WHERE tenant_id = $1 AND store_id = $2 AND id = $3`,
    [tenantCtx.tenantId, storeId, versionId],
  );
  const v = rows[0];
  if (!v) {
    throw new ApiError(404, "not_found", `memory version not found: ${versionId}`);
  }
  // Already redacted → idempotent no-op.
  if (v.redacted || v.contentObjectKey === null) {
    return toVersion({ ...v, redacted: true, contentObjectKey: null });
  }
  // §13.6: reject if this version is the head of a live memory.
  if (v.memoryPath) {
    const { rows: headRows } = await tenantScopedQuery<VersionDbRow>(
      pool,
      tenantCtx,
      `SELECT ${VERSION_COLS} FROM memory_versions
        WHERE tenant_id = $1 AND store_id = $2 AND memory_path = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [tenantCtx.tenantId, storeId, v.memoryPath],
    );
    const head = headRows[0];
    if (head && head.id === v.id && head.contentObjectKey !== null) {
      throw new ApiError(
        409,
        "conflict",
        `cannot redact the head of a live memory; write a new version or delete the memory first (§13.6)`,
      );
    }
  }
  // Scrub the content object (best-effort). `hardDelete` (not `delete`) so that
  // on a versioned store (S3/GCS on SaaS) every prior version is purged — a plain
  // delete would only write a delete marker, leaving the plaintext retrievable
  // by VersionId (§13.6).
  try {
    await objectStore.hardDelete(v.contentObjectKey);
  } catch {
    // Object already absent — redaction still nulls the reference.
  }
  const { rows: updated } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `UPDATE memory_versions
        SET redacted = true, content_object_key = NULL
      WHERE tenant_id = $1 AND store_id = $2 AND id = $3
     RETURNING ${VERSION_COLS}`,
    [tenantCtx.tenantId, storeId, versionId],
  );
  return toVersion(updated[0] ?? { ...v, redacted: true, contentObjectKey: null });
}

/**
 * Restore a version (WP-C4.0, C§9.5): copy the source version's content
 * server-side into a NEW version for the same `memoryPath`, which becomes the
 * live head — history is preserved, nothing rewritten. Works whether the memory
 * is currently live (revert) or deleted (undelete). Errors:
 *
 *  - `404 not_found` — store absent/archived, or version absent/cross-tenant.
 *  - `409 conflict` — the source version's content is gone (redacted, or a
 *    deletion tombstone): nothing to restore. A state conflict, not a
 *    validation failure (api-reference.md, status policy).
 */
export async function restoreVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  objectStore: ObjectStore,
  storeId: string,
  versionId: string,
): Promise<MemoryVersion> {
  const store = await requireStore(pool, tenantCtx, storeId);
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT ${VERSION_COLS} FROM memory_versions
      WHERE tenant_id = $1 AND store_id = $2 AND id = $3`,
    [tenantCtx.tenantId, storeId, versionId],
  );
  const v = rows[0];
  if (!v) {
    throw new ApiError(404, "not_found", `memory version not found: ${versionId}`);
  }
  if (v.contentObjectKey === null || v.memoryPath === null) {
    throw new ApiError(
      409,
      "conflict",
      v.redacted
        ? `cannot restore a redacted version: ${versionId} (content is gone)`
        : `cannot restore a deletion tombstone: ${versionId} (it has no content)`,
    );
  }
  const content = await readObjectText(objectStore, v.contentObjectKey);
  if (content === null) {
    throw new ApiError(
      409,
      "conflict",
      `cannot restore version ${versionId}: its content object is gone`,
    );
  }
  const restored = await writeVersion(
    pool,
    tenantCtx,
    objectStore,
    storeId,
    store.objectKeyPrefix,
    v.memoryPath,
    content,
  );
  return toVersion(restored);
}

/**
 * Purge versions whose `expires_at` has passed, keeping the {@link keepRecent}
 * most recent versions per store regardless of age (§13.5). Returns the number of
 * purged rows. Best-effort deletes the corresponding object-store content.
 *
 * Callers schedule this sweep (the backend does not auto-schedule it here).
 *
 * INTENTIONALLY CROSS-TENANT (§27.1 exception): this is a privileged retention
 * sweep over every store of every tenant, so it deliberately uses the raw
 * `query` helper and is NOT routed through {@link tenantScopedQuery}. The
 * `PARTITION BY store_id` keeps the keep-recent window correct per store; no
 * `tenant_id` filter applies because the sweep is global by design.
 */
export async function purgeExpiredVersions(
  pool: Pool,
  objectStore: ObjectStore,
  opts: { keepRecent?: number } = {},
): Promise<number> {
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const { rows } = await query<{ id: string; content_object_key: string | null }>(
    pool,
    `WITH recent AS (
       SELECT id, store_id,
              ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY created_at DESC, id DESC) AS rn
         FROM memory_versions
     )
     SELECT v.id, v.content_object_key
       FROM memory_versions v
       JOIN recent r ON r.id = v.id
      WHERE v.expires_at IS NOT NULL
        AND v.expires_at < now()
        AND r.rn > $1`,
    [keepRecent],
  );
  for (const r of rows) {
    if (r.content_object_key) {
      try {
        // `hardDelete` so expired content is purged on versioned stores too, not
        // just masked with a delete marker (§13.5/§13.6). Each version has a
        // unique content object key, so this never touches a kept version.
        await objectStore.hardDelete(r.content_object_key);
      } catch {
        // best-effort
      }
    }
  }
  if (rows.length === 0) return 0;
  // Delete the purged rows in one statement.
  const ids = rows.map((r) => r.id);
  const { rowCount } = await query(
    pool,
    `DELETE FROM memory_versions WHERE id = ANY($1::text[])`,
    [ids],
  );
  return rowCount ?? 0;
}
