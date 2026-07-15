/**
 * Multiagent orchestration types (WP-3.1, spec §18).
 *
 * A "thread" is a per-agent `AgentSession` (its own context window + JSONL + event
 * stream). The *primary* thread is the user-facing session; the coordinator spawns
 * *child* threads for delegated work. Delegation is exactly ONE level deep (§18.2):
 * child threads do not load the subagent extension, so they cannot delegate further.
 */

import type { AgentConfig } from "@pi-managed/contracts";
import type { OutboundEvent, SessionId } from "../ports.js";
import type { AgentSessionLike } from "../session-manager/types.js";
import type { ThreadId } from "../event-stream/thread-events.js";

/** A thread id is a session id (each thread = its own AgentSession). */
export type { ThreadId } from "../event-stream/thread-events.js";

// ---------------------------------------------------------------------------
// Roster (§18.3)
// ---------------------------------------------------------------------------

/**
 * A roster entry spec, as declared on an agent's `multiagent.roster`.
 *
 * - `by_id` — reference an agent by id. `version` omitted ⇒ "latest", pinned to the
 *   current version at coordinator-creation time (snapshot-at-creation, §18.3).
 *   `version` set ⇒ pinned to that exact immutable version.
 * - `self` — the primary agent delegates to itself (re-uses its own config/material).
 */
export type RosterEntrySpec =
  | { type: "by_id"; agentId: string; version?: number }
  | { type: "self" };

/** A roster entry as declared (name/role + spec). */
export interface RosterEntry {
  /** Display name / role for this slot (e.g. "researcher"). */
  name: string;
  spec: RosterEntrySpec;
}

/**
 * A roster entry after snapshot-at-creation resolution: the referenced agent's id +
 * version are pinned, and its {@link AgentConfig} is captured. Subsequent agent
 * updates do NOT affect threads spawned from this roster (§18.3).
 */
export interface ResolvedRosterEntry {
  name: string;
  spec: RosterEntrySpec;
  /** The pinned agent id (for `self`, the primary agent's id). */
  resolvedAgentId: string;
  /** The pinned immutable version number. */
  resolvedVersion: number;
  /** The snapshot of the agent config at resolution time. */
  agentConfig: AgentConfig;
  /** Whether this entry is the primary agent delegating to itself. */
  isSelf: boolean;
}

/** Max roster entries (§18.3). */
export const MAX_ROSTER_ENTRIES = 20;
/** Max unique referenced agents across a roster (§18.3). */
export const MAX_UNIQUE_AGENTS = 20;
/**
 * Max concurrently-RUNNING threads per coordinator (§18.2). Counts threads with an
 * in-flight turn — NOT threads that merely finished one: a settled thread stays
 * addressable (persistent, §18.5) but holds no concurrency slot, so a long-lived
 * session can delegate more than 25 times over its lifetime.
 */
export const MAX_CONCURRENT_THREADS = 25;

/**
 * Max *live* (spawned, not yet disposed) threads across all coordinators on this node
 * (R6.4). Each live thread pins an `AgentSession` (context window + JSONL buffers) in
 * the node's heap, so `MAX_CONCURRENT_THREADS × N sessions` is unbounded RAM without a
 * node-wide ceiling. Spawning past it fails the delegation with 429 instead of OOM-ing
 * every tenant on the node (one Node process per node until R7.1).
 */
export const MAX_THREADS_PER_NODE = 200;

// ---------------------------------------------------------------------------
// Modes (§18.4)
// ---------------------------------------------------------------------------

/**
 * Multiagent execution mode (§18.4).
 *
 * - `shared` — all threads share one sandbox + one vault binding set. Model/system
 *   prompt/tools/MCP/skills are still per-thread (per the agent config), but the
 *   execution environment + secrets are shared.
 * - `isolated` — each thread gets its own sandbox + its own config (model/system
 *   prompt/tools/MCP/skills NOT shared). Vault bindings are resolved per-thread.
 */
export type MultiagentMode = "shared" | "isolated";

// ---------------------------------------------------------------------------
// Inter-thread messaging (§18.5)
// ---------------------------------------------------------------------------

/** A message between threads (§18.5). */
export interface ThreadMessage {
  fromSessionThreadId: ThreadId;
  fromAgentName: string;
  toSessionThreadId: ThreadId;
  toAgentName: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Cross-posting (§18.7)
// ---------------------------------------------------------------------------

/** The kind of blocking result a child thread is awaiting (§18.7). */
export type BlockingKind = "tool_confirmation" | "custom_tool_result";

/**
 * A blocking event cross-posted from a child thread to the primary thread (§18.7).
 * The `sessionThreadId` identifies the originating thread so the user's response is
 * routed back to the correct child.
 */
export interface BlockingThreadEvent {
  sessionThreadId: ThreadId;
  /** The blocking event id (`toolCallId` / `customToolUseId`). */
  eventId: string;
  toolName: string;
  input: Record<string, unknown>;
  kind: BlockingKind;
}

/** The response to a blocking event, routed back to the originating child thread. */
export interface BlockingResponse {
  kind: BlockingKind;
  eventId: string;
  /** For `tool_confirmation`: allow/deny + optional deny message. */
  decision?: "allow" | "deny";
  denyMessage?: string;
  /** For `custom_tool_result`: the result string. */
  result?: string;
}

// ---------------------------------------------------------------------------
// Thread runtime
// ---------------------------------------------------------------------------

/** Thread lifecycle status (mirrors the session state machine, §18.6). */
export type ThreadStatus = "idle" | "running" | "terminated";

/** A condensed activity item the coordinator forwards to the primary thread. */
export interface CondensedThreadEvent {
  sessionThreadId: ThreadId;
  agentName: string;
  kind: "started" | "idle" | "terminated" | "blocking" | "message";
  stopReason?: string;
  blockingEventIds?: readonly string[];
  message?: ThreadMessage;
}

/** Options to construct a {@link ThreadRuntime} (see `thread.ts`). */
export interface ThreadRuntimeOptions {
  threadId: ThreadId;
  agentName: string;
  /** The per-thread AgentSession (created by the AgentSessionFactory). */
  session: AgentSessionLike;
  /** Local JSONL path bound to the session (for getEntries / persistence). */
  localJsonlPath: string;
  /** The shared-or-isolated sandbox handle bound to this thread. */
  sandboxHandle?: unknown;
  /** Cross-post coordinator (registers blocking events on the primary thread). */
  crossPost?: ThreadCrossPostPort;
  /** Sink for condensed activity forwarded to the primary thread. */
  onCondensed?: (event: CondensedThreadEvent) => void;
}

/**
 * Port the thread runtime uses to cross-post blocking events. Implemented by
 * `CrossPostCoordinator`; decoupled so the thread runtime is unit-testable.
 */
export interface ThreadCrossPostPort {
  requestBlocking(req: BlockingThreadEvent): Promise<BlockingResponse>;
}

/** A handle to a spawned thread (see `thread.ts`). */
export interface ThreadHandle {
  readonly threadId: ThreadId;
  readonly agentName: string;
  readonly status: ThreadStatus;
  /** Outbound events from this thread (thread lifecycle + passthrough agent.*). */
  subscribe(): AsyncIterable<OutboundEvent>;
  /** Run a turn (initial task). Emits thread_status_running → idle. */
  run(task: string): Promise<ThreadRunResult>;
  /** Send a follow-up to a thread that retains its prior turns (§18.5 persistent). */
  followUp(content: string): Promise<ThreadRunResult>;
  /** Interrupt the in-flight turn. */
  interrupt(): Promise<void>;
  /** Inject an event on this thread's stream (inter-thread `received` messages). */
  inject(event: OutboundEvent): void;
  /** Terminate + dispose the thread's AgentSession. */
  dispose(): void;
}

/** The outcome of a thread turn. */
export interface ThreadRunResult {
  threadId: ThreadId;
  /** Final assistant text (last `agent.message`), or "" if none. */
  output: string;
  stopReason: string;
  /** Blocking event ids still pending (if the turn blocked). */
  blockingEventIds: string[];
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** A resolved agent materialization (config + provider keys + cwd), per thread. */
export interface ResolvedThreadMaterial {
  agentId: string;
  version: number;
  agentConfig: AgentConfig;
  /** Provider keys for this thread (shared mode: same set; isolated: per-thread). */
  providerKeys: Record<string, string>;
  cwd: string;
  systemPromptOverride?: string;
  /** Vault ids resolved for this thread (shared mode: shared; isolated: per-thread). */
  vaultIds: string[];
}

/** Session id alias (a thread is a session). */
export type { SessionId };
