/**
 * @pi-managed/contracts — File resource (metadata only).
 *
 * Mirrors docs/api-reference.md §"Files". A separate Files API for uploading and
 * managing files. Files are independent resources — not affected by session deletion.
 * Content is uploaded/downloaded out-of-band (multipart), so only metadata is modeled.
 */

import { z } from "zod";
import { Metadata, Timestamp } from "./common.js";
import { fileId, sessId } from "./ids.js";

export const File = z.object({
  id: fileId,
  name: z.string(),
  contentType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  sessionId: sessId.optional(),
  createdAt: Timestamp,
  metadata: Metadata.optional(),
});
export type File = z.infer<typeof File>;

export const FileListParams = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  sessionId: sessId.optional(),
});
export type FileListParams = z.infer<typeof FileListParams>;
