# Progress Ledger

Append-only record of merged work packages. A restarted orchestrator recovers state from
this table (plan §2.5). Update in the same commit as the merge.

> **Rebuilt from evidence, 2026-07-14 (R8).** The original failure mode of this project was
> a ledger whose ~40 rows were each individually truthful and collectively false: components
> were reported merged while the composition root wired none of them together, so nothing a
> row claimed was ever exercised by the system a subscriber would actually run. This document
> was rewritten from observed test output — commands run on this host, not agent self-reports
> — to not repeat that. Every claim below is one of three kinds, and is labelled as such:
>
> - **built** — the code exists and compiles/typechecks, but no test proves it is reachable
>   from the composition root.
> - **wired** — the code is reachable from `createManagedApp`/the real request path (grep- or
>   read-verified), but no test exercises it end-to-end.
> - **proven** — a named test drives the real production path (not a fake standing in for the
>   thing under test) and passed on this host, on this date. The test name is given so the
>   claim is falsifiable: run it yourself.
>
> A row may only claim **proven** when a specific test file backs it. Where something is wired
> but provable only with infrastructure this environment lacks (a live model-provider key, a
> second physical node, a registered self-hosted CI runner), that is stated explicitly rather
> than silently promoted to "done" — see §4 below for the full Residuals list.

---

## 0. Ground truth gathered for this pass (commands run on this host, 2026-07-14)

> **Superseded 2026-07-15** by two further audit rounds (§2.5): `26d5c97` (7 findings,
> migrations 034–035, 826 backend tests) and `210c60a` (44 findings, migrations 036–040,
> 913 backend tests — see `docs/spec/audit-remediation.md`). The numbers below are the
> 2026-07-14 R8 snapshot, kept as the evidence base for §1.

| Check | Command | Result |
|---|---|---|
| Contracts build | `pnpm --filter @pi-managed/contracts build` | clean |
| Typecheck | `pnpm -s typecheck` | clean, exit 0 |
| Lint | `pnpm lint` | clean, exit 0 |
| Backend, forced full integration | `PI_REQUIRE_INTEGRATION=1 pnpm --filter @pi-managed/backend exec vitest run` | **107 files, 783 passed, 1 skipped (784)** |
| Monorepo, all packages | `pnpm -r test` | **6/6 packages, 131 files, 974 passed, 1 skipped (975)** — contracts 2f/23t, web-console 1f/9t, worker 2f/13t, client-extension 17f/107t, testkit 2f/39t, backend 107f/783t+1skip |
| `@kvm` suites | same run | **executed for real**, not skipped: this host has `/dev/kvm` (`ls -l /dev/kvm`) + an installed microsandbox runtime (`isInstalled() === true`) |
| Container-backed suites | same run | **executed for real** against Postgres 16-alpine via an auto-detected rootless podman socket (no `DOCKER_HOST` set by hand) |
| Load/capacity gate, standalone, GC-forced | `NODE_OPTIONS=--expose-gc PI_REQUIRE_INTEGRATION=1 pnpm --filter @pi-managed/backend exec vitest run test/phase1-gate/load.gate.test.ts` | 3 passed, 1 skipped; **regenerated `docs/capacity.md`** live (file mtime moved to this run) |

The 1 skip in every run above is the same test: `test/phase1-gate/load.gate.test.ts`'s
`describe.skipIf(RUN)("… KVM unavailable …")` block, which is *designed* to skip when KVM
**is** available (it asserts `KVM === false` when it does run) — i.e. the skip is itself
evidence the real gate ran, not a gap.

---

## 1. R0–R7 remediation ledger (this pass's primary subject)

Each WP below cites the exact test file(s) that proved it in the 2026-07-14 full-integration
run (§0). "no dedicated test" is stated plainly where wiring was read-verified but nothing
drives it end-to-end.

### R0 — Security

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R0.1 | API-key scopes (`admin`/`read`/`write`) enforced on every route via `requireScope`/`requireScopeByMethod`; new keys default least-privilege | **proven** | `src/api/__tests__/scope-matrix.test.ts` (every route × every scope), plus scope assertions folded into `events.test.ts`, `idempotency-secrets.test.ts`, `mount-security.test.ts`, `memory.test.ts`, `vault.test.ts`, `api-key.test.ts` |
| R0.2 | `self_hosted_worker:<envId>` scope denies everything but its 3 work-queue routes | **proven** | `src/domain/self-hosted/__tests__/worker-key-denies.test.ts` |
| R0.3 | Onboarding signup no longer re-issues a fresh admin key for an existing tenant email | **proven** | `src/api/__tests__/onboarding.test.ts`, `src/domain/onboarding/__tests__/signup-no-reissue.test.ts` |
| R0.4 | Host-agent server implemented (was client + mock only); bearer token on every request incl. `/healthz`; mTLS (`requestCert`+`rejectUnauthorized`+backend CA) | **proven** | `src/infra/sandbox-host-pool/__tests__/host-agent-server.test.ts`. Real listener code confirmed by direct read of `src/infra/sandbox-host-pool/server.ts` (mTLS + bearer, both pre-handler) |
| R0.5 | Public-path rate limiting (was tenant-keyed only, so unauthenticated routes were unthrottled); bounded/evicted bucket map; `RATE_LIMIT_STORE=postgres` for a shared multi-replica ceiling | **proven** | `src/api/middleware/__tests__/rate-limit-public.test.ts` (labelled WP-R0.8 in-file — see note below), `rate-limit.test.ts` |
| R0.6 | Webhook + operations-side SSRF: one shared resolve→validate→pin helper; IPv6-bracket stripping; redirect re-check | **proven** | `src/domain/net/__tests__/ssrf-pin.test.ts`, `src/domain/session-manager/operations/__tests__/ssrf-guard.test.ts`, `src/domain/vault/__tests__/crypto.test.ts` (tagged R0.6 — TLS-preserving pin path) |
| R0.7 | Vault key no longer implicitly ephemeral under `NODE_ENV=test`; explicit `ALLOW_EPHEMERAL_VAULT_KEY` required | **proven** | `src/infra/config/__tests__/vault-key.test.ts` |
| R0.8 *(found during R0 execution, beyond the original 7 items)* | Rate limiting extended to the full unauthenticated allowlist, not just tenant-ctx paths | **proven** | `src/api/middleware/__tests__/rate-limit-public.test.ts` |
| R0.9 *(found during R0 execution)* | Session-outputs download: filename argv-exec'd, not shell-interpolated (was a shell-injection path: `x;touch pwned` in a download filename) | **proven** | `src/domain/file/__tests__/outputs-injection.test.ts` (reproduces the injection against a faithful `sh -c` vs argv-exec fake and observes it fail) |

### R1 — Honest harness

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R1.1 | A test instantiates the real `PiAgentSessionFactory` and asserts on the actual toolset handed to `createAgentSession` | **proven** | `src/domain/session-manager/__tests__/real-factory-toolset.test.ts` |
| R1.2 | CI runs `@kvm`/container gates fail-closed (`PI_REQUIRE_INTEGRATION`), replacing the old `echo` placeholder | **proven on this host** (see Residuals below for the runner-registration caveat) | `.github/workflows/ci.yml` `kvm`/`test` jobs read-verified; the suites they name (`@kvm.real-provider.test.ts`, `@kvm.remote-operations.test.ts`, `test/e2e.test.ts`, `test/phase1-gate/*`, `contract.test.ts`) all executed for real in §0's run |
| R1.3 | Fakes banned at the seam under test — client↔server via a real in-process Fastify app; provider tests real under `@kvm` | **proven** | `test/contract/api-client-conformance.test.ts` (real client against real in-process backend); `@kvm.real-provider.test.ts` |
| R1.4 | `as never` casts removed from `materialize.ts`; compile-time parity check against real SDK types | **proven** | `pnpm -s typecheck` clean (§0) is the direct proof — a shape mismatch is a compile error by construction, not a runtime assertion |

### R2 — Assembly (single owner)

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R2.1 | Composition root resolves real `providerKeys`, builds real `customTools` via `materializeToolset`, registers extension factories, sets `cwd` from the provisioned sandbox | **proven** | `src/domain/session-manager/__tests__/material-wiring.integration.test.ts`, `real-factory-toolset.test.ts` |
| R2.2 | Host-execution lockout: `noTools:"builtin"` + sandbox-bound `customTools` only; factory throws if material carries zero remote tools | **proven** | `real-factory-toolset.test.ts`; host-escape effects verified by `test/phase1-gate/` (real factory, not `createRemoteTools` in isolation — the R0-era gap this WP explicitly closes) |
| R2.3 | Background loops (scheduler, dispatcher, revalidation, outcome runner) started from `createManagedApp`, not opt-in | **proven** | `src/__tests__/managed-loops.integration.test.ts` |
| R2.4 | Real `SecretResolver` wired into `MicrosandboxProvider` in the composition root; credential-injection gate obtains bindings via the production path | **proven** | `test/phase1-gate/credential-injection.gate.test.ts` (tagged R1.2, drives the real path) |
| R2.5 | Pi extensions (permission-gate, tasks, goals, mcp-bridge, custom-tools, subagent) loaded into `material.extensionFactories` | **wired**, proven indirectly | No test asserts the full six-extension load directly; `app.ts`/`runtime.ts` read-verified (`loadExtensions`, R2.5-tagged). Individually proven working through R6.1 (permission-gate) and R2.5's own mcp-bridge credential resolver (`domain/mcp/credential-resolver.ts`) |
| R2.6 | Inbound events handled: `tool_confirmation`, `custom_tool_result`, `tool_result`, `define_outcome`; `TurnFlags.requiresAction` set | **proven** | `src/domain/session-manager/__tests__/inbound-events.integration.test.ts`, `permission-gate-roundtrip.integration.test.ts` |
| R2.7 | Provider keys resolved from vault at wake; fail-closed if unresolved (never falls through to a host `process.env` key) | **proven** | `src/domain/session-manager/__tests__/provider-key-fail-closed.test.ts` (asserts `createAgentSession` never called + host sentinel key never used), `material-wiring.integration.test.ts` |
| R2.8 | Sandbox handle + status/stop_reason persisted to Postgres (`sessions.sandbox_handle`, `.status`, `.stop_reason`), replacing the never-written `NULL` | **proven** | `src/domain/session/__tests__/db-session-store-persist.test.ts`, `test/phase1-gate/restart.gate.test.ts` |
| R2.9 | Boot-time `reattachByLabels`; a detached VM survives `kill -9` and re-attaches to the same session via the real Postgres-backed store | **proven** | `test/phase1-gate/restart.gate.test.ts`, `src/domain/session-worker/__tests__/pool.integration.test.ts` |
| R2.10 | `JsonlSync.startPeriodic` actually called; durable local root (not `/tmp`, via `PI_SESSION_LOCAL_DIR`); download-on-cold-wake; durable `synced_etag` column; real optimistic concurrency | **proven** | `src/domain/session-manager/__tests__/jsonl-sync.test.ts` |
| R2.11 | Bounded/LRU session registry; `getOrCreate` check-then-act wake race fixed | **proven** | `src/domain/session-manager/__tests__/app-registry.test.ts` |

**GATE-R2 claim** (product functions on one node, survives `kill -9` without orphaning a VM
or lying about status): **proven** by the combination of `restart.gate.test.ts` +
`db-session-store-persist.test.ts` + `test/e2e.test.ts`, all executed for real in §0.

### R3 — Contract seam

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R3.1 | SSE path canonicalized to `…/stream` everywhere (server, client, doc) — was 404ing every client SSE connection | **proven** | Direct `grep` confirms all three agree (`api/events.ts:248`, `client-extension/src/api-client.ts:380`, `docs/api-reference.md:905`); `test/contract/api-client-conformance.test.ts` exercises it live |
| R3.2 | Contract conformance suite: every `api-client.ts` method 2xx's against a real in-process backend | **proven** | `test/contract/api-client-conformance.test.ts` (backend), `packages/client-extension/src/api-client.test.ts` (client side, tagged R3.1/R3.2) |
| R3.3 | `DelegationRecorder` dedup state persisted (not re-surfaced per restart); reconnect backoff resets after a successful stream | **proven** | `packages/client-extension/src/panel/delegation.test.ts`, `panel/connection.test.ts` (both tagged R3.3) |
| R3.4 | `db-schema.md` generated from migrations, not hand-maintained; `pnpm db:schema:check` fails CI on divergence | **proven** | `scripts/gen-db-schema.mjs` read-verified as the doc's stated source; `.github/workflows/db-schema.yml` (new, untracked) runs the check; `docs/db-schema.md` header confirms 28 generated tables vs the pre-R3.4 hand-written ~20 |

### R4 — Event model

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R4.1 | Append-only `session_events` projection (position/type/ts/payload); history/pagination/replay served from it | **proven** | `src/domain/session-manager/__tests__/session-events-store.test.ts`, `src/api/__tests__/events.test.ts` |
| R4.2 | Multi-consumer fan-out: per-subscriber cursors, not a single stolen `waiter` slot | **proven** | `src/domain/session-manager/__tests__/fan-out.test.ts` |
| R4.3 | Bounded outbound buffer with an explicit drop/summarize policy | **proven** | `fan-out.test.ts`, `src/domain/event-stream/__tests__/stream.test.ts` |
| R4.4 | Reads never provision a VM — `GET /events`/history served from the R4.1 projection, including for archived sessions | **proven** | `src/domain/session-manager/__tests__/read-path.integration.test.ts` ("Events read path never provisions a sandbox"), `replay.test.ts`, `events.test.ts` |

### R5 — Perimeter concurrency-correctness + loop-correctness

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R5.1 | Idempotency claim-first (INSERT before handler runs; unique violation = replay) | **proven** | `src/api/middleware/__tests__/idempotency-concurrency.test.ts` |
| R5.2 | Quota checked transactionally inside the resource-creating transaction, not a separate preHandler COUNT | **proven** | `src/domain/quota/__tests__/quota-concurrency.test.ts` |
| R5.3 | Scheduler cursor excludes manual runs; `jobs.status` index added; claim/execute ordering matches intended semantics | **proven** | `src/domain/scheduler/__tests__/tick-manual-cursor.test.ts` |
| R5.4 | Webhook claim + `delivering` status-flip in one transaction (was autocommit — two nodes could double-deliver); `(webhook_id, event_id)` unique constraint added | **wired**, partially proven | Migration `033_webhook_delivery_safety.sql` (new) adds the constraint (read-verified); no dedicated multi-node race test found in this pass — single-process behavior covered by existing `dispatcher.test.ts`/`webhook.test.ts` (not R5-tagged) |
| R5.5 | Per-credential lock/version on `mcp_oauth` refresh; cross-node `inFlight` guard | **proven** | `src/domain/vault/__tests__/refresh-concurrency.test.ts` |
| R5.6 | Tenant-scope discipline on raw-`query()` call sites (`memory/version.ts`, `scheduler/tick.ts`, `self-hosted/work-queue.ts`) | **proven** | `src/infra/db/__tests__/tenant-scoped-client.test.ts` |

### R6 — Feature re-wire

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R6.1 | Permission gate: `always_ask` tool actually pauses (`requires_action`) and resumes on `tool_confirmation` | **proven** | `src/domain/session-manager/__tests__/permission-gate-roundtrip.integration.test.ts` |
| R6.2 | MCP: `notifications/initialized` sent after initialize; JSON-RPC `id` matching in SSE parse | **proven** | `src/domain/mcp/__tests__/client.test.ts` |
| R6.3 | Real `OutcomeProducer` (not only `FakeProducer`) drives the loop; timeout/cancel; grader event-shape fix | **proven** | `src/domain/outcome/__tests__/producer.test.ts`, `loop-terminal.test.ts`, `grader-events.test.ts`, `grader-readoutputs.test.ts`. (define-outcome→grader end-to-end wiring into `createManagedApp` was completed later by `26d5c97` finding #3 — the R6.3 proof covered the loop, not composition-root wiring; see §2.5.) |
| R6.4 | Multi-agent: `runParallel` filename race fixed; `blockingEventIds` populated; sandbox release fixed (was a leak); concurrency cap counts live threads only | **proven** | `src/domain/multiagent/__tests__/coordinator.test.ts`, `thread.test.ts` (the plan explicitly notes these tests did not exist before this WP) |
| R6.5 | Memory mount + skill materialization + skill seeding wired into session start | **proven** | `src/domain/session-manager/__tests__/memory-mount.integration.test.ts` (R6.5a), `src/domain/skill/__tests__/session-skills.integration.test.ts` (R6.5b/c) |
| R6.6 | Self-hosted work queue fed by real session tool execution; `postResult` round-trip completes | **proven** | `src/domain/self-hosted/__tests__/round-trip.integration.test.ts` |
| R6.7 | Config-selectable `MultiHostSandboxProvider` (`SANDBOX_MODE=multi`); placement + re-attach across hosts | **proven** | `src/infra/sandbox/__tests__/multi-host-composition.test.ts`. Depends on R0.4 (host-agent server + mTLS), also proven above |
| R6.8 | Git-token clone path: egress (in-guest, TLS-intercepted) + staged (host-side, read-only, no-push) fallback; token never in guest on either path where claimed | **proven** | `src/domain/environment/__tests__/git-token.test.ts` (greps the full guest-readable surface for the plaintext token) |

### R7 — Architecture

| WP | Claim | Status | Evidence |
|---|---|---|---|
| R7.1 | Session-worker process pool (`SESSION_WORKER_MODE=pool`) shards sessions across bounded child processes | **proven** | `src/domain/session-worker/__tests__/pool.integration.test.ts`. Docs: `docs/session-worker-pool.md` (new) |
| R7.2 | `ApiError` moved out of `server.ts` into a domain module; the import cycle (30+ domain files importing HTTP-layer `ApiError`) removed | **proven** | `src/domain/errors.ts` (new) is now the base; `pnpm -s typecheck` clean confirms no cycle-induced type errors; `grep` of `from "../../server.js"` style imports of `ApiError` across `domain/` returns nothing outside `errors.ts` re-exports |
| R7.3 | Load gate remeasured with the real Pi harness (not a fake brain); real per-VM RSS extracted; `decisions.md` items 4/15 un-marked RESOLVED | **proven** | `test/phase1-gate/load.gate.test.ts`; `docs/capacity.md` regenerated live in this pass (§0); `decisions.md` items 4/15 confirmed PARTIAL, not RESOLVED |

**GATE-R8 claim** (every gate re-run for real, ledger rebuilt from evidence): this document
and the Evidence table in §0 **are** that re-run. What R8 does **not** prove is listed in
§4 below (the Residuals list) — most importantly, true token-driven capacity (needs a live
provider key) and whether a KVM-labelled self-hosted CI runner is actually registered (an
infra fact, not something a checkout can determine).

---

## 2. R8 documentation corrections made alongside this ledger

- `docs/spec/decisions.md` items 2 (provider-key routing), 3 (OTEL — downgraded to PARTIAL:
  naming/export machinery is real, but the emission helpers have zero production call
  sites), and 14 (cert-pinned git hosts) corrected with evidence citations; items 4 and 15
  were already correctly PARTIAL from R7.3 and are unchanged.
- `docs/spec/api-reference-audit.md`'s "Defects: None found" partially retracted — it was a
  docs-against-docs review performed before any backend code existed, and the exact class of
  defect its method could not catch (the SSE-path contradiction, R3.1) did in fact ship. A
  narrow spot-check in this pass found the current state consistent; a full re-audit against
  code was out of scope here.
- `README.md`: fixed broken links (`implementation-plan.md`, `docs/decisions.md`,
  `docs/progress.md` all moved under `docs/spec/`), added the config vars introduced by this
  remediation (`SANDBOX_MODE`, `SESSION_WORKER_MODE`, `RATE_LIMIT_*`, `PI_SESSION_LOCAL_DIR`,
  `PI_REQUIRE_INTEGRATION`), and documented the API-key scope model and the
  `model_provider_key` vault-credential path (fail-closed boot).
- `docs/spec/remediation-plan.md`: status header changed from "Proposed" to
  "IMPLEMENTED AND VERIFIED", with the evidence table and Residuals section this ledger
  cross-references. *(That file was later removed in the docs reorg, `4421936`; its
  Residuals list is preserved as §4 below.)*

---

## 2.5 Post-R8 audit rounds (2026-07-15)

Two further end-to-end audit rounds and two refactors landed after the R8 rebuild:

| Commit | Scope | Notes |
|---|---|---|
| `26d5c97` | 7 correctness/security findings, migrations 034–035 | (1) event position DB-authoritative — emit persists to the `session_events` projection first, fans out with the position `append()` returns; migration 035 adds `UNIQUE(session_id, event_id)`; (2) scheduler cross-node recovery double-fire fixed — `job_runs.claimed_at` (migration 034) + atomic CAS claim; (3) outcome grader wired by default — `SubagentGrader` + `PiGraderSessionFactory` constructed in `createManagedApp`, `user.define_outcome` wired via `onDefineOutcome`; (4) status-aware idle eviction (running runtime rescheduled, not disposed mid-turn); (5) SSRF classifier canonicalizes IPv6 (IPv4-mapped/compat/unspecified, `fe80::/10`, fail-closed); (6) post-crash boot reconcile resets stale `running`/`rescheduling` → `idle`; (7) `system.message` rebuilds the prompt via `setSystemPrompt`; per-session `mkdtemp` agent dir removed on dispose. Each fix ships with a regression test. 826 backend tests. |
| `b341aab`, `49aaf9d` | `runtime.ts` split (no behavior change) | Extracted `OutboundEventStream` + pure helpers, then `TurnSpanTracker` + `SessionMemoryVolumes`. |
| `f7a6350`, `4421936` | Docs reorg | spec/plan/investigation/decisions/progress/audit/multi-host moved into `docs/spec/`; `remediation-plan.md` dropped (Residuals inlined into §4 below). |
| `210c60a` | 44 findings (security, robustness, performance), migrations 036–040 | Full ledger in `docs/spec/audit-remediation.md`. 913 backend tests. |

---

## 3. Pre-remediation ledger (Phase 0–5, merged before the 2026-07-14 audit)

> **Read this section as history, not current status.** Every
> row below was true of the module in isolation at merge time — each was individually
> truthful. Several were **not** wired into the composition root until R2 (session material,
> extensions, background loops, secret bindings, runtime-state persistence — see §1 above),
> which is exactly the failure mode the R8 banner at the top of this document describes
> (the Snapshot-drift table formerly in `remediation-plan.md` is condensed into the bold
> notes on each row). Where a row's
> component was later found inert and fixed by an R-numbered WP above, that WP entry is the
> current, evidence-backed status — treat this section as a historical record of what was
> *built*, not a current claim of what is *wired* or *proven*.

| WP | branch | merged-at | notes |
|----|--------|-----------|-------|
| WP-0.1 | wp/0.1-scaffold | 2026-07-12 | pnpm workspace, 5 packages, strict ESM tsconfig, eslint+prettier+vitest, CI (typecheck/lint/test + @kvm stub), docs seeded, CONVENTIONS.md. zod on contracts pkg. All gates green. |
| WP-0.10 | pi-agent-baee443b-e12d-457 | 2026-07-12 | ports.ts (8 interfaces: SandboxProvider, SessionRuntime, SecretStore, ObjectStore, UsageRecorder, Clock, WebhookSink + 28 supporting types) + 7 testkit fakes + createTestKit() factory. 16 tests. §25.5 invariant verified (no raw secrets in ports). testkit→backend workspace dep. |
| WP-0.2 | wp/0.2-api-reference-conventions | 2026-07-12 | docs/api-reference.md (436 lines): auth, error envelope (13 codes), status codes, cursor pagination, Idempotency-Key, rate limiting, ID prefixes, name/timestamp/metadata rules, §9.2 event catalog (marked FINAL), SSE wire format, tenancy, conformance checklist. 20 ## sections. |
| WP-0.8 | (direct commit) | 2026-07-13 | docs/db-schema.md (13 tables: tenants, api_keys, agents, agent_versions, environments, sessions, vaults, vault_credentials, memory_stores, memory_versions, files, skills, skill_versions, jobs, job_runs, webhooks, webhook_deliveries, session_outcomes, session_threads, usage_records). AES-256-GCM secrets, exactly-once (job_id,scheduled_at), (tenant_id,name) uniques, JSONL-not-in-Postgres, object-store layout, retention. **Superseded**: this doc is now generated from migrations (R3.4) and covers 28 tables. |
| WP-0.3..0.6 | (direct commit) | 2026-07-13 | api-reference.md resource sections (716→1296 lines): Agents §6.1/§8.1, Environments §6.2/§8.2, Sessions §6.3/§8.3 (3 agent forms, state machine, fork, budget), Events & SSE §9 (full event catalog, custom-tool/confirmation flows, deltas, Last-Event-ID), Vaults §12, Memory §13, Files §21, Skills §20, Outcomes §16, Jobs §17 (exactly-once), Webhooks §23 (signatures, auto-disable), Tenant/admin §8.12, self-hosted Phase 4 stub §10.4. 72 endpoints documented. |
| WP-0.7 | (direct commit) | 2026-07-13 | docs/api-reference-audit.md — reviewer pass: all 37 §8 endpoints, all §9.2 event types, 13 error codes, all constraints present. No borrowed API idioms. **This audit's "approved as wire contract" verdict is partially retracted — see `docs/spec/api-reference-audit.md`'s own banner and §2 above: it audited docs against docs before any implementation existed.** |
| WP-0.9 | wp-0.9/contracts | 2026-07-13 | @pi-managed/contracts: 14 modules (ids, common, agent, environment, session, events, vault, memory, file, skill, outcome, job, webhook, tenant) + barrel + README. 23 golden tests. Write-only invariants proven (credential secrets, webhook signing secret, API key raw key). All 13 error codes, FINAL event catalog, 3-form agent field. |
| WP-P0.1 | pi-agent-9221e37a-1a4a-437 | 2026-07-13 | Service scaffold: Fastify app factory, layered zod-validated config (env>file>defaults, fatal on error), pino logger with tenant/session correlation, OTEL SDK wiring (no-op when unset), /healthz + /readyz (pluggable checks, all-down in P0.1), global error handler → contracts ErrorEnvelope. 23 tests. Deps: fastify, pino, @opentelemetry/*. |
| WP-P0.2 | pi-agent-9996e529-18f2-408 | 2026-07-13 | Postgres layer: pg pool, node-pg-migrate, 20 migrations (all db-schema.md tables incl. (job_id,scheduled_at) unique §17.8, (tenant_id,name) uniques, (vault_id,key)), tenantScoped helper (compile-time TenantCtx + runtime tenant_id assertion). 29 tests (cross-tenant read, up/down clean, negative). Fixes: runner API, down-count=Infinity. Deps: pg, node-pg-migrate, argon2, @testcontainers/postgresql. |
| WP-P0.3 | wp-p0.3/object-store | 2026-07-13 | ObjectStore port impls: FilesystemObjectStore (v1 default, streaming, sha256 ETags) + S3ObjectStore (AWS SDK v3, MinIO-compatible, If-Match conditional, versioning probe) + readiness adapter. Contract parity suite: fake + fs + S3(MinIO skip-if-no-docker). 59 tests. Deps: @aws-sdk/client-s3, @testcontainers/minio. |
| WP-P0.4 | (direct commit) | 2026-07-13 | Tenants + API keys + bearer auth. Tenant model (implicit-tenant auto-create §7.1), argon2id-hashed API keys (raw key `pmb_live_<ulid>_<secret>` shown once, never stored; O(1) verify via embedded ULID), bearer auth middleware (onRequest hook → request.tenantCtx, public allowlist for /healthz,/readyz). Routes: GET /v1/tenant (quota stub), POST/GET/DELETE /v1/api-keys. 90 tests total incl. cross-tenant negative, serialization (no raw key in list). **Scope enforcement did not exist yet — added by R0.1.** |
| WP-P0.5 | (direct commit) | 2026-07-13 | HTTP cross-cutting: Idempotency-Key middleware (persisted replay byte-for-byte; 409 idempotency_conflict on same-key-different-body; 24h; per-tenant; migration 021_idempotency_keys), rate-limit middleware (per-tenant token bucket, 429+Retry-After, X-RateLimit-* headers), pagination helpers (limit default 50 max 200, opaque base64url cursor, {data,nextCursor}). **Idempotency-store credential leak and unauthenticated-path rate-limit gaps found and fixed by R0.2/R0.5/R0.8.** |
| WP-1.1 | wp-1.1-agents-api | 2026-07-13 | Agents API: CRUD + versioning (update=new version via CTE) + archive (terminal, isAgentArchived exposed for WP-1.6). Per-tenant name uniqueness 409. 7 endpoints. Config validated via contracts zod. 19 tests. |
| WP-1.2 | (same branch) | 2026-07-13 | Environments API: CRUD + hard delete + archive. cloud only (self_hosted→422 Phase 4). compileProvisionSpec(env,ctx)→ProvisionSpec with network-policy mapping (unrestricted≠allowAll, limited=default-deny+hosts). Not versioned. |
| WP-1.9 | (same branch) | 2026-07-13 | Vaults basic: vault+credential CRUD (static_bearer, environment_variable; mcp_oauth Phase 2 stub). AES-256-GCM encryption (Node crypto). Write-only sensitive fields (serialization test). resolveBindingsForSession→SecretBinding[] ($MSB_ placeholders, no values §25.5). archive-cascade, unique key, max 20. migration 022. `model_provider_key` category added later by R2.7. |
| WP-1.11a | (same branch) | 2026-07-13 | Client extension skeleton: piManaged.* settings schema, env-var overrides, AuthStorage API-key storage (apiKeyRef), typed API client (REST + SSE w/ Last-Event-ID reconnect + polling fallback), /remote:config first-run + GET /v1/tenant validation, version-compat warning. 22 tests. **The SSE path this client called did not match the server until R3.1.** |
| WP-1.3 | wp-1.10/usage-tracking | 2026-07-13 | Real microsandbox SandboxProvider (NOT a stub): provision (tenant-namespaced detached, labels, volumes, env, host-side secret bindings, network policy), exec/execStream, stop/start (cold reboot), snapshot, destroy, reattachByLabels, status (running|stopped|crashed|draining), registerSecretBinding. Network-policy compiler (unrestricted→publicOnly NOT allowAll; limited→default-deny+per-host egress). §25.5 holds (SecretResolver injectable, no value crosses port). @kvm suite passed (KVM present). Dep: microsandbox@0.6.6 + linux-x64 runtime. 30 tests. **`reattachByLabels` existed but was called by nobody until R2.9.** |
| WP-1.10 | (same branch) | 2026-07-13 | Usage tracking: UsageRecorder impl (per-model token capture, price table config→USD, unknown-model fallback), cumulativeForSession rollup, checkBudget (maxTokens/maxUsd→budget_exhausted §6.3), per-tenant rollup wired into GET /v1/tenant. migration uses usage_records. Budget enforcement hook exposed for WP-1.5. |
| WP-1.5 | (direct commit) | 2026-07-13 | Session manager (the Harness): ManagedSessionRuntime (wake/sendEvent/subscribe/interrupt/getEntries/status), SessionStateMachine (idle→running→rescheduling→terminated, 3 retries exp backoff, terminal guard), IdlePolicy (idleTimeout→stop, resume→start cold-reboot), CrashRecovery (crashed→re-provision→resume), JsonlSync (local+object-store sync on idle + 30s periodic), PiAgentSessionFactory (materialize→createAgentSession w/ AuthStorage.inMemory, SettingsManager.inMemory, per-session loader — no process-env keys §4.2). 241 backend tests. Fixes: state-machine terminal guard (terminated is terminal), fake-sandbox setNextStatus updates existing handles. **`db-session-store.ts` built session `material` with empty `providerKeys:{}` and no tools at this point — not wired until R2.1/R2.2/R2.7. `JsonlSync.startPeriodic` had zero call sites until R2.10.** |
| WP-1.6 | (direct commit) | 2026-07-13 | Sessions API: create (3 agent forms — bare ID/pinned/overrides w/ omit-inherit·null-clear·value-replace; lazy sandbox provisioning), list/get, PATCH (tools/mcpServers only, idle-only 409 session_not_idle), delete (soft archive JSONL, independent resources untouched), fork (new resource sharing JSONL tree, Pi-native §30 item 8), entries/tree/messages/usage reads. DbSessionStore. 18 tests. **`status`/`stop_reason` were written once at create and never updated — `session_not_idle` was vacuous until R2.8.** |
| WP-1.7 | (direct commit) | 2026-07-13 | Events API + SSE: POST /events (Idempotency-Key, contracts validation, system.message 409 requires_action), GET /events (paginated history), GET /stream (SSE id=seq, Last-Event-ID gap-free replay, delta-free replay, ?eventDeltas= opt-in event_start/event_delta never persisted/replayed, processedAt). domain/event-stream: sse-encoder, wire, replay, deltas, stream. 323 tests total. **Live events and JSONL replay used different numbering until R4.1; a single `waiter` slot let two SSE clients steal each other's events until R4.2.** |
| WP-1.8 | (direct commit) | 2026-07-13 | Toolset config: ToolsetConfig (defaultConfig + per-tool configs), 9 known built-in names, validateToolsetConfig (422 unknown), DEFAULT_TOOLSET_CONFIG (all-on always_allow), enableOnly() everything-off, resolveTools algebra, materializeToolset (disabled tool absent), getPermissionPolicy (built-in always_allow, MCP always_ask for Phase 3). 20 tests. **`materializeToolset` had zero production call sites until R2.1.** |
| WP-1.12 | (direct commit) | 2026-07-13 | Files API: upload(multipart)/list/get/download/delete over ObjectStore; files independent of sessions (§21). Session-outputs slice: listSessionOutputs (exec ls /mnt/session/outputs/, idle-only 409, path-traversal guard), downloadSessionOutput. SessionSandboxResolver seam injected. 10 tests. **`downloadSessionOutput`'s filename handling had a shell-injection gap (R0.9) not caught by this WP's own tests.** |
| WP-1.11b | (direct commit) | 2026-07-13 | Client extension commands + live-view panel: /remote:start, /remote:resume, /remote:sessions, /remote:delegate, /remote:attach, /remote:fork, /remote:detach. Panel display-only (setWidget/setStatus, never append per event). Exactly 2 durable custom entries per delegation (start+completion, customType pi-managed:delegation, DelegationRecorder idempotent). ConnectionManager (SSE disconnect→reconnect→reconcile, polling fallback, offline-completion on startup, error surfaces). Interactive vs delegate forwarding. 44 client-ext tests. **The panel never actually connected — R3.1's SSE-path mismatch. Dedup state was in-memory only until R3.3.** |
| WP-1.13 | (direct commit) | 2026-07-13 | Wiring & E2E: createManagedApp composition root (pool + migrations-on-boot + objectStore + MicrosandboxProvider + SessionManager registry wake/getOrCreate/dispose + idle-eviction), startManagedServer (graceful shutdown), main.ts boot. /readyz now reports db/objectStore/sandbox up. Events route resolves runtime via registry; files outputs wired. docs/deploy.md (§7), docker-compose.yml (postgres+minio). E2E @kvm test PASSED (real Fastify+pool+objectstore+msb ubuntu:22.04, mock brain writes hello.txt, SSE to idle, fork). 324 tests. **This is the composition root that R2 found did not start the background loops, did not resolve secret bindings for real, and did not persist runtime state — "wired" here meant "constructible," not "functionally complete."** |
| WP-1.11c | (direct commit) | 2026-07-13 | Client extension tools: 7 remote_* tools (remote_delegate, remote_start_session, remote_send_event, remote_get_status, remote_list_sessions, remote_read_outputs, remote_fork_session) w/ extremely detailed descriptions (>200 chars each, §11.2). Gating hook (tool_call): confirm→block+reason; autonomous→notice (server budget enforces §24.6). capsToBudget (spendCapPerSession→maxUsd). cost-preview (per-model fallback, labeled estimate). --remote* flags. typebox devDep. api-client: fetchJson + downloadFile. 51 client-ext tests. |
| WP-1.14 | (direct commit) | 2026-07-13 | Phase-1 gate suite (§29.2 exit criteria): (1) credential-injection test @kvm; (2) host-escape test; (3) load test @kvm (N concurrent sessions, heap+RSS, docs/capacity.md); (4) restart test. 340 backend tests pass, 1 skipped. **The load gate ran a fake brain and recorded no VM cost at all — corrected for real by R7.3. The host-escape gate tested `createRemoteTools`, which had zero production call sites — corrected by R2.2.** |
| WP-2.1 | (direct commit) | 2026-07-13 | Scheduled jobs (crons): POSIX cron + IANA tz (spring-forward skip, fall-back double-fire §17.2), ≤10s jitter; minute-tick loop with exactly-once via INSERT ON CONFLICT DO NOTHING on (job_id, scheduled_at) §17.8; catch-up window (5min) + skipped-run records; run records with error taxonomy; pause/unpause (no backfill), archive (terminal; auto-archive when agent archived), manual run (works while paused); failure auto-pause §17.6; one-shot jobs §14.4; 1000-job limit. DST + double-fire + catch-up tests. **This loop was never started by the composition root until R2.3; manual runs poisoned the cursor until R5.3.** |
| WP-2.2 | (direct commit) | 2026-07-13 | Memory stores: stores + memories CRUD; limits (100kB/memory, 2000/store, 8 stores/session, 4096-char instructions); immutable versions (memver_, belong to store, survive deletion, 30-day retention recent-always-kept); contentSha256 optimistic concurrency §13.4; redact (scrub content, preserve audit; head-of-live rejected §13.6); mount pipeline (object store → /mnt/memory/<slug>/, read_only enforced at mount, write-back sync on idle); attach at session creation only. **Mount pipeline had zero production call sites until R6.5.** |
| WP-2.4 | (direct commit) | 2026-07-13 | Vault refresh & re-resolution: mcp_oauth credential type + refresh block (none/client_secret_basic/client_secret_post); periodic re-resolution loop (rotation/archival propagates to running sessions without restart §12.5); validate → valid/invalid/unknown taxonomy §12.5; vault_credential.refresh_failed event emission. Mock OAuth server tests. **No cross-node coordination until R5.5.** |
| WP-2.5 | (direct commit) | 2026-07-13 | Webhooks: register (whsec_ secret shown once, AES-256-GCM encrypted at rest so dispatcher can sign), thin payloads (type+id+createdAt §23.2), X-Webhook-Signature HMAC + 5min tolerance, at-least-once retries w/ persisted Postgres queue (FOR UPDATE SKIP LOCKED, same event.id across retries, 2xx-only ack, no redirect following), auto-disable (~20 failures / immediate on private-IP or redirect), SSRF guard, test-delivery, event sources (session/thread/outcome + vault + job/run). 17 tests. **Dispatcher loop never started until R2.3; claim ran in autocommit (two nodes could double-deliver) until R5.4; the SSRF guard had a TOCTOU + TLS-cert-validation bug until R0.6.** |
| WP-2.6 | (direct commit) | 2026-07-13 | Client extension crons/memory/vault surfaces: /remote:cron <list|create|pause|unpause|run|archive>, /remote:jobs, /remote:memory <list|show|edit|mount>, /remote:vault <list|create|add-cred|validate>. 12 remote_* tools (cron/memory/vault) w/ >200-char descriptions. 17 api-client REST methods. Secrets write-only (tested). 99 client-ext tests. |
| WP-3.1 | (direct commit) | 2026-07-13 | Multi-agent orchestration: ThreadRuntime (per-thread AgentSession), roster (1-20, by-ID/pinned/self, snapshot-at-creation, one-level-only §18.3), Coordinator (parallel/sequence/chain), inter-thread messaging (agent.thread_message_* with from/to §18.6), cross-posting of blocking events to primary thread w/ sessionThreadId routing (§18.7), shared vs isolated modes, ≤25 concurrent threads. Subagent Pi extension. **This module shipped with no tests at all and a `runParallel` filename race, a dead `requires_action` path, and a sandbox leak — all found and fixed by R6.4, which also wrote its first tests.** |
| WP-3.3 | (direct commit) | 2026-07-13 | MCP connector: streamable-HTTP remote servers, two-step config (servers on agent, auth via session vaultIds), URL exact-match incl scheme/trailing slash (§19.5), toolset config (default always_ask §19.4), referential integrity toolset↔server (§19.3), credential-injecting proxy (harness never sees tokens §25.3), failure events (mcp_connection_failed_error/mcp_authentication_failed_error, retry on next idle→running §19.6), 100k-token truncation. **Missing `notifications/initialized` meant compliant servers rejected `tools/list` on first contact — fixed by R6.2.** |
| WP-3.5 | (direct commit) | 2026-07-13 | Skills + full Files: upload (zip/files)→skill_ ID+versions, displayTitle uniqueness, pre-built seeding (pptx/xlsx/docx/pdf per decisions.md, idempotent), materialization (.pi/skills/ or skillsOverride, ≤20/session, latest vs pinned), /skill:name over RPC (§20.4), rubric-ref file fetch (§16.2). Skill routes registered (encapsulated multipart parser). **`skill/seed.ts` was never invoked until R6.5.** |
| WP-3.2 | (direct commit) | 2026-07-13 | Outcomes: user.define_outcome (description, rubric text|fileId, maxIterations default 3 max 20); grader = separate AgentSession w/ own context + rubric reading /mnt/session/outputs/ (§16.1/16.4); iteration loop produce→grade→feedback; result taxonomy (satisfied/needs_revision/max_iterations_reached/failed/interrupted §16.5); one at a time (409), chainable; span.outcome_evaluation_* + session.outcome_evaluation_* events; deliverables via Files API (§16.6). 8 tests. **Only `FakeProducer` existed; the grader's event parsing (`e.data.text`) did not match the runtime's real event shapes — both fixed by R6.3.** |
| WP-3.4 | (direct commit) | 2026-07-13 | Custom tools flow: defineTool shims per custom-tool declaration, execute relays agent.custom_tool_use (customToolUseId=event id), pauses (requires_action + blocking id), resumes on user.custom_tool_result keyed by customToolUseId (§9.4). Permissions don't apply (§22 preamble). Cross-thread via 3.1's cross-posting (ChildThreadCustomToolRelay, §18.7). 11 tests. |
| WP-4.1 | (direct commit) | 2026-07-13 | Self-hosted environments: self_hosted type unlocked (Phase-1 422 removed); work-item queue (enqueue/claim via FOR UPDATE SKIP LOCKED/postResult as user.tool_result §9.2); work-stats endpoint {depth,pending,oldestQueuedAt,workersPolling}; work.stop (+force, org-key auth); environment-scoped worker keys; unsupported-features matrix (no memory stores, no env-var creds → 422 §10.4/§13.7). migration 023. 16 tests. **The runtime no-op'd `user.tool_result`, so the round trip completed for nobody until R2.6/R6.6. Worker-key scoping was enforced only inside 3 routes, not via the (then-nonexistent) scope middleware, until R0.1/R0.2.** |
| WP-4.4 | (direct commit) | 2026-07-13 | Quota enforcement + tiers: QuotaPlan (concurrent sessions/sandboxes, jobs, vault creds, memory stores, file storage, monthly token spend); tier mapping (free/pro/enterprise); enforce.ts (checkQuota at resource-creating endpoints → 429/422 quota_exceeded); quota middleware; GET /v1/tenant reflects real usage vs limits; defaults seeded from capacity.md. **"Seeded from capacity.md" was not true at merge time (that file had no VM cost in it) — corrected by R7.3, and the defaults are now explicitly labelled unjustified policy placeholders in `decisions.md` item 4.** |
| WP-4.5 | (direct commit) | 2026-07-13 | Read-only web console v1 (§26.6): new @pi-managed/web-console package (zero-dep vanilla-JS SPA). Session list (status filter, cursor pagination), tracing view (chronological events, content, timestamps, tokens), usage panel. API-key auth (localStorage, read-only). Served same-origin at /console (assets load without key; /v1/* calls authenticated). 9 web-console + 5 backend console tests. |
| WP-4.2 | (direct commit) | 2026-07-13 | Default self-hosted worker (@pi-managed/worker): always-on poller (outbound HTTPS only, claim→execute→postResult via /work-claim + /work-result) + webhook-triggered mode (wake()); two control levels (builtin runs bash via child_process; spawn hands off to user script for per-session isolation); config (PI_MANAGED_* env + CLI flags); CLI main.ts. 13 tests. |
| WP-4.3 | (direct commit) | 2026-07-13 | Multi-host sandbox scheduling: docs/multi-host-design.md (architecture, placement, re-attach, liveness); sandbox_hosts registry (migration 024); placement router (least-loaded, health filter); MultiHostSandboxProvider (routes provision/exec/stop/start/snapshot/status to owning host's local provider, records owner for re-attach); liveness probing (heartbeat, markUnhealthy, alert). Re-attach across hosts by label-scan. **The composition root could only construct the single-host provider until R6.7; the host-agent channel had no server and no mTLS until R0.4.** |
| WP-5.1 | (direct commit) | 2026-07-13 | Plugin interfaces: PluginRegistry (register/resolve SandboxProvider/SecretStore/ObjectStore/Scheduler/ToolRegistry), default impls as fallback, composition root routes through registry. Published conformance test kits (SandboxProvider/ObjectStore/SecretStore) in testkit. docs/plugins.md authoring guide. 39 testkit tests. |
| WP-5.2 | (direct commit) | 2026-07-13 | Tenant onboarding (SaaS): signup service (creates tenant+admin API key, returns pi install command + backend URL + extension config; idempotent on email), POST /v1/onboarding/signup (public, gated by onboarding.enabled flag). /remote:login OAuth-style flow on the extension (paste-the-key v1). **"Idempotent on email" meant "re-issues a fresh admin key for an existing email" — an unauthenticated tenant-takeover path closed by R0.3.** |
| WP-5.3 | (direct commit) | 2026-07-13 | Billing hooks: BillingSink interface (recordMetering), NoOpBillingSink (default), WebhookBillingSink (HTTPS POST, HMAC-signed X-Webhook-Signature, at-least-once w/ X-Metering-Id dedup). createMeteringHook wired into usage-recorder.ts (onMetering after record). No processor integration. 13 tests. |
| WP-5.4 | (direct commit) | 2026-07-13 | OTEL conventions + dashboards: resolved §30 item 3 (mirror Pi Agent SDK names where they exist + backend-specific additions pi.<domain>.<action>). conventions.ts (span/metric name constants + withSpan/recordTokenUsage helpers). Applied to otel.ts. docs/observability.md (conventions + msb-metrics→OTLP pipeline + instrumentation checklist). 2 Grafana dashboard JSONs (session-overview, sandbox-metrics). **"Applied to otel.ts" described the exporter plumbing, not the emission helpers — `withSpan`/`recordTokenUsage`/`startSpan` have zero production call sites as of this pass; see `decisions.md` item 3, downgraded to PARTIAL.** |
| WP-5.5 | (direct commit) | 2026-07-13 | Tier-config surface: TierConfig schema consolidating all per-tier knobs (maxVaultCredentials=20, maxJobs=1000, concurrent sessions/sandboxes, memory, file storage, token spend, retention days). Loader (env > JSON file > seeded defaults). quota/plans.ts derives from TierConfig. 18 tests. |
| §14 Tasks | (direct commit) | 2026-07-13 | Tasks managed-feature Pi extension: per-session todo tool (create/update/list/get/delete, status pending/in_progress/completed, one in_progress at a time). State in tool-result details (branching-correct §14.2), reconstructed on session_start/session_tree via branch scan. Following examples/extensions/todo.ts. **Not loaded by any composition root until R2.5.** |
| §15 Goals | (direct commit) | 2026-07-13 | Goals & autonomous loops managed-feature Pi extension: create_goal/get_goal/update_goal tools (durable objective + token budget, lifecycle active→paused→completed/blocked §15.4). State in tool-result details (branching-correct). before_agent_start augments system prompt with "Goal active" note (§15.2). Backend session manager drives the turn-by-turn continuation loop (§15.3). Reload pauses (no silent resume §15.2). **Not loaded by any composition root until R2.5.** |
| WP-1.4 | fc07781 (direct commit) | 2026-07-13 | Sandbox Operations adapter: all 7 built-in tools (bash/read/write/edit/grep/find/ls) delegating to SandboxProvider.exec; tool factory asserts no default-ops tool registered (§10.2 completeness mandatory); large-output >100k tokens → sandbox file + truncated preview (§11.3); streaming exec; backend-hosted web_fetch/web_search w/ SSRF guard (deny private/loopback/link-local/metadata, DNS resolve-then-pin, redirect cap); disableUserBash. Host-escape CI test (all 7 tools side effects in VM not host). **The host-escape test drove `createRemoteTools` directly — which had zero production call sites, since `createAgentSession` was called with neither `tools` nor `noTools`, so Pi's default host-executing built-ins ran instead. Fixed by R2.2, which rewrote the gate to drive the real factory.** |
| WP-2.3 | c5ef2eb (direct commit) | 2026-07-13 | Permission policies (always_ask): managed Pi extension intercepting tool_call for always_ask tools → block → session.status_idle + stopReason requires_action + blocking event IDs → await user.tool_confirmation (allow/deny+denyMessage; denied returns rejection tool result §9.5). Policy snapshot at creation (running sessions keep creation-time config §22.2). Built-ins default always_allow, MCP always_ask (§22.1). Multi-blocking-event handling. **Extension not loaded by the composition root, and the runtime no-op'd the inbound `tool_confirmation` event — both closed by R2.5/R2.6, round-trip proven by R6.1.** |
| WP-4.6 | docs/decisions.md | 2026-07-13 | MCP tunnels research spike: DEFER (no-go for v1). Spec §19.1 marks tunnels "limited research preview — phased late"; upstream transport not stabilized; security surface significant. Supported alternatives (remote streamable-HTTP MCP §19.1 + self-hosted workers §10.4) cover practical use cases. Revisit when MCP spec stabilizes tunneling + explicit subscriber request. |

---

## 4. What is NOT proven by this ledger

This is the authoritative Residuals list (formerly in `remediation-plan.md`, removed in the
docs reorg `4421936`):
(1) whether a KVM-labelled self-hosted GitHub Actions runner is actually registered is
an infra fact outside this repo; (2) true steady-state capacity under real, token-driven
model load needs a live provider key this environment does not have — every number in
`docs/capacity.md` is an idle-session floor, not a working-session cost; (3) *resolved
since*: OTEL emission is now wired end-to-end (W8.1 call sites + `initTelemetry` in
`main.ts`, `26d5c97`); the residual is narrower — the per-VM `pi.sandbox.*` gauges still
have no producer (`docs/observability.md` §3); (4) `api-reference-audit.md`'s
retraction was not followed by a full line-by-line re-audit against current code; (5) all
evidence in this pass came from one host in one sitting — multi-node correctness (R5, R6.7)
is proven by mocked multi-node test scenarios, not an actual second node.
