/**
 * Outcome iteration loop (WP-3.2, §16.1/§16.5).
 *
 * The core produce → grade → feedback loop. The **producer** drives the main agent
 * toward the outcome (sends the outcome description / feedback as a `user.message`
 * or steer); the **grader** (a separate `AgentSession`, `grader.ts`) evaluates the
 * deliverables against the rubric. Results follow the §16.5 taxonomy:
 *
 * - `satisfied` — rubric met → idle (terminal).
 * - `needs_revision` — rubric not yet met → new iteration (feedback handed back).
 * - `max_iterations_reached` — all iterations exhausted → ONE final revision, then
 *   idle (terminal).
 * - `failed` — the rubric does not match the deliverables at all → idle (terminal).
 * - `interrupted` — a `user.interrupt` arrived before a grade completed → idle
 *   (terminal). Only set if evaluation started before the interrupt (§16.5).
 *
 * After a terminal result the session is idle and a new `user.define_outcome` may be
 * sent (chainable, §16.5). The loop emits `span.outcome_evaluation_*` per pass and a
 * terminal `session.outcome_evaluation_ended` (see `events.ts`).
 */

import type { Pool, TenantCtx } from "../../infra/db/index.js";
import type { OutcomeResult } from "@pi-managed/contracts";
import {
  fetchOutcomeRow,
  outcomeTimeoutMs,
  updateOutcomeStatus,
} from "./outcome.js";
import type { Grader } from "./grader.js";
import {
  emitOutcomeEvaluationEnd,
  emitOutcomeEvaluationStart,
  emitOutcomeSessionEnded,
  type OutcomeEventSink,
} from "./events.js";

/**
 * Drives the main agent toward the outcome (the "produce" step). The first call
 * carries no feedback (the agent has the outcome description from the define event);
 * subsequent calls hand back the grader's feedback. The real impl resolves the
 * session runtime and sends a `user.message` / steer; tests use a fake.
 */
export interface OutcomeProducer {
  /** Produce work toward the outcome, optionally incorporating prior feedback. */
  produce(feedback?: string): Promise<void>;
  /** True if a `user.interrupt` arrived before the current grade completed (§16.5). */
  wasInterrupted(): boolean;
  /**
   * An `AbortSignal` that fires when a `user.interrupt` lands on the session stream
   * (R6.3). Optional: without it an interrupt is only observed between produce and
   * grade; with it an in-flight grade is cancelled too. Released by {@link dispose}.
   */
  interruptSignal?(): AbortSignal | undefined;
  /** Release any stream subscription held by the producer. */
  dispose?(): void;
}

/** Dependencies for {@link runOutcomeLoop}. */
export interface OutcomeLoopDeps {
  pool: Pool;
  tenantCtx: TenantCtx;
  sessionId: string;
  outcomeId: string;
  maxIterations: number;
  description: string;
  /** Resolved rubric text (text rubric, or fetched file-rubric content). */
  rubricText: string;
  producer: OutcomeProducer;
  grader: Grader;
  events: OutcomeEventSink;
  /**
   * Wall-clock cap for the whole loop (R6.3). On expiry the loop finalizes `failed`
   * rather than leaving the row `active` forever — an `active` row 409-blocks every
   * future outcome on the session (§16.5 one-at-a-time). Defaults to
   * {@link outcomeTimeoutMs}; `0` disables the cap.
   */
  timeoutMs?: number;
  /** Explicit cancel (R6.3). Aborting finalizes the outcome `interrupted`. */
  signal?: AbortSignal;
}

/**
 * Run the iteration loop for an active outcome. Persists status/result/iteration
 * transitions and emits the evaluation events. Returns the terminal result.
 *
 * The outcome must be `active` when this is called; on return it is terminal
 * (`satisfied` | `max_iterations_reached` | `failed` | `interrupted`).
 */
export async function runOutcomeLoop(deps: OutcomeLoopDeps): Promise<OutcomeResult> {
  const cancel = new LoopCancellation(deps);
  try {
    return await runPasses(deps, cancel);
  } catch (err) {
    if (err instanceof LoopAborted) {
      // Timeout / explicit cancel / interrupt (R6.3): terminal, never left `active`.
      await finalize(deps.pool, deps.tenantCtx, deps.outcomeId, err.result, err.iteration, deps);
      return err.result;
    }
    // A crashed loop must still land terminal — an `active` row 409-blocks the session
    // forever (§16.5). Record `failed`, then re-raise for the caller's logging.
    await finalizeQuietly(deps, "failed", cancel.pass);
    throw err;
  } finally {
    cancel.dispose();
    deps.producer.dispose?.();
  }
}

/** The produce → grade → feedback passes. Aborts surface as {@link LoopAborted}. */
async function runPasses(
  deps: OutcomeLoopDeps,
  cancel: LoopCancellation,
): Promise<OutcomeResult> {
  const { pool, tenantCtx, outcomeId, maxIterations, description, rubricText } = deps;

  const outcome = await fetchOutcomeRow(pool, tenantCtx, outcomeId);
  if (!outcome) {
    throw new Error(`runOutcomeLoop: outcome not found: ${outcomeId}`);
  }
  if (outcome.status !== "active" && outcome.status !== "needs_revision") {
    throw new Error(
      `runOutcomeLoop: outcome ${outcomeId} is not active (status=${outcome.status})`,
    );
  }

  let feedback: string | undefined;
  let result: OutcomeResult = "needs_revision";

  for (let pass = 1; pass <= maxIterations; pass++) {
    cancel.pass = pass;
    cancel.throwIfAborted();

    // --- produce (raced: a hung session must not pin the row on `active`, R6.3) ---
    await cancel.race(deps.producer.produce(feedback));
    await updateOutcomeStatus(pool, tenantCtx, outcomeId, {
      status: "active",
      iteration: pass,
    });

    // --- interrupt check (§16.5: interrupted only if evaluation started before interrupt) ---
    cancel.throwIfAborted();
    if (deps.producer.wasInterrupted()) {
      result = "interrupted";
      await finalize(pool, tenantCtx, outcomeId, result, pass, deps);
      return result;
    }

    // --- grade (cancellable: an interrupt / timeout aborts the in-flight grade, R6.3) ---
    emitOutcomeEvaluationStart(deps.events, { sessionId: deps.sessionId, outcomeId }, pass - 1);
    const evaluation = await cancel.race(
      deps.grader.evaluate({
        tenantCtx,
        sessionId: deps.sessionId,
        outcomeId,
        iteration: pass - 1,
        description,
        rubricText,
        signal: cancel.signal,
      }),
    );
    emitOutcomeEvaluationEnd(
      deps.events,
      { sessionId: deps.sessionId, outcomeId },
      pass - 1,
      evaluation.verdict,
      evaluation.criteria,
      evaluation.feedback,
    );

    // --- failed (rubric doesn't match) → idle (§16.5) ---
    if (evaluation.failed) {
      result = "failed";
      await finalize(pool, tenantCtx, outcomeId, result, pass, deps);
      return result;
    }

    // --- satisfied → idle (§16.5) ---
    if (evaluation.verdict === "satisfied") {
      result = "satisfied";
      await finalize(pool, tenantCtx, outcomeId, result, pass, deps);
      return result;
    }

    // --- needs_revision ---
    feedback = evaluation.feedback;
    if (pass < maxIterations) {
      // New iteration: record the revision request, hand feedback back to producer.
      await updateOutcomeStatus(pool, tenantCtx, outcomeId, {
        status: "needs_revision",
        result: "needs_revision",
        iteration: pass,
      });
      continue;
    }

    // max iterations reached → one final revision, then idle (§16.5).
    cancel.throwIfAborted();
    await cancel.race(deps.producer.produce(feedback));
    result = "max_iterations_reached";
    await finalize(pool, tenantCtx, outcomeId, result, maxIterations, deps);
    return result;
  }

  // Defensive: loop exited without a terminal result (should not happen — the last
  // pass always returns max_iterations_reached). Treat as max_iterations_reached.
  result = "max_iterations_reached";
  await finalize(pool, tenantCtx, outcomeId, result, maxIterations, deps);
  return result;
}

// ---------------------------------------------------------------------------
// Cancellation: timeout + explicit cancel + interrupt (R6.3)
// ---------------------------------------------------------------------------

/** Internal: an abort won the race. Carries the terminal result to persist. */
class LoopAborted extends Error {
  constructor(
    readonly result: OutcomeResult,
    readonly iteration: number,
  ) {
    super(`outcome loop aborted: ${result}`);
    this.name = "LoopAborted";
  }
}

/**
 * Owns the loop's abort surface: the deadline timer, the caller's cancel signal, and
 * the producer's interrupt signal — merged into one {@link AbortSignal} handed to the
 * grader, so a grade in flight is cancellable (not just checked between passes).
 */
class LoopCancellation {
  /** Current 1-based pass (recorded on the terminal row when an abort wins). */
  pass = 1;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly cleanups: (() => void)[] = [];
  private reason: OutcomeResult | undefined;

  constructor(deps: OutcomeLoopDeps) {
    const timeout = deps.timeoutMs ?? outcomeTimeoutMs();
    if (timeout > 0) {
      this.timer = setTimeout(() => this.abort("failed"), timeout);
      this.timer.unref?.();
    }
    this.link(deps.signal, "interrupted");
    this.link(deps.producer.interruptSignal?.(), "interrupted");
  }

  private link(signal: AbortSignal | undefined, result: OutcomeResult): void {
    if (!signal) return;
    if (signal.aborted) {
      this.abort(result);
      return;
    }
    const onAbort = (): void => this.abort(result);
    signal.addEventListener("abort", onAbort, { once: true });
    this.cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }

  private abort(result: OutcomeResult): void {
    if (this.controller.signal.aborted) return;
    this.reason = result;
    this.controller.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Throw if an abort already landed (checked at each loop boundary). */
  throwIfAborted(): void {
    if (this.controller.signal.aborted) {
      throw new LoopAborted(this.reason ?? "interrupted", this.pass);
    }
  }

  /** Race `work` against the abort — an interrupt cancels a grade already in flight. */
  async race<T>(work: Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) {
      void work.catch(() => {});
      throw new LoopAborted(this.reason ?? "interrupted", this.pass);
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(new LoopAborted(this.reason ?? "interrupted", this.pass));
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } catch (err) {
      if (err instanceof LoopAborted) {
        void work.catch(() => {});
        throw err;
      }
      // A grader that rejects BECAUSE of the abort (it wired the signal to
      // `AgentSession.abort()`) must not be mistaken for a crash — its rejection can win
      // the race, since its abort listener was registered before ours.
      if (this.controller.signal.aborted) {
        throw new LoopAborted(this.reason ?? "interrupted", this.pass);
      }
      throw err;
    } finally {
      if (onAbort) this.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }
}

/** Finalize without letting a second failure mask the original error (crash path). */
async function finalizeQuietly(
  deps: OutcomeLoopDeps,
  result: OutcomeResult,
  iteration: number,
): Promise<void> {
  try {
    await finalize(deps.pool, deps.tenantCtx, deps.outcomeId, result, iteration, deps);
  } catch {
    /* the original error is the interesting one */
  }
}

/** Persist the terminal status/result + emit the terminal session event. */
async function finalize(
  pool: Pool,
  tenantCtx: TenantCtx,
  outcomeId: string,
  result: OutcomeResult,
  iteration: number,
  deps: OutcomeLoopDeps,
): Promise<void> {
  await updateOutcomeStatus(pool, tenantCtx, outcomeId, {
    status: result,
    result,
    iteration,
  });
  emitOutcomeSessionEnded(
    deps.events,
    { sessionId: deps.sessionId, outcomeId },
    result,
    iteration,
  );
}

// ---------------------------------------------------------------------------
// Fakes for tests (FakeProducer) + a producer adapter over a runtime sendEvent.
// ---------------------------------------------------------------------------

/** A scriptable producer for the iteration-loop tests (§29.4 gate slice). */
export class FakeProducer implements OutcomeProducer {
  readonly calls: (string | undefined)[] = [];
  private interrupted = false;
  /** Optional hook to assert on each produce (e.g. to "write" deliverables). */
  onProduce?: (feedback: string | undefined, callIndex: number) => void;

  produce(feedback?: string): Promise<void> {
    this.calls.push(feedback);
    this.onProduce?.(feedback, this.calls.length - 1);
    return Promise.resolve();
  }

  wasInterrupted(): boolean {
    return this.interrupted;
  }

  /** Mark the producer as interrupted (simulates a `user.interrupt`). */
  interrupt(): void {
    this.interrupted = true;
  }
}
