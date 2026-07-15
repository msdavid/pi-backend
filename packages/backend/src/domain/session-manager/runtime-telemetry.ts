/**
 * Per-turn OTEL span tracker (WP-8.1) — extracted from {@link ManagedSessionRuntime}.
 *
 * Owns the `pi.model.request` + `pi.tool.<name>` spans that bracket PAIRS of Pi events
 * (`turn_start`/`turn_end`, `tool_execution_start`/`tool_execution_end`). Because each span
 * covers a pair of separate callbacks it uses `startSpan` + an explicit `end()` rather than
 * `withSpan` (whose scope is a single function). The parent is threaded through the turn
 * span set via {@link setTurnSpan}, which is what makes the tree turn → model request → tool
 * nest correctly.
 *
 * The runtime composes one, sets the turn span at the top of each turn, and forwards the Pi
 * lifecycle events; usage/budget accounting stays in the runtime (it is business logic, not
 * telemetry).
 */

import type { Context, Span } from "@opentelemetry/api";
import {
  startSpan,
  contextWithSpan,
  recordModelRequestDuration,
  SpanNames,
  SpanAttrs,
  toolSpanName,
} from "../../infra/telemetry/conventions.js";

export class TurnSpanTracker {
  private turnCtx: Context | undefined;
  private modelSpan: Span | undefined;
  private modelStartedAt = 0;
  private readonly toolSpans = new Map<string, Span>();

  /** @param sessionAttrs supplies the session/tenant attribute pair for every span. */
  constructor(private readonly sessionAttrs: () => Record<string, string>) {}

  /** Set the current turn's span as the parent for model/tool spans opened this turn. */
  setTurnSpan(span: Span): void {
    this.turnCtx = contextWithSpan(span);
  }

  /** Open `pi.model.request` on Pi `turn_start`. */
  startModel(): void {
    this.endModel(); // defensive: a `turn_start` without its `turn_end`
    this.modelStartedAt = Date.now();
    this.modelSpan = startSpan(
      SpanNames.MODEL_REQUEST,
      { attributes: this.sessionAttrs() },
      this.turnCtx,
    );
  }

  /**
   * Close `pi.model.request` on Pi `turn_end`, stamping the model name and recording the
   * `pi.model.request.duration` histogram observation.
   */
  endModel(event?: { [k: string]: unknown }): void {
    const span = this.modelSpan;
    if (!span) return;
    this.modelSpan = undefined;
    const message = event?.message as { model?: string } | undefined;
    const model = message?.model;
    if (model) span.setAttribute(SpanAttrs.MODEL_NAME, model);
    const durationMs = Date.now() - this.modelStartedAt;
    span.end();
    recordModelRequestDuration(durationMs, {
      ...this.sessionAttrs(),
      ...(model ? { [SpanAttrs.MODEL_NAME]: model } : {}),
    });
  }

  /** Open `pi.tool.<name>` on Pi `tool_execution_start`, keyed by `toolCallId`. */
  startTool(tool: string, event: { [k: string]: unknown }): void {
    const key = String(event.toolCallId ?? tool);
    // The tool executes inside the model request that asked for it, so parent to the open
    // model span when there is one; else fall back to the turn.
    const parent = this.modelSpan
      ? contextWithSpan(this.modelSpan, this.turnCtx)
      : this.turnCtx;
    this.toolSpans.set(
      key,
      startSpan(
        toolSpanName(tool),
        { attributes: { ...this.sessionAttrs(), [SpanAttrs.TOOL_NAME]: tool } },
        parent,
      ),
    );
  }

  /** Close the `pi.tool.<name>` span on Pi `tool_execution_end`. */
  endTool(event: { [k: string]: unknown }): void {
    const key = String(event.toolCallId ?? event.toolName ?? "unknown");
    const span = this.toolSpans.get(key);
    if (!span) return;
    this.toolSpans.delete(key);
    if (event.isError === true) span.setStatus({ code: 2 /* ERROR */ });
    span.end();
  }

  /** End every span still open for the current turn (settle / interrupt / dispose). */
  endAll(): void {
    for (const span of this.toolSpans.values()) span.end();
    this.toolSpans.clear();
    this.endModel();
  }
}
