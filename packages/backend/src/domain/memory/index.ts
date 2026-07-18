/**
 * Memory domain barrel (WP-2.2, §8.6, §13). Cross-session memory: stores,
 * memories, immutable versions, and the sandbox mount pipeline.
 *
 * - {@link slug.ts}        — filesystem-safe slug for mount paths (§13.3).
 * - {@link store.ts}       — store CRUD + limits.
 * - {@link memory.ts}      — memory CRUD + `contentSha256` optimistic concurrency (§13.4).
 * - {@link version.ts}     — version audit trail, redact (§13.6), restore (WP-C4.0),
 *                            30-day retention (§13.5).
 * - {@link mount.ts}       — object store → volume mount pipeline + write-back (§13.1).
 */

export { slugify } from "./slug.js";

export {
  createMemoryStore,
  listMemoryStores,
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
  fetchStoreRow,
  storeObjectKeyPrefix,
  versionContentObjectKey,
  VERSION_RETENTION_DAYS,
  MAX_MEMORIES_PER_STORE,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_INSTRUCTIONS_CHARS,
  type CreateMemoryStoreInput,
  type UpdateMemoryStoreInput,
  type ListMemoryStoresOptions,
} from "./store.js";

export {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  writeVersion,
  sha256Hex,
  type ListMemoriesOptions,
} from "./memory.js";

export {
  listMemoryVersions,
  getMemoryVersion,
  redactVersion,
  restoreVersion,
  purgeExpiredVersions,
  DEFAULT_KEEP_RECENT,
  type ListVersionsOptions,
} from "./version.js";

export {
  mountMemoryStores,
  mountPathFor,
  systemPromptNoteFor,
  systemPromptNotes,
  stageMemoryVolume,
  syncMemoryVolumeBack,
  InMemoryVolumeStore,
  MAX_MEMORY_STORES_PER_SESSION,
  type VolumeStore,
} from "./mount.js";
