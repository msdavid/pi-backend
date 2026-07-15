/**
 * Managed-session state machine (§6.3, docs/decisions.md item 7).
 *
 * `idle → running → rescheduling → terminated` with `StopReason`s
 * (`requires_action`, `budget_exhausted`, `user_interrupt`, `error`, `completed`).
 *
 * - `idle` — awaiting input; sandbox checkpointed (idle policy may stop it).
 * - `running` — executing a turn (a `prompt()` is in flight).
 * - `rescheduling` — transient retry in progress (3 retries, backoff 1s→4s→16s;
 *   decisions.md item 7). After the 3rd failed retry → `terminated` (`error`).
 * - `terminated` — unrecoverable.
 *
 * The runtime drives this machine; Pi's *internal* auto-retry (sdk.md
 * `auto_retry_*`) is separate and configured via `SettingsManager` — it retries
 * within a single `prompt()`. The backend `rescheduling` state retries the whole
 * turn invocation when `prompt()` rejects with a transient failure.
 *
 * Pure + synchronous (no I/O) so it is trivially property-testable. Injectable clock
 * only to stamp transition times.
 */

import type { StopReason } from "@pi-managed/contracts";
import type { SessionStatus } from "../ports.js";

/** Number of backend retries before terminating (decisions.md item 7). */
export const MAX_RETRIES = 3;

/** Exponential backoff delays in ms: 1s → 4s → 16s (decisions.md item 7). */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 4_000, 16_000];

/** Outcome of {@link SessionStateMachine.scheduleRetry}. */
export interface RetrySchedule {
  /** Delay to wait before the next attempt (ms). */
  delayMs: number;
  /** 1-based attempt number about to run. */
  attempt: number;
}

/** A recorded state transition (for audit / assertions). */
export interface StateTransition {
  from: SessionStatus;
  to: SessionStatus;
  stopReason?: StopReason;
  attempt?: number;
  at: Date;
}

/** Injectable clock (deterministic tests). */
export interface StateMachineClock {
  now(): Date;
}

/**
 * Synchronous managed-session state machine. The runtime owns one instance per session.
 */
export class SessionStateMachine {
  private _status: SessionStatus = "idle";
  private _stopReason: StopReason | undefined;
  private _retryCount = 0;
  private readonly _transitions: StateTransition[] = [];
  private readonly _blockingEventIds: string[] = [];
  private readonly now: () => Date;

  constructor(opts: { clock?: StateMachineClock } = {}) {
    this.now = opts.clock?.now ?? (() => new Date());
  }

  // -- reads ----------------------------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }
  get stopReason(): StopReason | undefined {
    return this._stopReason;
  }
  get retryCount(): number {
    return this._retryCount;
  }
  get transitions(): readonly StateTransition[] {
    return this._transitions;
  }
  get blockingEventIds(): readonly string[] {
    return this._blockingEventIds;
  }
  /** True once a terminal stop reason has been set (idle w/ a reason or terminated). */
  get hasStopReason(): boolean {
    return this._stopReason !== undefined;
  }

  // -- transitions ----------------------------------------------------------

  /** Begin a turn: idle/rescheduling → running. Clears any prior stop reason. */
  start(): void {
    this.assertCanStart();
    this._stopReason = undefined;
    this._blockingEventIds.length = 0;
    this.transition("running");
  }

  /** Turn completed normally → idle (`completed`, or a caller-supplied reason). */
  complete(stopReason: StopReason = "completed"): void {
    this._retryCount = 0;
    this.transition("idle", stopReason);
  }

  /** User interrupted the turn → idle (`user_interrupt`). */
  interrupt(): void {
    this._retryCount = 0;
    this.transition("idle", "user_interrupt");
  }

  /** Budget cap breached → idle (`budget_exhausted`, §6.3). */
  budgetExhausted(): void {
    this._retryCount = 0;
    this.transition("idle", "budget_exhausted");
  }

  /** Turn paused awaiting a client action (tool confirmation / custom-tool result). */
  requiresAction(blockingEventIds?: string[]): void {
    this._retryCount = 0;
    if (blockingEventIds) {
      this._blockingEventIds.length = 0;
      this._blockingEventIds.push(...blockingEventIds);
    }
    this.transition("idle", "requires_action");
  }

  /**
   * Transient failure: schedule a backend retry. Returns the delay + attempt, or
   * `null` if retries are exhausted (in which case the machine is now `terminated`).
   */
  scheduleRetry(): RetrySchedule | null {
    if (this._retryCount >= MAX_RETRIES) {
      this.transition("terminated", "error");
      return null;
    }
    const delayMs = RETRY_BACKOFF_MS[this._retryCount] ?? RETRY_BACKOFF_MS[MAX_RETRIES - 1];
    this._retryCount += 1;
    this.transition("rescheduling", undefined, this._retryCount);
    return { delayMs, attempt: this._retryCount };
  }

  /** Reset the retry counter (after a successful resume from a retry). */
  resetRetries(): void {
    this._retryCount = 0;
  }

  /** Unrecoverable failure → `terminated`. */
  terminate(reason: StopReason = "error"): void {
    this.transition("terminated", reason);
  }

  // -- internals ------------------------------------------------------------

  private assertCanStart(): void {
    if (this._status === "terminated") {
      throw new Error("SessionStateMachine: cannot start a terminated session");
    }
  }

  private transition(
    to: SessionStatus,
    stopReason?: StopReason,
    attempt?: number,
  ): void {
    const from = this._status;
    // `terminated` is terminal — no API call can move a terminated session.
    if (from === "terminated" && to !== "terminated") {
      return;
    }
    if (to === "running") this._stopReason = undefined;
    else if (stopReason !== undefined) this._stopReason = stopReason;
    this._status = to;
    this._transitions.push({ from, to, stopReason, attempt, at: this.now() });
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (property tests)
// ---------------------------------------------------------------------------

/**
 * The set of legal `(from, to)` transitions. `rescheduling` may go to `running`
 * (retry attempt) or `terminated` (exhausted); `terminated` is terminal.
 */
export const LEGAL_TRANSITIONS: ReadonlyArray<
  readonly [SessionStatus, SessionStatus]
> = [
  ["idle", "running"],
  ["running", "idle"],
  ["running", "rescheduling"],
  ["running", "terminated"],
  ["rescheduling", "running"],
  ["rescheduling", "idle"],
  ["rescheduling", "terminated"],
  ["idle", "terminated"],
] as const;

/** True iff `(from, to)` is a legal machine transition. */
export function isLegalTransition(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** Legal `StopReason` values for each terminal-ish target status. */
export const STOP_REASONS_FOR: Readonly<Record<string, readonly StopReason[]>> = {
  idle: ["completed", "user_interrupt", "budget_exhausted", "requires_action", "error"],
  terminated: ["error", "completed", "budget_exhausted", "user_interrupt"],
} as const;
