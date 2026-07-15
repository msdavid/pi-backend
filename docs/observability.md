# Observability — OTEL conventions & dashboards (WP-5.4)

> Status: **active**. Resolves spec §30 item 3. Authoritative source for span/metric
> names used by the Pi Managed Backend and its embedded Pi Agent SDK instrumentation.

This document covers:

1. The §30 item 3 decision (mirror Pi SDK span/metric names vs backend-specific).
2. The finalized span + metric name conventions (`infra/telemetry/conventions.ts`).
3. Per-VM sandbox metrics (§26.4) — the pull API that exists, and the OTEL export that does not.
4. Instrumentation points — where each span/metric is emitted at load-bearing boundaries.
5. The Grafana dashboards shipped under `docs/dashboards/`.

---

## 1. Decision — §30 item 3: OTEL conventions

**RESOLVED (2026-07-13):** *Mirror the Pi Agent SDK's OTEL span/metric names where they
exist; add backend-specific names for managed-only concepts.*

### Recommendation & rationale

The backend embeds the Pi Agent SDK and re-emits its lifecycle events on the managed
SSE stream (`span.model_request_start` / `span.model_request_end`, `agent.tool_use`,
`agent.tool_result`, …). Because the managed runtime and the SDK operate on the *same*
turn vocabulary, reusing the SDK's span names gives three concrete wins:

- **Joinable traces.** A managed turn produces a trace tree that interleaves
  backend-side spans (`pi.session.turn`) with SDK-internal spans (`pi.model.request`,
  `pi.tool.<name>`). Shared names let a single trace view span both layers without
  name-alias translation in the collector or dashboard.
- **Tool + dashboard reuse.** Alerts, service maps, and dashboards written against
  the SDK's instrumentation work unchanged against managed spans — no per-deployment
  mapping table.
- **Stable contract for subscribers.** Subscribers correlating the SSE `span.*`
  events with backend traces can key on the same names in both surfaces.

The backend-specific additions cover concepts the SDK has no notion of: managed session
registry lifecycle (wake/evict), microsandbox VM lifecycle (provision/start/exec/
checkpoint), scheduled jobs, vault secret resolution, and per-tenant usage/cost. These
get their own `pi.<domain>.<action>` names so they are visually + queryably distinct
from SDK spans while sharing the `pi.` namespace.

### Naming scheme

| Surface | Scheme | Example |
|---|---|---|
| Spans | `pi.<domain>.<action>` | `pi.model.request`, `pi.tool.bash`, `pi.session.turn` |
| Metrics | `pi.<domain>.<measure>` | `pi.tokens.input`, `pi.cost.usd`, `pi.sessions.active` |
| Span attrs | `pi.<domain>.<key>` (resource attrs use the OTel semconv `<ns>.<key>`) | `pi.model.name`, `session.id` |

Rules: lowercase, dot-separated, ASCII. The `pi.` prefix is reserved for this backend +
its embedded SDK. Tool names are sanitized to `[a-z0-9_-]+` and appended after
`pi.tool.` (e.g. `pi.tool.mcp__github__create_issue`).

### What this does NOT decide

- Trace **sampling** strategy (deferred; collector-side for v1).

> **Superseded 2026-07-14 (W8.1).** This section previously said the metrics exporter was
> unwired, so metric names were stable but nothing could ever export them. `initTelemetry`
> now registers a `MeterProvider` with an OTLP metric reader (§6), and the production call
> sites emit both spans and metrics (§4). One honest caveat remains: the five per-VM
> `pi.sandbox.*` gauges still have no producer (§3). (The boot path now calls
> `initTelemetry` — wired by `26d5c97`, see §4.)

---

## 2. Conventions (`infra/telemetry/conventions.ts`)

### Span names

| Constant | Name | Boundary |
|---|---|---|
| `MODEL_REQUEST` | `pi.model.request` | One `prompt()` turn (Pi `turn_start`→`turn_end`). Mirrors SDK. |
| `TOOL` | `pi.tool.<name>` | One tool execution inside a turn. Mirrors SDK (`tool_execution_start`→`_end`). |
| `SESSION_WAKE` | `pi.session.wake` | `SessionManager.wake()` — load record + ensure sandbox + build AgentSession. |
| `SESSION_TURN` | `pi.session.turn` | Full inbound turn (user.message → settled idle; wraps model-request + retries). |
| `SESSION_TRANSITION` | `pi.session.transition` | State-machine transition with a non-default stop reason (§6.3). |
| `SANDBOX_PROVISION` | `pi.sandbox.provision` | Provision a new microsandbox VM from a compiled spec. |
| `SANDBOX_START` | `pi.sandbox.start` | Start / cold-reboot a stopped or crashed VM. |
| `SANDBOX_EXEC` | `pi.sandbox.exec` | Execute a tool/call inside the VM (host-agent side). |
| `SANDBOX_CHECKPOINT` | `pi.sandbox.checkpoint` | Checkpoint + stop an idle VM (§10.3 idle policy) — `SandboxProvider.stop()`. |
| `SANDBOX_SNAPSHOT` | `pi.sandbox.snapshot` | Snapshot a stopped VM to a content-addressed image (§10.3). |
| `SANDBOX_DESTROY` | `pi.sandbox.destroy` | Kill + remove a VM and purge its binding refs (§12.1). |
| `JOB_RUN` | `pi.job.run` | Execute one scheduled job run (§14). |
| `SCHEDULER_TICK` | `pi.scheduler.tick` | One scheduler tick — the cross-tenant due-job sweep (§17.8). |
| `WEBHOOK_DELIVERY` | `pi.webhook.delivery` | One webhook delivery attempt (§23.5). |
| `VAULT_RESOLVE` | `pi.vault.resolve` | Resolve + register secret bindings for a session (§28). |

### Metric names

| Constant | Name | Kind | Source |
|---|---|---|---|
| `TOKENS_INPUT` | `pi.tokens.input` | counter | `UsageRecorder.record` (§9.7) |
| `TOKENS_OUTPUT` | `pi.tokens.output` | counter | `UsageRecorder.record` |
| `TOKENS_CACHE_CREATION` | `pi.tokens.cache_creation` | counter | `UsageRecorder.record` |
| `TOKENS_CACHE_READ` | `pi.tokens.cache_read` | counter | `UsageRecorder.record` |
| `COST_USD` | `pi.cost.usd` | counter | `UsageRecorder.record` (price-derived USD) |
| `MODEL_REQUEST_DURATION` | `pi.model.request.duration` | histogram | turn boundary (`pi.model.request` end) |
| `SESSIONS_ACTIVE` | `pi.sessions.active` | up_down_counter | `ManagedSessionRuntime` `wake` (+1) / `dispose` (−1) |
| `SANDBOXES_RUNNING` | `pi.sandboxes.running` | up_down_counter | `MicrosandboxProvider` provision/start (+1), stop/destroy (−1) |
| `JOB_RUNS` | `pi.job.runs` | counter | `CronScheduler.executeClaimedRun` (`pi.outcome` = succeeded\|failed) |
| `WEBHOOK_DELIVERIES` | `pi.webhook.deliveries` | counter | `WebhookDispatcher` (`pi.outcome` = succeeded\|failed\|retried) |
| `SANDBOX_CPU` | `pi.sandbox.cpu` | observable_gauge | **RESERVED — nothing emits this yet (§3)** |
| `SANDBOX_MEM` | `pi.sandbox.mem` | observable_gauge | **RESERVED — nothing emits this yet (§3)** |
| `SANDBOX_DISK_IO` | `pi.sandbox.disk_io` | counter | **RESERVED — nothing emits this yet (§3)** |
| `SANDBOX_NET_IO` | `pi.sandbox.net_io` | counter | **RESERVED — nothing emits this yet (§3)** |
| `SANDBOX_UPTIME` | `pi.sandbox.uptime` | observable_gauge | **RESERVED — nothing emits this yet (§3)** |

> The five `pi.sandbox.*` rows are **reserved names, not live series.** The per-VM numbers
> are available today only through the pull API (`GET /v1/sessions/:id/metrics`, §3); no
> instrument records them and no exporter ships them. Do not build an alert on them.

### Span attributes (stable contract)

| Constant | Key |
|---|---|
| `SESSION_ID` | `session.id` |
| `TENANT_ID` | `tenant.id` |
| `SANDBOX_ID` | `sandbox.id` |
| `MODEL_NAME` | `pi.model.name` |
| `TOOL_NAME` | `pi.tool.name` |
| `STOP_REASON` | `pi.stop_reason` |
| `RETRY_ATTEMPT` | `pi.retry.attempt` |
| `JOB_ID` | `pi.job.id` |
| `WEBHOOK_ID` | `pi.webhook.id` |
| `EVENT_TYPE` | `pi.event.type` |
| `OUTCOME` | `pi.outcome` |
| `HTTP_STATUS_CODE` | `http.response.status_code` (OTel semconv) |

### Helper surface

- `getTracer()` / `startSpan(name, opts?, parent?)` / `withSpan(name, fn, opts?, parent?)`
  — span creation; no-op when OTEL is disabled.
- `contextWithSpan(span, parent?)` — the context to pass as `parent` so a span nests under
  `span`. Needed where a span's start and end land in *different* callbacks (the Pi
  `turn_start`/`turn_end` pair), because the ambient context at the callback is not
  guaranteed to be the one active when the parent was opened.
- `toolSpanName(name)` — sanitize an arbitrary tool name to `pi.tool.<clean>`.
- `recordTokenUsage(model, usage, attrs?)` / `recordModelRequestDuration(ms, attrs?)` /
  `recordSessionActive(±1)` / `recordSandboxRunning(±1)` / `recordJobRun(outcome)` /
  `recordWebhookDelivery(outcome)` — metric recording.

> **Metric instruments are cached per `MeterProvider`, not once per process.** The metrics
> API (unlike traces) has no proxy provider: a meter obtained before a `MeterProvider` is
> registered is the no-op meter, and its instruments stay no-op forever. Because
> instruments are created lazily at the first record — which can precede `initTelemetry()`
> — `conventions.ts` keys its instrument cache on the provider identity and rebuilds it if
> the global provider changes. Without that, registering the `MeterProvider` after the
> first `record()` would silently drop every metric.

---

## 3. Per-VM sandbox metrics (§26.4) — what exists, and what does not

> **Corrected 2026-07-14 (W8.3).** This section previously described an `msb-metrics`
> sidecar that exports per-VM series over OTLP into Prometheus, and a metrics API that
> reads them back out. **No such sidecar exists** — not in the pinned
> `microsandbox@0.6.6` SDK, and not in this repo. The pipeline was aspirational and was
> documented as if it were built. What follows is what the code actually does.

### What the pinned SDK gives us: a pull API, not a pipeline

`microsandbox@0.6.6` exposes per-VM metrics as an on-demand **pull** on the sandbox
handle (`node_modules/microsandbox/dist/metrics.d.ts`, `sandbox-handle.d.ts`):

```ts
// microsandbox@0.6.6
class SandboxHandle { metrics(): Promise<SandboxMetrics>; /* … */ }
interface SandboxMetrics {
  cpuPercent: number;  memoryBytes: number;   memoryLimitBytes: number;
  diskReadBytes: number;  diskWriteBytes: number;
  netRxBytes: number;     netTxBytes: number;
  uptimeMs: number;       timestamp: Date;    /* …plus host-side memory/disk detail */
}
```

(The SDK also has `metricsStream(intervalMs)` and a process-wide `allSandboxMetrics()`.
Neither is wired here.)

### What the backend does with it

```
 ┌────────────────────────┐   metrics() pull   ┌──────────────────────────┐
 │ microsandbox microVM   │ ◀───────────────── │ SandboxProvider.metrics  │
 │  (msb NAPI runtime)    │ ─────────────────▶ │  (infra/sandbox/*)        │
 └────────────────────────┘   SandboxMetrics   └───────────┬──────────────┘
                                                           │ on request only
                                                           ▼
                                              ┌──────────────────────────┐
                                              │ GET /v1/sessions/:id/    │
                                              │      metrics  (200/404)  │
                                              └──────────────────────────┘
```

- `SandboxProvider.metrics(handle)` (`domain/ports.ts`) returns a `SandboxMetrics`
  snapshot, or `null` when there is nothing to sample (VM stopped / crashed / destroyed,
  or a provider that fronts no VM at all — the self-hosted tool channel, §10.4). It is an
  **optional** port method for exactly that reason.
- `GET /v1/sessions/:id/metrics` (`api/sessions.ts`, documented in
  `docs/api-reference.md`) resolves the session's persisted sandbox name, samples it, and
  returns the snapshot — or `404` when there is no live VM. It never wakes or provisions a
  sandbox, so polling is cheap and side-effect-free.
- Proven against a real microVM by `infra/sandbox/__tests__/@kvm.metrics.test.ts`.

### What is NOT emitted (the honest gap)

- **The five per-VM `pi.sandbox.*` gauge series are not produced by anything.**
  `conventions.ts` *names* `SANDBOX_CPU`, `SANDBOX_MEM`, `SANDBOX_DISK_IO`,
  `SANDBOX_NET_IO` and `SANDBOX_UPTIME`, but no observable gauge is registered and no code
  records them. Naming a metric is not emitting it.
  > **Narrowed 2026-07-14 (W8.1).** `SANDBOXES_RUNNING` (`pi.sandboxes.running`) is no
  > longer in this list — `MicrosandboxProvider` now moves it on provision/start/stop/
  > destroy (§4). The five *per-VM resource* gauges above still emit nothing; they need the
  > observable-gauge callback described below.
- ~~**No MeterProvider / OTLP metric exporter is wired.**~~ **Fixed 2026-07-14 (W8.1):**
  `initTelemetry` now registers a `MeterProvider` when an OTLP endpoint is configured, so a
  recorded instrument reaches the collector (§6); the boot path calls `initTelemetry`
  (`main.ts`), so this is live once an OTLP endpoint is configured.
- Consequently **no per-VM `pi.sandbox.*` series reaches Prometheus, and the panels in
  `docs/dashboards/sandbox-metrics.json` chart nothing.** They are kept as the target
  queries for the follow-up that wires the exporter, and are labelled "NO DATA YET" in the
  dashboard itself so nobody mistakes an empty panel for an idle fleet.

Closing that gap means, in order: ~~(1) register a `MeterProvider` + OTLP metric exporter in
`initTelemetry`~~ **(done — W8.1, §6)**; (2) register observable gauges over the running
sandboxes that call `SandboxProvider.metrics` (or the SDK's `allSandboxMetrics()`) on
collection, tagged with `sandbox.id` + `session.id`; (3) the dashboards then light up
unchanged. Until (2) lands, the pull API above is the only way to see a VM's resource use.

---

## 4. Instrumentation points — WIRED (W8.1)

> **Status change 2026-07-14 (W8.1).** Until W8.1 this table was a *plan*: the names in
> `conventions.ts` had **zero production call sites**, so a fully configured collector
> received no application spans at all. The call sites below now exist. Emission — not
> just the constants — is asserted by
> `src/infra/telemetry/__tests__/instrumentation.test.ts`, which boots the real `NodeSDK`
> with an `InMemorySpanExporter` + an in-memory metric reader, drives the real code paths,
> and asserts the span names, their attributes, and their parent/child nesting.

| ✅ | Boundary | File | Span / metric |
|---|---|---|---|
| ✅ | Session wake | `session-manager/runtime.ts` `wake` | `pi.session.wake`; `pi.sessions.active` +1 |
| ✅ | Runtime dispose | `session-manager/runtime.ts` `dispose` | `pi.sessions.active` −1 |
| ✅ | Inbound turn | `session-manager/runtime.ts` `handleUserMessage` | `pi.session.turn` (+ `pi.stop_reason` on settle) |
| ✅ | Model request | `session-manager/runtime-telemetry.ts` (`TurnSpanTracker`, driven by `runtime.ts` `onPiEvent`, `turn_start`→`turn_end`) | `pi.model.request` + `pi.model.request.duration` |
| ✅ | Tool execution | `session-manager/runtime-telemetry.ts` (`TurnSpanTracker`, driven by `runtime.ts` `onPiEvent`, `tool_execution_start`→`_end`) | `pi.tool.<name>` |
| ✅ | Vault resolve | `session-manager/runtime.ts` `resolveSecretBindings` | `pi.vault.resolve` |
| ✅ | Sandbox provision | `infra/sandbox/provider.ts` `provision` | `pi.sandbox.provision`; `pi.sandboxes.running` +1 |
| ✅ | Sandbox exec | `infra/sandbox/provider.ts` `exec` | `pi.sandbox.exec` (+ `pi.sandbox.exit_code`) |
| ✅ | Sandbox start | `infra/sandbox/provider.ts` `start` | `pi.sandbox.start`; `pi.sandboxes.running` +1 |
| ✅ | Sandbox checkpoint | `infra/sandbox/provider.ts` `stop` | `pi.sandbox.checkpoint`; `pi.sandboxes.running` −1 |
| ✅ | Sandbox snapshot | `infra/sandbox/provider.ts` `snapshot` | `pi.sandbox.snapshot` |
| ✅ | Sandbox destroy | `infra/sandbox/provider.ts` `destroy` | `pi.sandbox.destroy`; `pi.sandboxes.running` −1 |
| ✅ | Scheduler tick | `domain/scheduler/tick.ts` `tick` | `pi.scheduler.tick` |
| ✅ | Job run | `domain/scheduler/tick.ts` `executeClaimedRun` | `pi.job.run` (+ `pi.outcome`); `pi.job.runs` |
| ✅ | Webhook delivery | `domain/webhook/dispatcher.ts` `deliverOne` | `pi.webhook.delivery`; `pi.webhook.deliveries` (+ `pi.outcome`) |
| ✅ | Usage record | `domain/usage/usage-recorder.ts` `record` | `pi.tokens.*`, `pi.cost.usd` (tagged `tenant.id`) |
| ❌ | State transition | `session-manager/state-machine.ts` | `pi.session.transition` — **name reserved, not emitted.** The stop reason is already on `pi.session.turn`, so a separate span would add a node per turn and no information. |
| ❌ | Per-VM gauges | — | `pi.sandbox.cpu`/`mem`/`disk_io`/`net_io`/`uptime` — **not emitted** (§3). |

Each span carries the relevant `SpanAttrs` (`session.id`, `tenant.id`, `sandbox.id`,
`pi.model.name`, `pi.tool.name`, `pi.stop_reason`, `pi.job.id`, `pi.webhook.id`,
`pi.outcome`, …).

**Trace shape of one turn** — the parenting is explicit, so this nests even when the Pi
callbacks run outside the turn's ambient context:

```
pi.session.wake
└── pi.vault.resolve
pi.session.turn                      (session.id, tenant.id, pi.stop_reason)
└── pi.model.request                 (pi.model.name)
    └── pi.tool.bash                 (pi.tool.name)
```

**Instrumentation is additive and side-effect-free.** Every wrapper defers to the
unchanged original body and re-throws whatever it threw, so no control flow or error
handling changed at any call site. Where a boundary already *reports* failure by return
value rather than by throwing (`executeJobRun` → §17.4 taxonomy), the span and metric read
that value: a failed job is `pi.outcome=failed`, not an error span.

> **Telemetry is wired end-to-end (`26d5c97`).** `main.ts` calls
> `await initTelemetry(config)` before composing the app (so the Tracer/Meter providers are
> registered before any instrumented call site runs) and passes the handle to
> `startManagedServer`, which flushes it via `telemetry.shutdown()` on SIGINT/SIGTERM. With
> `OTEL_EXPORTER_OTLP_ENDPOINT` set, spans and metrics now reach the collector in
> production.
>
> Domain modules never touch the handle — they call the `conventions.ts` helpers, which
> resolve the global providers at call time and are no-op-safe when OTEL is disabled.

---

## 5. Grafana dashboards

Shipped under `docs/dashboards/`:

- **`session-overview.json`** — active sessions, tokens in/out, and cost (USD).
  Queries the `pi.sessions.active`, `pi.tokens.*`, and `pi.cost.usd` series. Importable via
  *Dashboards → Import → Upload JSON*. (Its "Session errors" panel queries
  `pi_session_errors_total`, which has no producer yet — `session.error` exists only as an
  SSE event, not a metric — so that one panel is labelled NO DATA like the sandbox
  dashboard.)
  > **Live as of W8.1.** These instruments are recorded in code (`UsageRecorder.record` →
  > `recordTokenUsage`; `ManagedSessionRuntime.wake`/`dispose` → `recordSessionActive`) AND
  > a `MeterProvider` is now registered (§6), so this dashboard populates once the operator
  > points the backend at a collector. It is the `pi.sandbox.*` per-VM panels below that
  > still chart nothing.
- **`sandbox-metrics.json`** — per-VM CPU, memory, disk I/O, network I/O, and uptime.
  Variables: `$sandbox` (sandbox.id), `$session` (session.id).
  > ⚠️ **This dashboard renders NO DATA today, by design.** Its panels query the per-VM
  > `pi.sandbox.*` series, and nothing emits them (§3): there is no `msb-metrics` sidecar
  > and no registered observable gauge. (The metric *exporter* is no longer the blocker —
  > W8.1 wired it, §6 — but a gauge with no callback still produces nothing.) The dashboard
  > is the *target* for the gauge follow-up, and its first row is a text panel saying
  > exactly this, so an empty chart is never read as "the fleet is idle". For live per-VM
  > numbers now, call `GET /v1/sessions/:id/metrics` (`docs/api-reference.md`). Do not put
  > this dashboard on a wall or alert on its panels until §3's step (2) lands.

Both are provisioning-style Grafana JSON (schema `dashboard` payload; import via the
Grafana UI or the HTTP API). Datasource is a Prometheus datasource variable `$DS`
(default: `Prometheus`).

---

## 6. Operator configuration — turning telemetry on

Telemetry is **off by default**: with no OTLP endpoint configured, the tracer and every
metric instrument resolve to no-ops, so local dev and tests need no collector and pay no
cost. The instrumented call sites are always present — there is no conditional setup in
any domain module.

| Env var | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **The master switch.** Unset ⇒ telemetry is a no-op. Set ⇒ `initTelemetry` starts the `NodeSDK` with an OTLP/HTTP trace exporter pointing here. |
| `OTEL_SERVICE_NAME` | `service.name` resource attribute. Default `pi-managed-backend`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes (e.g. `deployment.environment=prod`), read by the SDK's default resource detection. |
| `OTEL_METRICS_EXPORTER` | Selects the metric reader: `otlp` (default when an endpoint is set), `prometheus`, `console`, or `none` to disable metrics. |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | `http/protobuf` (default), `http/json`, or `grpc`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric push interval in ms (default 60000). |

**Metrics need no extra dependency.** `NodeSDK` builds the metric reader from
`OTEL_METRICS_EXPORTER` using the OTLP metric exporters that already ship inside
`@opentelemetry/sdk-node`, and registers the global `MeterProvider` itself. Because a
collector that silently receives spans and *zero* metrics is exactly the failure this WP
closes, `initTelemetry` defaults `OTEL_METRICS_EXPORTER` to `otlp` whenever an endpoint is
configured; an explicit value (including `none`) is always honored.

Minimal working configuration:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/traces
export OTEL_SERVICE_NAME=pi-managed-backend
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod
# metrics: implicit `OTEL_METRICS_EXPORTER=otlp`; set `none` to opt out.
```

`initTelemetry` returns a `TelemetryHandle` whose `shutdown()` flushes buffered spans; the
boot path should call it on graceful exit so nothing is lost at SIGTERM.
