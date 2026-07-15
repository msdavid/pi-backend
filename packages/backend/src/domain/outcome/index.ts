/**
 * Outcome domain (WP-3.2, §16).
 *
 * `user.define_outcome` → outcome service (one-at-a-time) → iteration loop
 * (produce → grade → feedback) → result taxonomy (§16.5). The grader is a separate
 * `AgentSession` with its own context + rubric, reading `/mnt/session/outputs/`
 * (§16.1). Deliverables are fetched through the Files API scoped to the session once
 * idle (§16.6 — reused from WP-1.12's `listSessionOutputs` / `downloadSessionOutput`).
 *
 * Events: `span.outcome_evaluation_start`/`end` per pass + terminal
 * `session.outcome_evaluation_ended` (chainable, §16.5).
 */

export {
  defineOutcome,
  listOutcomes,
  cancelOutcome,
  expireStaleOutcomes,
  fetchActiveOutcomeRow,
  fetchOutcomeRow,
  updateOutcomeStatus,
  toOutcome,
  isTerminalResult,
  outcomeTimeoutMs,
  DEFAULT_MAX_ITERATIONS,
  MAX_MAX_ITERATIONS,
  DEFAULT_OUTCOME_TIMEOUT_MS,
  type DefineOutcomeInput,
  type ListOutcomesOptions,
  type OutcomeRow,
} from "./outcome.js";

export {
  runOutcomeLoop,
  FakeProducer,
  type OutcomeProducer,
  type OutcomeLoopDeps,
} from "./iteration.js";

export {
  createOutcomeRunner,
  cancelOutcomeRun,
  RuntimeOutcomeProducer,
  type OutcomeRunner,
  type OutcomeRunnerDeps,
} from "./runner.js";

export {
  PiGraderSessionFactory,
  type PiGraderSessionFactoryDeps,
} from "./grader-session-factory.js";

export {
  SubagentGrader,
  SandboxOutputsResolver,
  AssistantTextCollector,
  FakeGrader,
  OutcomeGradeAborted,
  parseVerdict,
  type Grader,
  type GradeInput,
  type GraderEvaluation,
  type GraderOutputs,
  type GraderOutputsResolver,
  type GraderSessionFactory,
} from "./grader.js";

export {
  emitOutcomeEvaluationStart,
  emitOutcomeEvaluationEnd,
  emitOutcomeSessionEnded,
  type OutcomeEventSink,
  type CriterionVerdict,
} from "./events.js";

/** Resolve a file-rubric's content for the grader (§16.2 — reused from WP-3.5). */
export {
  getRubricFileContent,
  isRubricFileRef,
  type RubricFileRef,
} from "../file/rubric-ref.js";
