/**
 * Multiagent orchestration (WP-3.1, spec §18).
 *
 * Per-primary-session coordinator that spawns child threads (each its own
 * `AgentSession` + sandbox), fans out single/parallel/chain delegation, routes
 * inter-thread messages, and cross-posts blocking round-trips to the primary thread.
 * One level of delegation only (§18.2); ≤25 concurrent threads; 1–20 roster entries.
 *
 * See `coordinator.ts` for the central {@link SubagentCoordinator}.
 */

export {
  resolveRoster,
  validateSpec,
  canDelegate,
  type AgentLookup,
  type AgentResolver,
  type ResolveRosterOptions,
} from "./roster.js";

export {
  SharedSandboxAllocator,
  IsolatedSandboxAllocator,
  FakeSandboxAllocator,
  type SandboxAllocator,
  type AllocateSandboxOptions,
  type AllocatedSandbox,
} from "./modes.js";

export { deliverThreadMessage, type ThreadEventSink, type DeliverMessageOptions } from "./messaging.js";

export {
  CrossPostCoordinator,
  primaryBlockingPayload,
  primaryBlockingEvent,
  type CrossPostHooks,
} from "./cross-posting.js";

export { ThreadRuntime } from "./thread.js";

export {
  SubagentCoordinator,
  ThreadBudget,
  nodeThreadBudget,
  type SubagentCoordinatorOptions,
  type SubagentTask,
  type ChainStep,
  type SubagentResult,
} from "./coordinator.js";

export {
  MAX_ROSTER_ENTRIES,
  MAX_UNIQUE_AGENTS,
  MAX_CONCURRENT_THREADS,
  MAX_THREADS_PER_NODE,
  type RosterEntry,
  type RosterEntrySpec,
  type ResolvedRosterEntry,
  type MultiagentMode,
  type ThreadMessage,
  type BlockingThreadEvent,
  type BlockingResponse,
  type BlockingKind,
  type ThreadHandle,
  type ThreadRuntimeOptions,
  type ThreadRunResult,
  type ThreadStatus,
  type CondensedThreadEvent,
  type ThreadCrossPostPort,
  type ResolvedThreadMaterial,
  type ThreadId,
} from "./types.js";
