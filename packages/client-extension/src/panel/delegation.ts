/**
 * @pi-managed/client — delegation entry-append discipline (spec §24.7).
 *
 * Enforces the core invariant: **exactly two durable `custom` entries per
 * delegation** — a start marker and a completion summary. Both are appended
 * via `pi.appendEntry()` under `DELEGATION_CUSTOM_TYPE` and survive forks
 * (they are ordinary session-log entries).
 *
 * The recorder is idempotent per sessionId: a reconnect, a replayed
 * `session.status_idle`, or a double-trigger never appends a second start or
 * completion for the same session. This is what makes the "exactly 2" rule
 * robust against SSE drops and re-emissions.
 */

import type { Session, SessionStatus, Usage } from "@pi-managed/contracts";
import type {
  AppendEntryFn,
  DelegationMode,
  OfflineCompletionData,
} from "./types.js";
import { DELEGATION_CUSTOM_TYPE } from "./types.js";

export interface DelegationCompletionInput {
  status: SessionStatus;
  stopReason?: string | null;
  usage?: Usage;
  outputsAvailable: boolean;
  error?: string;
}

/** Clock injection point (so tests are deterministic). */
export type NowFn = () => string;

/** Persisted dedup state — the started/completed session-id sets, serialized. */
export interface DelegationDedupState {
  started: string[];
  completed: string[];
}

/**
 * Persistence port for the recorder's dedup sets (mirrors `AuthStore` in
 * auth.ts). The recorder hydrates from `load()` on construction and calls
 * `save()` after every mutation, so the "exactly 2 entries" invariant survives
 * a Pi restart (otherwise the in-memory `Set`s reset and every terminal tenant
 * session re-surfaces an offline-completion entry). A file-backed adapter lives
 * in `dedup-store.ts`; `InMemoryDelegationDedupStore` is used in tests.
 */
export interface DelegationDedupStore {
  load(): DelegationDedupState;
  save(state: DelegationDedupState): void;
}

/** In-memory dedup store for tests and ephemeral runs. */
export class InMemoryDelegationDedupStore implements DelegationDedupStore {
  private state: DelegationDedupState = { started: [], completed: [] };
  load(): DelegationDedupState {
    return {
      started: [...this.state.started],
      completed: [...this.state.completed],
    };
  }
  save(state: DelegationDedupState): void {
    this.state = {
      started: [...state.started],
      completed: [...state.completed],
    };
  }
}

/**
 * Records delegation markers and guarantees the start+completion invariant.
 * Construct one per attached panel; the registry shares a single instance
 * across attach/detach so reattaching a session never double-appends.
 */
export class DelegationRecorder {
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly now: NowFn;
  private readonly store?: DelegationDedupStore;

  constructor(
    private readonly appendEntry: AppendEntryFn,
    now?: NowFn,
    store?: DelegationDedupStore,
  ) {
    this.now = now ?? (() => new Date().toISOString());
    this.store = store;
    if (store) {
      const state = store.load();
      for (const id of state.started) this.started.add(id);
      for (const id of state.completed) this.completed.add(id);
    }
  }

  /** Persist the current dedup sets (no-op when no store is configured). */
  private persist(): void {
    this.store?.save({
      started: [...this.started],
      completed: [...this.completed],
    });
  }

  /** Append the FIRST marker (start). No-op if already started for this session. */
  appendStart(sessionId: string, task: string, mode: DelegationMode): void {
    if (this.started.has(sessionId)) return;
    this.started.add(sessionId);
    this.persist();
    this.appendEntry(DELEGATION_CUSTOM_TYPE, {
      kind: "start",
      sessionId,
      task,
      startedAt: this.now(),
      mode,
    });
  }

  /** Append the SECOND marker (completion summary). No-op if already completed. */
  appendCompletion(sessionId: string, input: DelegationCompletionInput): void {
    if (this.completed.has(sessionId)) return;
    this.completed.add(sessionId);
    this.persist();
    this.appendEntry(DELEGATION_CUSTOM_TYPE, {
      kind: "completion",
      sessionId,
      status: input.status,
      stopReason: input.stopReason,
      usage: input.usage,
      outputsAvailable: input.outputsAvailable,
      completedAt: this.now(),
      error: input.error,
    });
  }

  /**
   * Surface a session that completed while local Pi was offline (§24.9).
   * Shares the completion idempotency guard — if the session already has a
   * completion marker, this is a no-op (the offline discovery re-attaches to
   * an already-recorded result rather than duplicating it).
   */
  appendOfflineCompletion(
    sessionId: string,
    session: Pick<Session, "status" | "lastActivityAt">,
  ): void {
    if (this.completed.has(sessionId)) return;
    this.completed.add(sessionId);
    this.persist();
    const data: OfflineCompletionData = {
      kind: "offline-completion",
      sessionId,
      status: session.status,
      outputsAvailable: session.status === "idle",
      completedAt: session.lastActivityAt ?? this.now(),
    };
    this.appendEntry(DELEGATION_CUSTOM_TYPE, data);
  }

  /** Test/inspect helper — has the start marker been appended? */
  hasStarted(sessionId: string): boolean {
    return this.started.has(sessionId);
  }

  /** Test/inspect helper — has the completion marker been appended? */
  hasCompleted(sessionId: string): boolean {
    return this.completed.has(sessionId);
  }
}
