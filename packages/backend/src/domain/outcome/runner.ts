/**
 * Composition-root outcome runner (§16, R2.3 + R6.3).
 *
 * Adapts {@link runOutcomeLoop} into the `(tenantCtx, sessionId, outcomeId) => Promise<void>`
 * shape the Outcomes API route + the `user.define_outcome` inbound handler invoke. It:
 *
 * 1. loads the persisted outcome row (description, rubric, `maxIterations`);
 * 2. resolves the rubric text (inline text, or a fetched file rubric, §16.2);
 * 3. builds the production {@link RuntimeOutcomeProducer} — it drives the REAL session
 *    runtime: each `produce` sends a `user.message` (the outcome description on the first
 *    call, the grader's feedback thereafter) via `runtime.sendEvent` and awaits the turn's
 *    settlement (the runtime resolves `sendEvent` only once the turn settles), while a
 *    background read of the session's outbound stream watches for a `user.interrupt`
 *    (§16.5);
 * 4. runs the produce → grade → feedback loop against the injected {@link Grader}, under a
 *    wall-clock timeout + a cancellable `AbortController` registered per outcome (R6.3 —
 *    a never-settling loop must not leave the row `active`, which would 409-block every
 *    future outcome on that session).
 *
 * `FakeProducer` (iteration.ts) is a TEST double only — it is never on this path.
 */

import type { Pool, TenantCtx } from "../../infra/db/index.js";
import type { ObjectStore, OutboundEvent, SessionRuntime } from "../ports.js";
import { fetchOutcomeRow, outcomeTimeoutMs } from "./outcome.js";
import { runOutcomeLoop, type OutcomeProducer } from "./iteration.js";
import type { Grader } from "./grader.js";
import type { OutcomeEventSink } from "./events.js";
import { getRubricFileContent } from "../file/rubric-ref.js";

/** Dependencies for {@link createOutcomeRunner}. */
export interface OutcomeRunnerDeps {
  pool: Pool;
  objectStore: ObjectStore;
  /** Resolve the live session runtime (wakes it if needed). */
  resolveRuntime: (sessionId: string) => Promise<SessionRuntime>;
  /** The grader that evaluates deliverables against the rubric (§16.4). */
  grader: Grader;
  /** Sink for `span.outcome_evaluation_*` / `session.outcome_evaluation_ended`. Optional. */
  events?: OutcomeEventSink;
  /** Wall-clock cap per outcome loop (ms). Defaults to `OUTCOME_TIMEOUT_MS` (30 min). */
  timeoutMs?: number;
}

/** The runner signature the Outcomes route + `define_outcome` handler call. */
export type OutcomeRunner = (
  tenantCtx: TenantCtx,
  sessionId: string,
  outcomeId: string,
) => Promise<void>;

/**
 * In-flight outcome loops, keyed by outcome id (R6.3). The cancel route aborts through
 * this registry; the aborted loop then finalizes `interrupted` instead of hanging on
 * `active`.
 */
const inFlight = new Map<string, AbortController>();

/**
 * Cancel a running outcome loop (R6.3). Returns `true` if a loop was in flight in this
 * process. The DB row is finalized by the aborted loop itself; the cancel route ALSO
 * persists a terminal status (`cancelOutcome`) so a row that was never driven — or whose
 * loop died with the process — still lands terminal and stops 409-blocking the session.
 */
export function cancelOutcomeRun(outcomeId: string): boolean {
  const controller = inFlight.get(outcomeId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Build the outcome runner from its collaborators. */
export function createOutcomeRunner(deps: OutcomeRunnerDeps): OutcomeRunner {
  const events: OutcomeEventSink = deps.events ?? { emit: () => {} };
  return async (tenantCtx, sessionId, outcomeId) => {
    const row = await fetchOutcomeRow(deps.pool, tenantCtx, outcomeId);
    if (!row) return;

    const rubricText =
      row.rubric.type === "text"
        ? row.rubric.content
        : (
            await getRubricFileContent(
              deps.pool,
              tenantCtx,
              deps.objectStore,
              row.rubric.fileId,
            )
          ).content;

    const producer = new RuntimeOutcomeProducer(
      deps.resolveRuntime,
      sessionId,
      row.description,
    );
    const controller = new AbortController();
    inFlight.set(outcomeId, controller);

    try {
      await runOutcomeLoop({
        pool: deps.pool,
        tenantCtx,
        sessionId,
        outcomeId,
        maxIterations: row.max_iterations,
        description: row.description,
        rubricText,
        producer,
        grader: deps.grader,
        events,
        timeoutMs: deps.timeoutMs ?? outcomeTimeoutMs(),
        signal: controller.signal,
      });
    } finally {
      inFlight.delete(outcomeId);
    }
  };
}

/**
 * The production {@link OutcomeProducer}: drives the real session runtime.
 *
 * - `produce()` sends a `user.message` (description first, grader feedback thereafter)
 *   through `SessionRuntime.sendEvent` and awaits it — the runtime resolves `sendEvent`
 *   only after the turn settles (idle / terminated), so the grader never reads a
 *   half-written `/mnt/session/outputs/`.
 * - a background read of `SessionRuntime.subscribe()` flips {@link wasInterrupted} and
 *   fires {@link interruptSignal} when the session settles with `stopReason:
 *   "user_interrupt"` (how the runtime reports `user.interrupt`) — that signal also
 *   cancels a grade already in flight (§16.5, R6.3).
 */
export class RuntimeOutcomeProducer implements OutcomeProducer {
  private interrupted = false;
  private readonly controller = new AbortController();
  private stream: AsyncIterator<OutboundEvent> | undefined;
  private disposed = false;

  constructor(
    private readonly resolveRuntime: (sessionId: string) => Promise<SessionRuntime>,
    private readonly sessionId: string,
    private readonly description: string,
  ) {}

  async produce(feedback?: string): Promise<void> {
    const runtime = await this.resolveRuntime(this.sessionId);
    this.watch(runtime);
    const content = feedback ?? this.description;
    await runtime.sendEvent({
      type: "user.message",
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      payload: { content },
    });
  }

  wasInterrupted(): boolean {
    return this.interrupted;
  }

  interruptSignal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    this.disposed = true;
    void this.stream?.return?.(undefined);
    this.stream = undefined;
  }

  /** Attach the interrupt watcher once (idempotent across produce calls). */
  private watch(runtime: SessionRuntime): void {
    if (this.stream || this.disposed) return;
    const iterator = runtime.subscribe()[Symbol.asyncIterator]();
    this.stream = iterator;
    void (async () => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          if (isInterrupt(next.value)) {
            this.interrupted = true;
            if (!this.controller.signal.aborted) this.controller.abort();
            return;
          }
        }
      } catch {
        /* the stream closed under us (runtime disposed) — nothing left to observe */
      }
    })();
  }
}

/** True when an outbound event reports the turn settled on a `user.interrupt` (§9.2). */
function isInterrupt(event: OutboundEvent): boolean {
  if (event.type !== "session.status_idle") return false;
  const stopReason = (event.payload as { stopReason?: unknown } | undefined)?.stopReason;
  return stopReason === "user_interrupt";
}
