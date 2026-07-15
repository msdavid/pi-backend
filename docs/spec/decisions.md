# Decisions Log

Seeded by WP-0.1. Records locked technology decisions (plan §3.2) and the status of the
spec's open questions (§30). New entries are appended; existing entries are never silently
edited — a supersession is a new row referencing the prior one.

> **R8 verification pass (2026-07-14).** Items 2, 3, and 14 were re-checked against the
> actual code and test runs rather than trusted from their original RESOLVED text (some of
> which described designs that were not yet wired when they were written). See the
> superseding rows below and `docs/spec/progress.md` for the evidence. Items 4 and 15 were
> already correctly downgraded to PARTIAL by R7.3 and are unchanged here.

## Locked technology decisions (plan §3.2 — changing one = human escalation)

| Decision | Choice | Source |
|---|---|---|
| Runtime | Node 20+, TypeScript strict, ESM, pnpm workspaces | plan §3.2 |
| HTTP framework | Fastify (SSE via reply hijack; zod schema validation) | plan §3.2 |
| Database | Postgres via `pg` + thin query layer; migrations via node-pg-migrate (SQL, forward-only) | plan §3.2 |
| ORM | None (heavyweight ORM rejected); `tenantScoped(query)` helper makes tenant filter mandatory | plan §3.2, §27.1 |
| Validation | zod, single source in `contracts`, reused server + client | plan §3.2 |
| Tests | vitest; integration via testcontainers-Postgres; `@kvm`-tagged sandbox tests on KVM runner | plan §3.2 |
| IDs | prefixed (`agent_`, `env_`, `sess_`, `vault_`, `mem_`, `memver_`, `skill_`, `file_`, `job_`, `wh_`), ULID payload, server-generated | plan §3.2, §6.6 |
| Password/API-key hashing | argon2id | plan §3.2, §8 |
| Secrets at rest | AES-256-GCM, KMS-or-keyfile key | plan §3.2, §28 |
| Errors | single wire error shape (api-reference conventions); internal `BackendError` base + machine `code` | plan §3.2 |
| Lint/format | eslint + prettier, configured once in WP-0.1 | plan §3.2 |

## Spec §30 open-question status

| # | Topic | Status | Resolution / note |
|---|---|---|---|
| 1 | API wire contract / event-type strings | **RESOLVED** (2026-07-12) | Accept the provisional §9.2 event-type names as final (`{domain}.{action}` scheme, e.g. `user.message`, `session.status_idle`, `agent.tool_use`, `span.model_request_start`). Wire JSON schemas, status codes, cursors, field char-limits land in `docs/api-reference.md` (WP-0.2+). |
| 2 | Model-provider routing in SaaS | **RESOLVED** (2026-07-14, supersedes the 2026-07-13 row below — same verdict, now evidence-backed) | **The 2026-07-13 resolution described a design, not yet a wired path**: at that date `db-session-store.ts` built session `material` as `{agentConfig, providerKeys:{}, cwd:"/workspace"}` — `providerKeys` was a literal empty object, so "the per-agent provider-key path is implemented" was true of the *code that existed to hold a key*, not of any path that ever populated one. R2.7 closed that gap for real: `domain/vault/provider-keys.ts` adds a `model_provider_key` vault-credential category (schema: `docs/db-schema.md` `vault_credentials.category`), decrypts it host-side (the only place a raw model key is ever decrypted), and the composition root (`app.ts:668`) constructs the resolver and threads it into `ManagedSessionRuntime` (`session-manager/runtime.ts:1092`), which calls it at every wake. **Fail-closed is proven**: `session-manager/__tests__/provider-key-fail-closed.test.ts` drives the real `PiAgentSessionFactory` with an empty `providerKeys` map and a live provider-key sentinel in `process.env`, and asserts the factory throws a non-retryable auth error *before* `createAgentSession` is ever called — i.e. the host's key is structurally unreachable, not merely untested. `session-manager/__tests__/material-wiring.integration.test.ts` proves the resolver is reached from a real wake. Both ran and passed in this verification pass (see `docs/spec/progress.md` R2 section). |
| 2 (as of 2026-07-13, superseded above) | Model-provider routing in SaaS | RESOLVED (2026-07-13) | The backend routes model calls to the provider configured on each agent (`model: {provider, id, thinkingLevel}` in the agent config, materialized via `AuthStorage.inMemory()` with provider keys from agent config — §2 "not a model provider"). The SaaS proxy/gateway question is an operational choice, not a missing feature; the per-agent provider-key path is implemented. **This claim was not backed by a wired implementation at the time** — see the row above. |
| 3 | OTEL conventions | **RESOLVED** (2026-07-15, upgrades the 2026-07-14 PARTIAL — emission is now wired end-to-end) | **Superseded update (2026-07-15):** W8.1 added production call sites at the session-wake/turn/model-request/tool/vault/sandbox/scheduler/webhook/usage boundaries (`runtime.ts`, `runtime-telemetry.ts`, `provider.ts`, `tick.ts`, `dispatcher.ts`, `usage-recorder.ts`), asserted by `infra/telemetry/__tests__/instrumentation.test.ts`; `26d5c97` wired `initTelemetry` into `main.ts` (with shutdown flush), so a configured collector now receives application spans and metrics. Remaining gap: the five per-VM `pi.sandbox.*` gauges still have no producer (`docs/observability.md` §3). The analysis below describes the pre-W8.1 state and is kept as history. — **Naming scheme: real and tested.** `infra/telemetry/conventions.ts` defines the `pi.<domain>.<action>` span/metric/attr vocabulary; `conventions.test.ts` covers it. **Trace transport: real when configured.** `infra/telemetry/otel.ts` starts a genuine `NodeSDK` + `OTLPTraceExporter` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (verified by reading the source — no mock). **What is NOT wired: application code never calls it.** `grep -rn "withSpan\|recordTokenUsage\|startSpan" packages/backend/src --include='*.ts'` (excluding `conventions.ts`/`otel.ts`/tests) returns **zero production call sites** — `withSpan`/`recordTokenUsage`/`startSpan` are exported and unit-tested against the no-op tracer, but nothing in `session-manager`, `usage`, `sandbox`, or the API routes ever invokes them. The `NodeSDK` is also constructed with no `instrumentations` array, so there is no auto-instrumentation (HTTP/pg/etc.) either. **Net effect: a fully-configured OTEL endpoint today receives zero application spans and zero metrics** — the exporter pipe is real, but nothing is put into it. This is exactly the shape R8 exists to catch: a component (conventions + exporter) that is built and reachable but not wired into any call path that runs in production. Closing this needs call sites added at the session-turn/tool-exec/model-request boundaries — not scheduled in this remediation pass. |
| 3 (as of 2026-07-13, downgraded above) | OTEL conventions | RESOLVED (2026-07-13) | **Mirror the Pi Agent SDK's span/metric names where they exist** (for joinable traces + tool/dashboard reuse), with **backend-specific additions** for managed-only concepts (sessions, sandboxes, jobs, vaults, usage). Finalized names live in `infra/telemetry/conventions.ts`; rationale + naming scheme + msb-metrics pipeline + Grafana dashboards in `docs/observability.md` (WP-5.4). Metrics OTLP exporter wiring deferred (no new deps this WP; recording calls are no-op-safe via `@opentelemetry/api` until a MeterProvider is registered). **This resolved the naming question but the row did not disclose that the emission helpers have no production callers** — see the row above. |
| 4 | Concurrency caps | **PARTIAL** (2026-07-14, supersedes RESOLVED 2026-07-13 — see "R7.3" below) | **Mechanism: done.** Per-tier `maxConcurrentSessions` / `maxConcurrentSandboxes` live in `TierConfig` + `quota/plans.ts` and are enforced by the quota middleware (WP-4.4/WP-5.5). **Values: NOT derived from measurement.** free=2 / pro=10 / enterprise=50 were never seeded from `docs/capacity.md` (which, until R7.3, carried only a fake-brain control-plane heap number and no VM cost at all). The R7.3 remeasurement gives a real per-session floor (75.5 MiB: 70.4 MiB microVM + 5.1 MiB control plane) and a real per-session ceiling (~517 MiB, guest at its 512 MiB limit) — enough to bound *host* capacity, **not** enough to derive a *per-tenant tier* cap, which additionally needs (a) the token-driven steady-state cost (needs a live provider key — unmeasured) and (b) a production host/fleet memory budget + overcommit policy (a product decision, not a measurement). The three numbers therefore stand as **unjustified policy defaults**, not as derived capacity. |
| 5 | Sandbox execution timeouts | **RESOLVED** (2026-07-12) | Default per-exec tool timeout: **120 seconds**. Per-agent override supported via environment config (`maxDuration` / per-tool `timeout` option). Configurable per tier later (WP-5.5). |
| 6 | Session log retention | **RESOLVED** (2026-07-12) | JSONL session tree retained **90 days** after last activity (the 30-day checkpoint window in §6.3 is for sandbox checkpoints, distinct from log retention). Purge-on-request supported. Per-tier overrides land in WP-5.5. |
| 7 | `rescheduling` retry policy | **RESOLVED** (2026-07-12) | **3 retries** with exponential backoff: 1s → 4s → 16s. After the 3rd failed retry, transition to `terminated`. Retryable conditions: transient model/provider/network failures. Non-retryable errors (auth, budget, archived resources) terminate immediately. |
| 8 | Session forking over the API | RESOLVED (spec §30) | Fork = new session resource sharing the JSONL tree to the fork point (Pi-native, not a copy). |
| 9 | `system.message` model support | **RESOLVED** | Pi rebuilds the system prompt per turn (`before_agent_start` / `systemPromptOverride`); mid-conversation updates are model-independent — no capability flag needed (§9.6). Cost is prompt-cache invalidation. |
| 10 | Tasks scope | **RESOLVED** (2026-07-13) | Confirmed: tasks are per-session only by design (§14.3). The `tasks` managed-feature extension stores state in tool-result details (branching-correct, per-session). Cross-session durable work uses memory stores (§13) or one-shot jobs (§14.4). |
| 11 | Default skills | **RESOLVED** (2026-07-12) | Pre-built skills shipped by default in v1: **`pptx`, `xlsx`, `docx`, `pdf`** (the standard document-task set, per spec §20.1). Seeded per tenant. |
| 12 | primus KVM availability | **RESOLVED** | GCP supports nested virtualization on Intel x86 (Haswell+) via `enableNestedVirtualization`; not on ARM (T2A). Confirm primus machine type and flip the flag if needed; expect a perf tax vs bare metal (§7.3). |
| 13 | microsandbox beta churn | RISK (policy set) | Pin exact msb version; wrap behind `SandboxProvider`; maintain upstream-upgrade test suite gating version bumps (WP-1.3). |
| 14 | Cert-pinned / non-TLS hosts vs env-var secrets | **RESOLVED** (2026-07-14, updates the 2026-07-13 row below with a concrete implementation for the case that motivated this item — git hosts) | Egress substitution requires TLS interception (§12.1 — unchanged constraint). The 2026-07-13 row cited only the general-purpose fallbacks (MCP proxy, custom tools); R6.8 subsequently implemented the concrete case this item was actually about — cloning a private git repo with a credential the guest must never see in plaintext — with **two real paths, both tested**: (1) **egress** (default): `compileGitTokenBindings` emits a `git_token` `SecretBinding` (`$MSB_GIT_TOKEN_<slug>`), `MicrosandboxProvider` registers `allowHost(<git host>)` + `trustHostCAs(true)` (the TLS-interception constraint made explicit in config, not silently assumed), and the guest clones via the placeholder — the token itself never crosses into the VM; (2) **staged** fallback for hosts that cannot be TLS-intercepted (cert pinning): the provider clones host-side with the token passed through the child process's env (never argv), and bind-mounts the result **read-only** into the guest — no credential in the guest, no push. `domain/environment/__tests__/git-token.test.ts` greps the entire guest-readable surface (clone exec argv, `.git/config`, guest env, the resolved `ProvisionSpec`, and the `SecretStore` bindings from a real encrypted PAT in Postgres) for the plaintext token and asserts it is absent, and asserts the staged mount is read-only. This test ran and passed in this verification pass. |
| 14 (as of 2026-07-13, updated above) | Cert-pinned / non-TLS hosts vs env-var secrets | RESOLVED (2026-07-13) | Egress substitution requires TLS interception (§12.1 — documented constraint). The recommended fallback patterns are implemented: the MCP credential proxy (§25.3, WP-3.3 `domain/mcp/proxy.ts`) for MCP servers, and client-side custom tools (§11.2, WP-3.4 `pi-extensions/custom-tools/`) for non-MCP services. **These are general escape hatches, not a solution for the case that prompted the item (repo cloning with a pinned-cert git host)** — see the row above for the actual fix. |
| 15 | Per-session memory footprint | **PARTIAL** (2026-07-14, supersedes RESOLVED 2026-07-13 — see "R7.3" below) | **Idle footprint: measured for real** (R7.3). `test/phase1-gate/load.gate.test.ts` now wakes N=5 sessions through the REAL `PiAgentSessionFactory` (a genuine Pi `AgentSession` each) on REAL detached microVMs, and reads per-VM host memory from the msb runtime (`allSandboxMetrics().memoryHostResidentBytes` = 42.0 MiB mean) and from `/proc/<pid>/status:VmRSS` of each `msb sandbox` supervisor (= 70.4 MiB mean, the number to budget with). Control plane: +5.1 MiB RSS / +0.16 MiB heap per session. Floor = **75.5 MiB/session idle**; worst case ≈ 517 MiB (guest at its 512 MiB ceiling). Numbers + method in `docs/capacity.md`. **Still open: the token-driven steady state** — no model turn was run (no live provider key in this environment), so prompt cache, transcript, and retained tool material are NOT in any figure; a working session costs strictly more by an unmeasured amount. Also unmeasured: soak/creep over hours. |

## KVM test runner (resolved 2026-07-12)

`@kvm`-tagged tests (real microsandbox / KVM) run on the **local Linux/KVM dev host**. No
rstudio/primus server access is required for Phase 1. WP-1.3 and the Phase-1 gate suite
(WP-1.14) run `@kvm` tests locally. (Server access requires an explicit user request per
project rules; will be revisited if local KVM capacity is insufficient.)

> **Decisions batch resolved 2026-07-12.** §30 items 1, 5, 6, 7, 11 are RESOLVED above.
WP-0.2 may proceed. Remaining OPEN/GAP items (2, 3, 4, 10, 14, 15) are deferred to their
own phases per the plan.

## WP-4.6 — MCP tunnels research spike (2026-07-13)
**Question (§19.1):** Should the backend support connecting to *private* MCP servers
(internal to a subscriber's network) via an MCP tunnel — a reverse connection the
private server initiates outbound to the backend, so the backend can reach a server
it cannot dial directly?

**Verdict: DEFER (no-go for v1).** MCP tunnels are **not implemented** in this codebase.
The upstream MCP streamable-HTTP transport (implemented in WP-3.3) covers the supported
case: remote MCP servers reachable over HTTPS. Private/internal servers behind a NAT or
firewall are out of scope for v1.

**Rationale:**
1. The spec itself marks tunnels a "limited research preview — phased late" (§19.1,
   §29.5) and lists them under Phase 4/5 explicitly as depending on upstream maturity.
2. The Model Context Protocol's tunneling/relay story is not yet stabilized upstream —
   building against it now risks rework when the spec settles.
3. The security surface is significant: a tunnel that lets the backend reach into a
   private network inverts the trust model and requires careful egress/ingress design,
   credential scoping, and per-tenant isolation that the current architecture does not
   address.
4. The supported alternative (remote streamable-HTTP MCP servers, WP-3.3) plus
   self-hosted environments (WP-4.1, where the subscriber's worker reaches its own
   private MCP servers locally) cover the practical use cases without a tunnel.

**Revisit when:** the MCP spec stabilizes a tunneling transport AND a subscriber
explicitly requests private-server connectivity that neither remote-HTTPS nor
self-hosted workers satisfy. At that point, commission a design note (Plan agent) for
the security model before any implementation.

## WP-5.4 — OTEL conventions + dashboards (2026-07-13)

**Question (§30 item 3):** Should the managed backend mirror the Pi Agent SDK's
OTEL span/metric names, or use its own backend-specific names?

**Verdict: RESOLVED — mirror the Pi SDK names where they exist; add backend-specific
names for managed-only concepts.**

**Rationale:**
1. The backend embeds the Pi Agent SDK and re-emits its lifecycle events on the
   managed SSE stream (`span.model_request_start`/`_end`, `agent.tool_use`, …).
   Reusing the SDK's span vocabulary (`pi.model.request`, `pi.tool.<name>`) keeps
   backend spans and SDK-internal spans joinable in one trace tree without name
   aliasing in the collector or dashboard.
2. Dashboards, alerts, and subscriber-side correlation logic written against the
   SDK's instrumentation work unchanged against managed spans.
3. Backend-specific concepts the SDK has no notion of (managed session registry,
   microsandbox VM lifecycle, scheduled jobs, vault resolution, per-tenant
   usage/cost) get their own `pi.<domain>.<action>` names so they are visually and
   queryably distinct while sharing the `pi.` namespace.

**Naming scheme:** spans `pi.<domain>.<action>`; metrics `pi.<domain>.<measure>`;
span attrs `pi.<domain>.<key>` (resource attrs via OTel semconv). Tool names are
sanitized to `[a-z0-9_-]+` and appended to `pi.tool.`.

**Artifacts:** finalized names in `infra/telemetry/conventions.ts`; conventions,
msb-metrics pipeline (§26.4), instrumentation-point checklist, and Grafana
dashboards in `docs/observability.md` + `docs/dashboards/`.

**Deferred (not this WP):** the metrics OTLP exporter + `MeterProvider` wiring
(would add `@opentelemetry/exporter-metrics-otlp-http` — ruled out under the no-new-deps
constraint). Metric instruments are created via the `@opentelemetry/api` meter and
are **no-op until a MeterProvider is registered**, so the names are stable and the
recording calls are safe now. Trace sampling strategy (collector-side for v1).

## R7.3 — capacity remeasured with the real harness (2026-07-14)

**Supersedes** the 2026-07-13 RESOLVED rows for §30 items **4** (concurrency caps) and
**15** (per-session memory footprint); both are now **PARTIAL**.

**Why the earlier resolution did not hold.** Item 15 was marked RESOLVED citing
`docs/capacity.md`, but the load gate that wrote it ran a **fake brain** (no Pi
`AgentSession`) and recorded per-VM RSS as *"not exposed by the `SandboxProvider` port"*.
The only number it produced was a 0.17 MiB/session control-plane heap delta — which
excludes both the real agent and the **dominant** cost, the microVM. Item 4's per-tier caps
(free=2 / pro=10 / enterprise=50) were then described as "seeded from `docs/capacity.md`",
which they were not and could not have been: that file contained no VM cost to seed from.

**What R7.3 actually measured.** `test/phase1-gate/load.gate.test.ts` was rewritten to
wake N=5 sessions through the REAL `PiAgentSessionFactory` (real Pi `AgentSession` per
session: auth storage, model registry, resource loader, JSONL `SessionManager`, the 9
sandbox-bound `customTools`, the managed extensions) on REAL detached microVMs, hold them
all awake, run a real `exec` in each guest, and read per-VM host memory from **two**
independent sources — the msb SDK's own metrics (`allSandboxMetrics()` →
`memoryHostResidentBytes`) and `/proc/<pid>/status:VmRSS` of each `msb sandbox --name …`
supervisor process. The gate now **fails** if either source disappears, rather than
publishing a capacity doc without the VM in it. Heap figures are only published from a run
with a forced GC (`NODE_OPTIONS=--expose-gc`), so a plain `pnpm test` cannot overwrite a
clean report with an un-GC'd one.

Result (per idle woken session, this KVM host): **70.4 MiB** microVM supervisor RSS +
**5.1 MiB** control-plane RSS = **75.5 MiB floor**; ceiling ≈ **517 MiB** if a guest touches
its full 512 MiB. Full method and numbers: `docs/capacity.md`.

**What remains open.**
1. **Token-driven steady state — unmeasured.** No model turn ran: a live provider key is
   not available in this environment. Prompt cache, conversation transcript, and retained
   tool material are in **none** of the figures above. A working session costs strictly
   more, by an amount only a keyed run can establish. Re-run the gate with a real key.
2. **Per-tier caps — not derivable from this data.** A per-tenant tier cap needs (1) above
   plus a production host/fleet memory budget and an overcommit policy (a product
   decision). The measurement bounds *host* capacity — `sessions ≤ hostRAM / 75.5 MiB`
   (all guests idle) down to `hostRAM / 517 MiB` (all guests at their ceiling) — and no
   more. free=2 / pro=10 / enterprise=50 remain in `tier-config/config.ts` +
   `quota/plans.ts` as **policy defaults with no measured basis**; they are left unchanged
   (changing them without (1) would swap one unjustified number for another), and their
   provenance claim ("seeded from capacity.md") is retracted here.
3. **Soak.** Whether per-session memory is flat or creeps over hours is untested.
