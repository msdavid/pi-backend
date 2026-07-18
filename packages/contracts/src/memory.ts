/**
 * @pi-managed/contracts — Memory stores, memories, and versions.
 *
 * Mirrors docs/api-reference.md §"Memory stores". Cross-session memory mounted as a
 * volume in the sandbox. Versions belong to the store (not the memory) and survive
 * memory deletion.
 */

import { z } from "zod";
import { Metadata, ResourceStatus, Timestamp } from "./common.js";
import { memId, memverId } from "./ids.js";

export const MemoryAccess = z.enum(["read_write", "read_only"]);
export type MemoryAccess = z.infer<typeof MemoryAccess>;

// --- Memory store -----------------------------------------------------------

export const MemoryStoreCreate = z.object({
  displayTitle: z.string(),
  /** ≤4096 chars (§13.2). */
  instructions: z.string().max(4096).optional(),
  access: MemoryAccess.optional(),
  metadata: Metadata.optional(),
});
export type MemoryStoreCreate = z.infer<typeof MemoryStoreCreate>;

export const MemoryStoreUpdate = z.object({
  displayTitle: z.string().optional(),
  instructions: z.string().max(4096).optional(),
  access: MemoryAccess.optional(),
  metadata: Metadata.optional(),
});
export type MemoryStoreUpdate = z.infer<typeof MemoryStoreUpdate>;

export const MemoryStore = z.object({
  id: memId,
  displayTitle: z.string(),
  instructions: z.string().optional(),
  access: MemoryAccess,
  status: ResourceStatus,
  /** Set on the session resource when attached, not here (§13.3). */
  mountPath: z.string().nullable(),
  metadata: Metadata.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type MemoryStore = z.infer<typeof MemoryStore>;

// --- Memory (individual entry) ---------------------------------------------

export const MemoryCreate = z.object({
  path: z.string(),
  /** ≤100 kB (~25k tokens); store holds max 2,000 memories (§13.2). */
  content: z.string(),
});
export type MemoryCreate = z.infer<typeof MemoryCreate>;

export const MemoryUpdate = z.object({
  content: z.string(),
  /** Optimistic-concurrency precondition: must match stored hash (§13.4). */
  contentSha256: z.string().optional(),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdate>;

/** Memory summary (list view — no content). */
export const MemorySummary = z.object({
  path: z.string(),
  contentSha256: z.string(),
  updatedAt: Timestamp,
});
export type MemorySummary = z.infer<typeof MemorySummary>;

/** Memory with content (retrieve view). */
export const Memory = MemorySummary.extend({
  content: z.string(),
});
export type Memory = z.infer<typeof Memory>;

// --- Versions (audit trail, §13.5) -----------------------------------------

export const MemoryVersion = z.object({
  id: memverId,
  memoryPath: z.string(),
  contentSha256: z.string(),
  redacted: z.boolean(),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
});
export type MemoryVersion = z.infer<typeof MemoryVersion>;

/** Redact request — scrubs content, keeps audit trail (§13.6). */
export const MemoryVersionRedactRequest = z
  .object({ reason: z.string().optional() })
  .optional();
export type MemoryVersionRedactRequest = z.infer<typeof MemoryVersionRedactRequest>;

/**
 * Restore request (WP-C4.0) — copies an old version's content into a NEW head
 * version for the same `memoryPath` (history preserved; nothing rewritten).
 * No fields today; the body may be omitted entirely. Response: `MemoryVersion`
 * (the newly created version).
 */
export const MemoryVersionRestoreRequest = z.object({}).optional();
export type MemoryVersionRestoreRequest = z.infer<typeof MemoryVersionRestoreRequest>;
