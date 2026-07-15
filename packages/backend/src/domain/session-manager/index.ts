/**
 * Session manager (WP-1.5 — the "Harness"). Per-session `AgentSession` lifecycle:
 * state machine, idle policy, crash recovery, JSONL durability, and config
 * materialization. See `runtime.ts` for the central `ManagedSessionRuntime`.
 */

export { SessionStateMachine, MAX_RETRIES, RETRY_BACKOFF_MS } from "./state-machine.js";
export type {
  StateTransition,
  RetrySchedule,
  StateMachineClock,
} from "./state-machine.js";
export { LEGAL_TRANSITIONS, isLegalTransition, STOP_REASONS_FOR } from "./state-machine.js";

export { IdlePolicy, DEFAULT_IDLE_TIMEOUT_MS, idleTimeoutMsFromEnv } from "./idle-policy.js";
export type { IdleScheduleOptions } from "./idle-policy.js";

export { CrashRecovery } from "./crash-recovery.js";
export type { CrashRecoveryEvent, CrashRecoveryOptions } from "./crash-recovery.js";

export { JsonlSync, DEFAULT_SYNC_INTERVAL_MS } from "./jsonl-sync.js";
export type { JsonlSyncEvent } from "./jsonl-sync.js";

export { PiAgentSessionFactory } from "./materialize.js";

export { ManagedSessionRuntime } from "./runtime.js";
export type { ManagedSessionRuntimeOptions } from "./runtime.js";

export { InMemorySessionStore } from "./session-store.js";

export { SessionEventsStore } from "./session-events-store.js";
export type { SessionEventInput } from "./session-events-store.js";

export type {
  AgentSessionFactory,
  AgentSessionLike,
  AgentSessionEventLike,
  CreateAgentSessionOptions,
  CustomToolDefinition,
  InlineExtensionFactory,
  ProviderKeys,
  ResolvedAgentMaterial,
  SessionEntryLike,
  SessionMessageLike,
  SessionRecord,
  SessionStore,
} from "./types.js";

// Operations adapter (WP-1.4) — all seven built-in tools delegating to the microVM.
export { createRemoteTools, assertRemoteOperations, disableUserBash } from "./operations/tool-factory.js";
export { safeFetch, isPrivateAddress, resolveAndAssertPublic, SsrfBlockedError } from "./operations/ssrf-guard.js";
export { maybeSpillLargeOutput, SPILL_TOKEN_THRESHOLD } from "./operations/large-output.js";
