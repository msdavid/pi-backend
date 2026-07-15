/**
 * Session-worker process pool (R7.1 — harness blast radius).
 *
 * `SESSION_WORKER_MODE=inproc` (default) keeps every session in the control-plane process
 * (the pre-R7.1 behavior, unchanged). `SESSION_WORKER_MODE=pool` moves the
 * {@link ManagedSessionRuntime}s into N bounded child processes, sharded deterministically
 * by session id, so a harness crash takes down only that child's sessions.
 *
 * See `docs/session-worker-pool.md`.
 */

export {
  SessionWorkerPool,
  defaultWorkerEntry,
  DEFAULT_SESSION_WORKERS,
  DEFAULT_SESSIONS_PER_WORKER,
  RESPAWN_DELAY_MS,
  type SessionWorkerPoolOptions,
} from "./pool.js";
export { RemoteSessionRuntime } from "./remote-runtime.js";
export type {
  RemoteSessionRuntimeOptions,
  RemoteSessionTransport,
} from "./remote-runtime.js";
export { shardFor } from "./protocol.js";
export type {
  ChildMessage,
  ParentMessage,
  RemoteSessionState,
} from "./protocol.js";
export type {
  SessionWorkerOverrides,
  SessionWorkerOverridesModule,
} from "./worker-entry.js";
