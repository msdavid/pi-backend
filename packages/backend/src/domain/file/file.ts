/**
 * Files domain service (WP-1.12, §8.9, §21, §3.7).
 *
 * Files are **independent resources** — uploading/downloading/listing/deleting them
 * is decoupled from session lifecycle. Deleting a session does NOT delete its files
 * (§21); the `files.session_id` column is a nullable soft-link to a session (set for
 * session outputs, §16.6) with no `ON DELETE` cascade (migration 011).
 *
 * Content lives in the object store at `tenants/<tenant_id>/files/<file_id>` (§28
 * key layout); only metadata is stored in Postgres. Every query routes through
 * {@link tenantScopedQuery} so cross-tenant access is impossible by construction
 * (§27.1).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import { reserveQuotaDelta, releaseQuotaDelta } from "../quota/index.js";
import type { ObjectStore } from "../ports.js";
import type { File, Metadata } from "@pi-managed/contracts";

// ---------------------------------------------------------------------------
// Row shape & mapping
// ---------------------------------------------------------------------------

/** `files` row (snake_case; `metadata` arrives as a parsed jsonb object). */
export interface FileRow {
  id: string;
  name: string;
  content_type: string | null;
  size_bytes: number;
  object_key: string;
  session_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** ISO-string helper — contracts `Timestamp` is an RFC 3339 string. */
const iso = (d: Date): string => d.toISOString();

/** Build the wire `File` resource from a db row. */
export function toFile(row: FileRow): File {
  const metadata =
    row.metadata && Object.keys(row.metadata).length
      ? (row.metadata as Metadata)
      : undefined;
  const file: File = {
    id: row.id,
    name: row.name,
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at),
  };
  if (row.content_type) file.contentType = row.content_type;
  if (row.session_id) file.sessionId = row.session_id;
  if (metadata) file.metadata = metadata;
  return file;
}

/** Object-store key for a file (§28 layout: `tenants/<tenant>/files/<file>`). */
export function fileObjectKey(tenantId: string, fileId: string): string {
  return `tenants/${tenantId}/files/${fileId}`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadFileInput {
  name: string;
  contentType?: string;
  /** Content stream; piped straight to the object store while bytes are counted (never fully buffered). */
  stream: ReadableStream<Uint8Array>;
  /** Optional soft-link to a session (set for session outputs, §16.6). */
  sessionId?: string;
  metadata?: Metadata;
}

/**
 * Upload a file: stream the content straight into the object store at
 * `tenants/<tenant>/files/<file_id>` — counting bytes in-flight for `size_bytes`
 * rather than buffering the whole payload (PERF-5) — and insert a `files` row.
 * Returns the wire metadata. The file is an independent resource — `sessionId`
 * (when given) is a nullable soft-link, never a cascade target (§21).
 */
export async function uploadFile(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  input: UploadFileInput,
): Promise<File> {
  const id = newId("file_");
  const objectKey = fileObjectKey(tenantCtx.tenantId, id);

  // Pipe the content to the store through a pass-through that tallies bytes as they
  // flow, so `size_bytes` is measured without holding the payload in memory.
  let sizeBytes = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sizeBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const putPromise = store.put(objectKey, counting.readable);
  try {
    await input.stream.pipeTo(counting.writable);
  } catch (err) {
    // A source error aborts the transform and rejects the put; settle it so the
    // rejection is observed rather than surfacing as an unhandled rejection.
    await putPromise.catch(() => {});
    throw err;
  }
  await putPromise;

  // Authoritative, race-safe storage reservation (ROB-15): reserve the ACTUAL
  // stored byte count (the middleware pre-flight only sees Content-Length and is
  // defense-in-depth). On over-quota this throws 429 and we roll back the object
  // we just wrote so no bytes leak.
  try {
    await reserveQuotaDelta(pool, tenantCtx, "maxFileStorageBytes", sizeBytes);
  } catch (err) {
    await store.hardDelete(objectKey).catch(() => {});
    throw err;
  }

  let rows;
  try {
    ({ rows } = await tenantScopedQuery<FileRow>(
      pool,
      tenantCtx,
      `INSERT INTO files
         (tenant_id, id, name, content_type, size_bytes, object_key,
          session_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        tenantCtx.tenantId,
        id,
        input.name,
        input.contentType ?? null,
        sizeBytes,
        objectKey,
        input.sessionId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    ));
  } catch (err) {
    // The row failed to persist after we reserved + stored: compensate both so the
    // reservation doesn't leak (until reconcileQuotaCounter would correct it) and
    // no orphan object remains.
    await releaseQuotaDelta(pool, tenantCtx, "maxFileStorageBytes", sizeBytes).catch(
      () => {},
    );
    await store.hardDelete(objectKey).catch(() => {});
    throw err;
  }
  return toFile(rows[0]);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListFilesOptions {
  limit: number;
  cursor?: string;
  /** Narrow to files soft-linked to a session (outputs listing, §16.6). */
  sessionId?: string;
}

/** Decode a list cursor into its `{createdAt, id}` position marker. */
function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid file list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/**
 * List files for `tenantCtx`, newest first, cursor-paginated. Optional `sessionId`
 * narrows to a session's outputs (§"GET /v1/files" `?sessionId=`).
 */
export async function listFiles(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListFilesOptions,
): Promise<{ data: File[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantCtx.tenantId];
  const where: string[] = [];
  let n = 1;
  if (opts.sessionId) {
    where.push(`session_id = $${++n}`);
    params.push(opts.sessionId);
  }
  if (opts.cursor) {
    const { createdAt, id } = decodeListCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<FileRow>(
    pool,
    tenantCtx,
    `SELECT * FROM files
      WHERE tenant_id = $1 ${where.length ? `AND ${where.join(" AND ")}` : ""}
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
            createdAt: iso(page[page.length - 1].created_at),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toFile), nextCursor };
}

// ---------------------------------------------------------------------------
// Get / download / delete
// ---------------------------------------------------------------------------

/** Fetch a file row, or `null` if absent / cross-tenant. */
export async function fetchFileRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<FileRow | null> {
  const { rows } = await tenantScopedQuery<FileRow>(
    pool,
    tenantCtx,
    `SELECT * FROM files WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

/** Get file metadata; `null` if absent / cross-tenant. */
export async function getFile(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<File | null> {
  const row = await fetchFileRow(pool, tenantCtx, id);
  return row ? toFile(row) : null;
}

/** Result of {@link downloadFile}: the metadata + a streaming content handle. */
export interface DownloadResult {
  file: File;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Download a file's content. Returns the wire metadata + the object-store content
 * stream. Throws `404 not_found` if the file is absent / cross-tenant.
 */
export async function downloadFile(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  id: string,
): Promise<DownloadResult> {
  const row = await fetchFileRow(pool, tenantCtx, id);
  if (!row) {
    throw new ApiError(404, "not_found", `file not found: ${id}`);
  }
  const stream = await store.get(row.object_key);
  return { file: toFile(row), stream };
}

/**
 * Hard-delete a file (§21): remove the object from the store and the row from
 * Postgres. Returns `true` if a file was deleted, `false` if absent / cross-tenant.
 * Best-effort on the object-store delete: a store failure after the row is gone
 * leaves an orphaned object (auditable), but the resource is deleted for the client.
 */
export async function deleteFile(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  id: string,
): Promise<boolean> {
  const row = await fetchFileRow(pool, tenantCtx, id);
  if (!row) return false;
  // Delete the DB row first so the resource disappears immediately; then purge
  // the object. An object-store failure does not resurrect the file.
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM files WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  try {
    await store.delete(row.object_key);
  } catch {
    // Orphaned object — the resource is deleted; log-free best-effort purge.
  }
  // Release the storage reservation for the freed bytes (ROB-15). Best-effort:
  // reconcileQuotaCounter corrects any drift if this fails.
  await releaseQuotaDelta(
    pool,
    tenantCtx,
    "maxFileStorageBytes",
    Number(row.size_bytes),
  ).catch(() => {});
  return true;
}
