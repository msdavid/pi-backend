/**
 * Sessions domain module (WP-1.6 — the central resource).
 *
 * The `sessions` table holds metadata only; the conversation lives in the object
 * store at `jsonl_object_key` (§28). This module provides the repository
 * (persistence + mapping + override resolution + reads), the create/fork logic,
 * and the DB-backed `SessionStore` bridge to the `ManagedSessionRuntime`.
 *
 * @see docs/api-reference.md §"Sessions"
 * @see docs/db-schema.md §3.4
 */

export {
  toSession,
  fetchSessionRow,
  getSession,
  readSessionOverrides,
  listSessions,
  insertSessionRow,
  updateSession,
  deleteSession,
  resolveEffectiveConfig,
  applyOverrides,
  sessionJsonlObjectKey,
  getSessionEntries,
  getSessionTree,
  getSessionMessages,
  getSessionUsage,
  EMPTY_USAGE,
  type SessionRow,
  type ListSessionsOptions,
  type InsertSessionInput,
  type EntriesQuery,
} from "./session-repo.js";

export { createSession } from "./create.js";
export { forkSession } from "./fork.js";

export { DbSessionStore, sessionLocalJsonlPath } from "./db-session-store.js";
