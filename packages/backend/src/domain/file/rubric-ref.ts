/**
 * Rubric-referenced files (WP-3.5, §16.2).
 *
 * An outcome rubric may be `{type: 'file', fileId}` instead of inline text
 * (§16.2/§16.3). The grader (a subagent, §3.2/§16.4) needs the rubric content;
 * this module fetches it through the existing Files service so a referenced file
 * is read identically to a direct download (tenant-scoped, object-store-backed,
 * §21). It is a thin, documented adapter over `downloadFile`.
 */

import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import type { ObjectStore } from "../ports.js";
import { downloadFile, type DownloadResult } from "./file.js";
import type { File } from "@pi-managed/contracts";

/** A rubric reference resolved by the grader (§16.2). */
export interface RubricFileRef {
  type: "file";
  fileId: string;
}

/** Is a rubric spec a file reference? */
export function isRubricFileRef(rubric: unknown): rubric is RubricFileRef {
  return (
    typeof rubric === "object" &&
    rubric !== null &&
    (rubric as { type?: unknown }).type === "file" &&
    typeof (rubric as { fileId?: unknown }).fileId === "string"
  );
}

/**
 * Fetch the rubric file for the outcome grader. Returns the file metadata + a
 * streaming content handle (identical to a direct file download, §16.2). Throws
 * `404 not_found` if the file is absent / cross-tenant.
 */
export async function getRubricFile(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  fileId: string,
): Promise<DownloadResult> {
  return downloadFile(pool, tenantCtx, store, fileId);
}

/**
 * Fetch + drain a rubric file's content as a UTF-8 string. The outcome grader
 * consumes the rubric text; this is the convenience entry point. Throws
 * `404 not_found` if the file is absent / cross-tenant.
 */
export async function getRubricFileContent(
  pool: Pool,
  tenantCtx: TenantCtx,
  store: ObjectStore,
  fileId: string,
): Promise<{ file: File; content: string }> {
  const { file, stream } = await getRubricFile(pool, tenantCtx, store, fileId);
  const bytes = await drain(stream);
  return { file, content: Buffer.from(bytes).toString("utf8") };
}

/** Drain a `ReadableStream<Uint8Array>` into a `Uint8Array`. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
