/**
 * Conventions module tests (WP-5.4). Verifies span-name derivation + metric
 * recording are no-op-safe when no SDK/MeterProvider is registered (the default
 * in tests) — i.e. the helpers never throw and return the expected names.
 */

import { describe, it, expect } from "vitest";
import {
  SpanNames,
  MetricNames,
  MetricInstruments,
  SpanAttrs,
  toolSpanName,
  getTracer,
  startSpan,
  withSpan,
  recordTokenUsage,
  recordModelRequestDuration,
  RESOURCE,
  SCOPE,
} from "./conventions.js";

describe("telemetry conventions", () => {
  it("uses the pi.<domain>.<action> span-name scheme", () => {
    expect(SpanNames.MODEL_REQUEST).toBe("pi.model.request");
    expect(SpanNames.SESSION_TURN).toBe("pi.session.turn");
    expect(SpanNames.SANDBOX_PROVISION).toBe("pi.sandbox.provision");
    expect(SpanNames.TOOL).toBe("pi.tool");
  });

  it("derives a sanitized tool span name", () => {
    expect(toolSpanName("bash")).toBe("pi.tool.bash");
    expect(toolSpanName("Read_File")).toBe("pi.tool.read_file");
    expect(toolSpanName("mcp__github__create_issue")).toBe(
      "pi.tool.mcp__github__create_issue",
    );
    expect(toolSpanName("")).toBe("pi.tool.unknown");
    expect(toolSpanName("UPPER!Case")).toBe("pi.tool.upper-case");
  });

  it("uses the pi.<domain>.<measure> metric-name scheme", () => {
    expect(MetricNames.TOKENS_INPUT).toBe("pi.tokens.input");
    expect(MetricNames.COST_USD).toBe("pi.cost.usd");
    expect(MetricNames.SESSIONS_ACTIVE).toBe("pi.sessions.active");
    expect(MetricNames.SANDBOXES_RUNNING).toBe("pi.sandboxes.running");
  });

  it("declares an instrument kind per metric", () => {
    expect(MetricInstruments[MetricNames.TOKENS_INPUT]).toBe("counter");
    expect(MetricInstruments[MetricNames.MODEL_REQUEST_DURATION]).toBe(
      "histogram",
    );
    expect(MetricInstruments[MetricNames.SESSIONS_ACTIVE]).toBe(
      "up_down_counter",
    );
  });

  it("defines stable span-attribute keys", () => {
    expect(SpanAttrs.SESSION_ID).toBe("session.id");
    expect(SpanAttrs.MODEL_NAME).toBe("pi.model.name");
    expect(SpanAttrs.TOOL_NAME).toBe("pi.tool.name");
  });

  it("exposes resource + scope defaults", () => {
    expect(RESOURCE.SERVICE_NAME_DEFAULT).toBe("pi-managed-backend");
    expect(SCOPE.TRACER_NAME).toBe("pi-managed-backend");
  });

  it("returns a (no-op) tracer without throwing", () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
    // startSpan on the no-op tracer must not throw.
    const span = startSpan(SpanNames.SESSION_WAKE);
    expect(() => span.end()).not.toThrow();
  });

  it("runs withSpan, ends the span, and propagates the result + error", async () => {
    const result = await withSpan(SpanNames.SESSION_TURN, async (span) => {
      span.setAttribute(SpanAttrs.SESSION_ID, "sess_123");
      return "ok";
    });
    expect(result).toBe("ok");

    await expect(
      withSpan(SpanNames.SESSION_TURN, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("records token usage + duration as no-ops without a MeterProvider", () => {
    expect(() =>
      recordTokenUsage("claude-3-5-sonnet", {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        usd: 0.012,
      }),
    ).not.toThrow();
    expect(() => recordModelRequestDuration(1234)).not.toThrow();
  });
});
