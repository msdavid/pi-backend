/**
 * OpenTelemetry SDK wiring (CONVENTIONS.md §3.2; decisions.md §30 item 3, resolved
 * in WP-5.4; production instrumentation wired in WP-8.1).
 *
 * Behaviour:
 * - If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, telemetry is a no-op: the process
 *   runs with the no-op tracer from `@opentelemetry/api`. This keeps local dev
 *   and tests free of an exporter that would block on a missing collector. The
 *   instrumented call sites still call `withSpan`/`record*` — they just resolve to
 *   no-op instruments, so there is no conditional setup anywhere in the domain.
 * - When set, `NodeSDK` is started with an OTLP/HTTP trace exporter pointing at
 *   the configured endpoint. `serviceName` defaults to `pi-managed-backend`.
 *
 * ## Metrics
 *
 * The metric instruments in `conventions.ts` are created from the global
 * `MeterProvider`. Unlike traces, the metrics API has no proxy provider: with no
 * `MeterProvider` registered every instrument is a permanent no-op. `NodeSDK`
 * registers one — with a `PeriodicExportingMetricReader` + the OTLP metric exporter
 * that ships inside `@opentelemetry/sdk-node` (no extra dependency) — when
 * `OTEL_METRICS_EXPORTER` is set. Because a configured collector that silently
 * receives zero metrics is the exact failure this WP closes, we DEFAULT that
 * variable to `otlp` whenever an endpoint is configured and the operator has not
 * chosen otherwise. Set `OTEL_METRICS_EXPORTER=none` to opt out, or `prometheus` /
 * `console` for the other readers `NodeSDK` supports. See `docs/observability.md`.
 *
 * The returned {@link TelemetryHandle} lets the server flush + shut down tracing
 * on graceful exit so buffered spans are exported before the process exits.
 */

import { trace, metrics, type Meter, type Tracer } from "@opentelemetry/api";
import type { Config } from "../config/index.js";
import { RESOURCE, SCOPE } from "./conventions.js";

export interface TelemetryHandle {
  /** A tracer; the no-op tracer when OTEL is disabled. */
  tracer: Tracer;
  /** A meter; the no-op meter when no MeterProvider is registered. */
  meter: Meter;
  /** Flush and shut down the SDK. Safe to call when disabled (no-op). */
  shutdown: () => Promise<void>;
}

/**
 * Initialize telemetry from config. Dynamic import of `@opentelemetry/sdk-node`
 * keeps the (relatively heavy) SDK out of the require graph when OTEL is disabled
 * — important for fast test boot and no collector dependency.
 */
export async function initTelemetry(config: Config): Promise<TelemetryHandle> {
  const endpoint = config.otelExporterOtlpEndpoint;
  if (!endpoint) {
    return {
      tracer: trace.getTracer(SCOPE.TRACER_NAME, SCOPE.VERSION),
      meter: metrics.getMeter(SCOPE.METER_NAME, SCOPE.VERSION),
      shutdown: async () => {},
    };
  }

  // Lazy import so the SDK is only loaded when an exporter is configured.
  const [{ NodeSDK }, { OTLPTraceExporter }] = (await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ])) as [
    { NodeSDK: typeof import("@opentelemetry/sdk-node").NodeSDK },
    { OTLPTraceExporter: typeof import("@opentelemetry/exporter-trace-otlp-http").OTLPTraceExporter },
  ];

  // Metrics are exported only when `OTEL_METRICS_EXPORTER` selects a reader (NodeSDK
  // reads it from the env). An endpoint is configured, so default it to `otlp` rather
  // than leave the operator with a collector that receives spans and no metrics. An
  // explicit value (including `none`) is always honored.
  process.env.OTEL_METRICS_EXPORTER ??= "otlp";

  const serviceName = config.otelServiceName ?? RESOURCE.SERVICE_NAME_DEFAULT;
  const exporter = new OTLPTraceExporter({ url: endpoint });
  const sdk = new NodeSDK({
    traceExporter: exporter,
    serviceName,
    // Resource attributes (pi-managed version, deployment env) are supplied via
    // the OTEL_RESOURCE_ATTRIBUTES env var (config.otelResourceAttributes), which
    // the SDK's default resource detection reads — no extra deps required.
  });

  sdk.start();
  return {
    tracer: trace.getTracer(SCOPE.TRACER_NAME, SCOPE.VERSION),
    meter: metrics.getMeter(SCOPE.METER_NAME, SCOPE.VERSION),
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch {
        // Best-effort; never fail shutdown on telemetry flush.
      }
    },
  };
}
