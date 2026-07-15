/**
 * Budget enforcement hook (§6.3). The session manager (WP-1.5) calls this after
 * each `UsageRecorder.record()`; if the session's cumulative usage breaches a
 * `Budget` cap, it returns a `budget_exhausted` stop reason that the manager
 * uses to interrupt the turn and transition to `idle` (§6.3).
 *
 * This module is intentionally thin: the comparison lives in
 * {@link UsageRecorder.checkBudget} so it is testable without the session
 * manager. Here we only translate a breached {@link BudgetCheck} into the
 * stop-reason shape the state machine consumes.
 */

import type { Budget, SessionId, UsageRecorder } from "../ports.js";

/** Stop reason emitted when a budget cap is breached (§6.3). */
export const BUDGET_STOP_REASON = "budget_exhausted" as const;

/** Outcome of {@link enforceBudget}: either clear or a budget-exhausted stop. */
export interface BudgetEnforcement {
  exceeded: boolean;
  /** Present (and `budget_exhausted`) only when `exceeded` (§6.3). */
  stopReason?: typeof BUDGET_STOP_REASON;
  /** Machine-readable sub-reason from the recorder (`max_tokens_exceeded` / `max_usd_exceeded`). */
  reason?: string;
}

/**
 * Check `sessionId` against `budget` via `recorder`. Returns a stop-reason
 * envelope the session manager feeds into the state machine; never throws on a
 * breach (only on DB errors). WP-1.5 wires the resulting interrupt→idle
 * transition; this function only decides whether to fire it.
 */
export async function enforceBudget(
  sessionId: SessionId,
  budget: Budget,
  recorder: UsageRecorder,
): Promise<BudgetEnforcement> {
  const check = await recorder.checkBudget(sessionId, budget);
  if (check.exceeded) {
    return {
      exceeded: true,
      stopReason: BUDGET_STOP_REASON,
      reason: check.reason,
    };
  }
  return { exceeded: false };
}
