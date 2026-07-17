/**
 * OTEL span/metric name conventions.
 *
 * ## The decision
 *
 * **Mirror the Pi Agent SDK's OTEL span/metric names where they exist**, and add
 * backend-specific names for managed-only concepts (sessions, sandboxes, jobs,
 * vaults, usage). Rationale documented in `docs/observability.md`.
 *
 * Why mirror: the backend embeds the Pi SDK and surfaces its events on the same
 * SSE stream (`span.model_request_start`/`_end`, `agent.tool_use`, …). Reusing
 * the SDK's span vocabulary keeps traces emitted by the managed runtime and by
 * Pi SDK instrumentations joinable in a single trace tree without name-alias
 * translation. Toolbars, dashboards, and correlation logic written against the
 * SDK work unchanged against managed spans.
 *
 * Why add backend-specific names: the SDK has no notion of managed sessions
 * (registry wake/evict), microsandbox VM lifecycle (provision/exec/checkpoint),
 * scheduled jobs, vaults, or per-tenant usage/cost. These are managed-backend
 * concepts and get their own `pi.<domain>.<action>` names.
 *
 * ## Naming scheme
 *
 * Spans:   `pi.<domain>.<action>`        e.g. `pi.model.request`, `pi.tool.bash`
 * Metrics: `pi.<domain>.<measure>`       e.g. `pi.tokens.input`, `pi.cost.usd`
 *
 * The `pi.` prefix is reserved for this backend and its embedded SDK. Names are
 * lowercase, dot-separated, ASCII. Span attribute keys use the
 * {@link SpanAttrs} constants below (stable contract for dashboards/alerts).
 *
 * ## Usage
 *
 * The helpers ({@link startSpan}, {@link withSpan}, {@link recordTokenUsage})
 * obtain the tracer/meter via `@opentelemetry/api`, which returns no-op
 * instruments when no SDK/MeterProvider is registered (local dev + tests). They
 * are safe to call from any boundary with zero conditional setup.
 *
 * The load-bearing integration points (where these helpers are called) are listed
 * in `docs/observability.md` → "Instrumentation points". As of WP-8.1 the
 * production call sites are wired: session wake/turn (runtime.ts), model requests
 * + tool executions (runtime.ts, from the Pi event stream), sandbox lifecycle
 * (infra/sandbox/provider.ts), scheduler ticks + job runs (domain/scheduler/tick.ts),
 * webhook deliveries (domain/webhook/dispatcher.ts), vault resolution (runtime.ts),
 * and per-tenant token/cost metrics (domain/usage/usage-recorder.ts).
 */

import {
  context,
  metrics,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Resource / instrumentation scope
// ---------------------------------------------------------------------------

export const RESOURCE = {
  /** Default `service.name` for the managed backend process. */
  SERVICE_NAME_DEFAULT: "pi-managed-backend",
} as const;

export const SCOPE = {
  /** Tracer instrumentation-scope name. */
  TRACER_NAME: "pi-managed-backend",
  /** Meter instrumentation-scope name. */
  METER_NAME: "pi-managed-backend",
  /** Instrumentation-scope version (matches the backend package version). */
  VERSION: "0.0.0",
} as const;

// ---------------------------------------------------------------------------
// Span names — mirrors Pi SDK where the concept is shared; backend-specific
// names follow for managed-only domains.
// ---------------------------------------------------------------------------

/**
 * Finalized span names. Each constant is the literal string emitted to the
 * exporter, so dashboards/alerts can match on these exact values.
 */
export const SpanNames = {
  // --- Mirrors the Pi SDK's per-turn / per-model-request vocabulary ---
  /** A single model request (start→end of one `prompt()` turn). */
  MODEL_REQUEST: "pi.model.request",
  /** A single tool execution inside a turn (the suffix is the tool name). */
  TOOL: "pi.tool", // → `pi.tool.<name>` via {@link toolSpanName}

  // --- Backend-specific: managed session lifecycle (§5.2, §6.3) ---
  /** Wake a managed session runtime (load record + ensure sandbox + build AgentSession). */
  SESSION_WAKE: "pi.session.wake",
  /** A full inbound turn (user.message → settled idle). Wraps model-request + retries. */
  SESSION_TURN: "pi.session.turn",
  /** A state-machine transition with a non-default stop reason (§6.3). */
  SESSION_TRANSITION: "pi.session.transition",

  // --- Backend-specific: microsandbox VM lifecycle (§7.1, §10.3) ---
  /** Provision a new microsandbox VM from a compiled spec. */
  SANDBOX_PROVISION: "pi.sandbox.provision",
  /** Start (or cold-reboot from a checkpoint) a stopped/crashed VM. */
  SANDBOX_START: "pi.sandbox.start",
  /** Execute a tool/call inside the sandbox (host-agent side). */
  SANDBOX_EXEC: "pi.sandbox.exec",
  /** Checkpoint + stop an idle VM (§10.3 idle policy). `SandboxProvider.stop()`. */
  SANDBOX_CHECKPOINT: "pi.sandbox.checkpoint",
  /** Snapshot a stopped VM to a content-addressed image (§10.3). */
  SANDBOX_SNAPSHOT: "pi.sandbox.snapshot",
  /** Kill + remove a VM and purge its binding refs (§12.1). */
  SANDBOX_DESTROY: "pi.sandbox.destroy",

  // --- Backend-specific: scheduled jobs (§14) ---
  /** Execute one scheduled job run. */
  JOB_RUN: "pi.job.run",
  /** One scheduler tick — the cross-tenant due-job sweep (§17.8). */
  SCHEDULER_TICK: "pi.scheduler.tick",

  // --- Backend-specific: webhooks (§23) ---
  /** One webhook delivery attempt (HTTPS POST + outcome, §23.5). */
  WEBHOOK_DELIVERY: "pi.webhook.delivery",

  // --- Backend-specific: vault secret resolution (§28) ---
  /** Resolve + register secret bindings for a session. */
  VAULT_RESOLVE: "pi.vault.resolve",
} as const;

// ---------------------------------------------------------------------------
// Metric names
// ---------------------------------------------------------------------------

/**
 * Finalized metric names. Counter/histogram/observable — the instrument kind is
 * noted in {@link MetricInstruments}; the name is what appears in Prometheus.
 */
export const MetricNames = {
  // --- Tokens & cost (source: UsageRecorder.record, §9.7 / §26.2) ---
  /** Input (prompt) tokens per model request — counter. */
  TOKENS_INPUT: "pi.tokens.input",
  /** Output (completion) tokens per model request — counter. */
  TOKENS_OUTPUT: "pi.tokens.output",
  /** Cache-creation (write) input tokens — counter. */
  TOKENS_CACHE_CREATION: "pi.tokens.cache_creation",
  /** Cache-read input tokens — counter. */
  TOKENS_CACHE_READ: "pi.tokens.cache_read",
  /** Total cost in USD per model request — counter (monotonic). */
  COST_USD: "pi.cost.usd",
  /** Model-request latency in ms — histogram. */
  MODEL_REQUEST_DURATION: "pi.model.request.duration",

  // --- Sessions / sandboxes (observability gauges, §26.4) ---
  /** Active (in-registry) managed sessions — observable UpDownCounter. */
  SESSIONS_ACTIVE: "pi.sessions.active",
  /** Running microsandbox VMs — observable UpDownCounter. */
  SANDBOXES_RUNNING: "pi.sandboxes.running",

  // --- Job / webhook outcomes (§17.8, §23.5) ---
  /** Scheduled job runs by outcome (`pi.outcome` = succeeded|failed) — counter. */
  JOB_RUNS: "pi.job.runs",
  /** Webhook delivery attempts by outcome (succeeded|failed|retried) — counter. */
  WEBHOOK_DELIVERIES: "pi.webhook.deliveries",

  // --- microsandbox VM metrics (§26.4: msb-metrics → OTLP → Prometheus) ---
  /** Sandbox VM CPU usage fraction (0..N cores) — gauge. */
  SANDBOX_CPU: "pi.sandbox.cpu",
  /** Sandbox VM RSS memory in bytes — gauge. */
  SANDBOX_MEM: "pi.sandbox.mem",
  /** Sandbox VM disk I/O bytes — counter (read + write tagged). */
  SANDBOX_DISK_IO: "pi.sandbox.disk_io",
  /** Sandbox VM network I/O bytes — counter (rx + tx tagged). */
  SANDBOX_NET_IO: "pi.sandbox.net_io",
  /** Sandbox VM uptime in seconds — gauge. */
  SANDBOX_UPTIME: "pi.sandbox.uptime",
} as const;

/**
 * Instrument kind per metric name. Consumers creating instruments should use
 * this map to pick `createCounter` / `createHistogram` / etc.
 */
export const MetricInstruments = {
  [MetricNames.TOKENS_INPUT]: "counter",
  [MetricNames.TOKENS_OUTPUT]: "counter",
  [MetricNames.TOKENS_CACHE_CREATION]: "counter",
  [MetricNames.TOKENS_CACHE_READ]: "counter",
  [MetricNames.COST_USD]: "counter",
  [MetricNames.MODEL_REQUEST_DURATION]: "histogram",
  [MetricNames.SESSIONS_ACTIVE]: "up_down_counter",
  [MetricNames.SANDBOXES_RUNNING]: "up_down_counter",
  [MetricNames.JOB_RUNS]: "counter",
  [MetricNames.WEBHOOK_DELIVERIES]: "counter",
  [MetricNames.SANDBOX_CPU]: "observable_gauge",
  [MetricNames.SANDBOX_MEM]: "observable_gauge",
  [MetricNames.SANDBOX_DISK_IO]: "counter",
  [MetricNames.SANDBOX_NET_IO]: "counter",
  [MetricNames.SANDBOX_UPTIME]: "observable_gauge",
} as const;

// ---------------------------------------------------------------------------
// Span attribute keys (stable contract for dashboards/alerts)
// ---------------------------------------------------------------------------

export const SpanAttrs = {
  /** `session.id` — the managed session id (`sess_…`). */
  SESSION_ID: "session.id",
  /** `tenant.id` — the owning tenant id (`tnt_…`). */
  TENANT_ID: "tenant.id",
  /** `sandbox.id` — the microsandbox VM handle. */
  SANDBOX_ID: "sandbox.id",
  /** `pi.model.name` — the model id for a model request (e.g. `gpt-…`). */
  MODEL_NAME: "pi.model.name",
  /** `pi.tool.name` — the tool name for a tool-execution span. */
  TOOL_NAME: "pi.tool.name",
  /** `pi.stop_reason` — terminal stop reason for a session transition. */
  STOP_REASON: "pi.stop_reason",
  /** `pi.retry.attempt` — 1-based backend retry attempt (§30 item 7). */
  RETRY_ATTEMPT: "pi.retry.attempt",
  /** `pi.job.id` — the scheduled job (`job_…`) a run belongs to. */
  JOB_ID: "pi.job.id",
  /** `pi.webhook.id` — the webhook a delivery attempt targets. */
  WEBHOOK_ID: "pi.webhook.id",
  /** `pi.event.type` — the domain event type carried by a webhook delivery. */
  EVENT_TYPE: "pi.event.type",
  /** `pi.outcome` — terminal outcome of a job run / webhook delivery. */
  OUTCOME: "pi.outcome",
  /** `http.response.status_code` — OTel semconv; the webhook endpoint's status. */
  HTTP_STATUS_CODE: "http.response.status_code",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a tool-execution span name: `pi.tool.<name>`.
 * `<name>` is sanitized to `[a-z0-9_-]+` (lowercased) so arbitrary tool names
 * (e.g. MCP server tools) cannot break the naming scheme.
 */
export function toolSpanName(toolName: string): string {
  const clean = String(toolName ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${SpanNames.TOOL}.${clean || "unknown"}`;
}

/** The global tracer (no-op when OTEL is disabled). */
export function getTracer(): Tracer {
  return trace.getTracer(SCOPE.TRACER_NAME, SCOPE.VERSION);
}

/**
 * Start a span. Returns the span; the caller must `span.end()` it. When OTEL is
 * disabled this is a no-op span (cheap). Prefer {@link withSpan} for scoped work.
 *
 * `parent` explicitly pins the parent context. It is needed where a span's start
 * and end land in DIFFERENT callbacks (e.g. the Pi `turn_start`/`turn_end` events
 * that bracket `pi.model.request`), because the ambient context at the callback is
 * not guaranteed to be the one that was active when the enclosing span was opened.
 * Omit it for ordinary scoped work — {@link context.active} is then the parent.
 */
export function startSpan(
  name: string,
  options?: SpanOptions,
  parent?: Context,
): Span {
  return getTracer().startSpan(name, options, parent ?? context.active());
}

/** The context to hand to {@link startSpan}/{@link withSpan} to nest under `span`. */
export function contextWithSpan(span: Span, parent?: Context): Context {
  return trace.setSpan(parent ?? context.active(), span);
}

/**
 * Run `fn` inside an active span of `name`. The span is ended (with recorded
 * error status on throw) when `fn` settles. Returns `fn`'s result.
 *
 * Use this at load-bearing boundaries (see `docs/observability.md`). Example:
 *
 * ```ts
 * const handle = await withSpan(SpanNames.SANDBOX_PROVISION, async (span) => {
 *   span.setAttribute(SpanAttrs.SESSION_ID, sessionId);
 *   return sandbox.provision(spec);
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions,
  parent?: Context,
): Promise<T> {
  const span = startSpan(name, options, parent);
  try {
    return await context.with(contextWithSpan(span, parent), () => fn(span));
  } catch (err) {
    span.recordException(
      err instanceof Error ? err : new Error(String(err)),
    );
    span.setStatus({ code: 2 /* ERROR */ });
    throw err;
  } finally {
    span.end();
  }
}

/** End `span` with an ERROR status + recorded exception. Never throws. */
export function endSpanWithError(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: 2 /* ERROR */ });
  span.end();
}

// --- Metrics (lazy-cached instruments; no-op when no MeterProvider) --------

interface Instruments {
  tokensInput: import("@opentelemetry/api").Counter;
  tokensOutput: import("@opentelemetry/api").Counter;
  tokensCacheCreation: import("@opentelemetry/api").Counter;
  tokensCacheRead: import("@opentelemetry/api").Counter;
  costUsd: import("@opentelemetry/api").Counter;
  modelRequestDuration: import("@opentelemetry/api").Histogram;
  sessionsActive: import("@opentelemetry/api").UpDownCounter;
  sandboxesRunning: import("@opentelemetry/api").UpDownCounter;
  jobRuns: import("@opentelemetry/api").Counter;
  webhookDeliveries: import("@opentelemetry/api").Counter;
}

let cachedInstruments: Instruments | undefined;
/**
 * The `MeterProvider` {@link cachedInstruments} were created from. The metrics API
 * (unlike the trace API) has NO proxy provider: a meter obtained before a
 * `MeterProvider` is registered is the NO-OP meter, and its instruments stay no-op
 * forever. Because these instruments are created lazily at the first record — which
 * can precede `initTelemetry()` — the cache is keyed on the provider identity and
 * rebuilt when the global provider changes. Without this, registering the
 * `MeterProvider` after the first `record()` would silently drop every metric.
 */
let cachedProvider: unknown;

/** Lazily create the metric instruments. No-op when no MeterProvider is registered. */
function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cachedInstruments && cachedProvider === provider) return cachedInstruments;
  const meter = provider.getMeter(SCOPE.METER_NAME, SCOPE.VERSION);
  cachedInstruments = {
    tokensInput: meter.createCounter(MetricNames.TOKENS_INPUT),
    tokensOutput: meter.createCounter(MetricNames.TOKENS_OUTPUT),
    tokensCacheCreation: meter.createCounter(MetricNames.TOKENS_CACHE_CREATION),
    tokensCacheRead: meter.createCounter(MetricNames.TOKENS_CACHE_READ),
    costUsd: meter.createCounter(MetricNames.COST_USD),
    modelRequestDuration: meter.createHistogram(MetricNames.MODEL_REQUEST_DURATION),
    sessionsActive: meter.createUpDownCounter(MetricNames.SESSIONS_ACTIVE),
    sandboxesRunning: meter.createUpDownCounter(MetricNames.SANDBOXES_RUNNING),
    jobRuns: meter.createCounter(MetricNames.JOB_RUNS),
    webhookDeliveries: meter.createCounter(MetricNames.WEBHOOK_DELIVERIES),
  };
  cachedProvider = provider;
  return cachedInstruments;
}

/** Token counts passed to {@link recordTokenUsage}. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** USD cost of this request (already price-derived). */
  usd: number;
}

/**
 * Record per-model-request token + cost metrics. Call from `UsageRecorder.record`
 * (§9.7) after the `usage_records` insert. Best-effort: instruments are no-op
 * when no MeterProvider is registered (local dev + tests).
 *
 * @param model the model id (attribute `pi.model.name`)
 * @param usage token counts + usd
 */
export function recordTokenUsage(
  model: string,
  usage: TokenUsage,
  attrs: Attributes = {},
): void {
  const base: Attributes = { [SpanAttrs.MODEL_NAME]: model, ...attrs };
  const m = instruments();
  m.tokensInput.add(usage.inputTokens, base);
  m.tokensOutput.add(usage.outputTokens, base);
  m.tokensCacheCreation.add(usage.cacheCreationInputTokens, base);
  m.tokensCacheRead.add(usage.cacheReadInputTokens, base);
  if (usage.usd > 0) m.costUsd.add(usage.usd, base);
}

/**
 * Record a model-request latency observation (ms). Call from the turn boundary
 * when `pi.model.request` ends.
 */
export function recordModelRequestDuration(
  durationMs: number,
  attrs: Attributes = {},
): void {
  instruments().modelRequestDuration.record(durationMs, attrs);
}

/** Terminal outcome of a job run / webhook delivery (the `pi.outcome` attribute). */
export type Outcome = "succeeded" | "failed" | "retried";

/**
 * Move the active-session gauge (`pi.sessions.active`): `+1` on `wake()`, `-1` on
 * runtime `dispose()`. An UpDownCounter, so the two must be balanced by the caller.
 */
export function recordSessionActive(delta: number, attrs: Attributes = {}): void {
  instruments().sessionsActive.add(delta, attrs);
}

/**
 * Move the running-VM gauge (`pi.sandboxes.running`): `+1` on provision/start, `-1`
 * on stop (checkpoint) / destroy. Emitted from the sandbox provider, so it counts the
 * VMs THIS process actually created — not a control-plane-wide total.
 */
export function recordSandboxRunning(delta: number, attrs: Attributes = {}): void {
  instruments().sandboxesRunning.add(delta, attrs);
}

/** Count one scheduled job run by outcome (`pi.job.runs`). */
export function recordJobRun(outcome: Outcome, attrs: Attributes = {}): void {
  instruments().jobRuns.add(1, { [SpanAttrs.OUTCOME]: outcome, ...attrs });
}

/** Count one webhook delivery attempt by outcome (`pi.webhook.deliveries`). */
export function recordWebhookDelivery(
  outcome: Outcome,
  attrs: Attributes = {},
): void {
  instruments().webhookDeliveries.add(1, { [SpanAttrs.OUTCOME]: outcome, ...attrs });
}
