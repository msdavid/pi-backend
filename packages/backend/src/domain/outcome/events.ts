/**
 * Outcome evaluation events (WP-3.2, §16.5).
 *
 * The iteration loop emits two span-level events per evaluation pass
 * (`span.outcome_evaluation_start` / `span.outcome_evaluation_end`) and one
 * session-level event when the outcome reaches a terminal result
 * (`session.outcome_evaluation_ended`). After the terminal event a new
 * `user.define_outcome` may be sent (§16.5 — outcomes are chainable).
 *
 * Events are emitted through an {@link OutcomeEventSink} — a thin adapter over the
 * session's outbound stream. The loop owns event ordering; this module only formats.
 */

import type { OutcomeResult } from "@pi-managed/contracts";
import type { OutboundEvent } from "../ports.js";
import { generateEventId, nowIso } from "../event-stream/wire.js";

/**
 * Sink for outcome evaluation events. Implementations forward to the session's
 * outbound stream (SSE / JSONL). The `emit` call is synchronous + non-blocking —
 * a sink that needs to await should buffer internally.
 */
export interface OutcomeEventSink {
  emit(event: OutboundEvent): void;
}

/** A single rubric criterion verdict (part of the evaluation payload). */
export interface CriterionVerdict {
  criterion: string;
  passed: boolean;
  note?: string;
}

/** Payload shared by span/session outcome events (identifies the outcome). */
interface OutcomeEventBase {
  sessionId: string;
  outcomeId: string;
}

/** Emit `span.outcome_evaluation_start` (a grade pass begins). */
export function emitOutcomeEvaluationStart(
  sink: OutcomeEventSink,
  base: OutcomeEventBase,
  iteration: number,
): void {
  sink.emit({
    type: "span.outcome_evaluation_start",
    id: generateEventId(),
    createdAt: nowIso(),
    payload: { ...base, iteration },
  });
}

/** Emit `span.outcome_evaluation_end` (a grade pass completed). */
export function emitOutcomeEvaluationEnd(
  sink: OutcomeEventSink,
  base: OutcomeEventBase,
  iteration: number,
  verdict: "satisfied" | "needs_revision",
  criteria: CriterionVerdict[],
  feedback: string,
): void {
  sink.emit({
    type: "span.outcome_evaluation_end",
    id: generateEventId(),
    createdAt: nowIso(),
    payload: { ...base, iteration, verdict, criteria, feedback },
  });
}

/**
 * Emit `session.outcome_evaluation_ended` — the terminal event. Carries the final
 * {@link OutcomeResult} (§16.5 taxonomy). After this event the session is idle and a
 * new outcome may be defined (chainable, §16.5).
 */
export function emitOutcomeSessionEnded(
  sink: OutcomeEventSink,
  base: OutcomeEventBase,
  result: OutcomeResult,
  iteration: number,
): void {
  sink.emit({
    type: "session.outcome_evaluation_ended",
    id: generateEventId(),
    createdAt: nowIso(),
    payload: { ...base, result, iteration },
  });
}
