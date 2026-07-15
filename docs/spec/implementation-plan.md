# Pi Managed Backend — Implementation Plan

> **Audience.** This document is executed by AI agents: one **orchestrator** agent that
> schedules, dispatches, reviews, and merges work, and multiple **coding agents** (pi
> subagents running in isolated git worktrees) that implement work packages in parallel.
>
> **Source of truth.** `spec.md` (feature spec, with Appendix A feasibility audit). Every
> work package cites the spec sections (§) that govern it. When this plan and the spec
> disagree, **the spec wins** — flag the discrepancy to the human instead of improvising.
>
> **Scope.** Full roadmap: prerequisite docs (Wave 0) + Phases 0–5 (§29). Phases 0–2 are
> specified at full task-brief resolution; Phases 3–5 at work-package resolution with
> decomposition instructions for the orchestrator.

---

## Table of Contents

1. [Execution Model](#1-execution-model)
2. [Orchestrator Playbook](#2-orchestrator-playbook)
3. [Global Conventions (binding on every agent)](#3-global-conventions)
4. [Dependency Graph Overview](#4-dependency-graph-overview)
5. [Wave 0 — Prerequisite Documents & Scaffold](#5-wave-0--prerequisite-documents--scaffold)
6. [Phase 0 — Foundations](#6-phase-0--foundations)
7. [Phase 1 — Core Managed Sessions (MVP)](#7-phase-1--core-managed-sessions-mvp)
8. [Phase 2 — Scheduling, Memory, Permission Gates](#8-phase-2--scheduling-memory-permission-gates)
9. [Phase 3 — Multi-Agent, Outcomes, MCP](#9-phase-3--multi-agent-outcomes-mcp)
10. [Phase 4 — Self-Hosted Sandboxes + SaaS Hardening](#10-phase-4--self-hosted-sandboxes--saas-hardening)
11. [Phase 5 — Extensibility Polish](#11-phase-5--extensibility-polish)
12. [Cross-Cutting Test Strategy](#12-cross-cutting-test-strategy)
13. [Risk Register & Escalation Triggers](#13-risk-register--escalation-triggers)
14. [Appendix — Task Brief Template](#appendix--task-brief-template)

---

## 1. Execution Model

### 1.1 Roles

- **Orchestrator** (one agent, long-lived): owns the task board, dispatches work packages
  to coding agents, reviews diffs, runs integration gates, merges worktree branches,
  resolves conflicts, escalates to the human. The orchestrator **never implements work
  packages itself** — it only scaffolds, reviews, integrates, and fixes trivial merge
  fallout (<20 lines).
- **Coding agents** (many, ephemeral): each receives a **self-contained brief** (they have
  no memory of this conversation or of each other), implements exactly one work package in
  an isolated git worktree, runs its verification, and reports back.
- **Reviewer agents** (optional, ephemeral): for large or security-sensitive packages the
  orchestrator dispatches a second agent whose only job is adversarial review of the diff
  against the brief and spec sections.
- **Human**: approves phase transitions, resolves `[OPEN]` spec questions, and is the
  escalation target. **Never commit or push without explicit human approval** (project
  rule) — the orchestrator prepares merges on integration branches and asks.

### 1.2 Isolation & integration

- Every coding agent runs with `isolation: "worktree"`. One work package = one branch
  (`wp/<id>-<slug>`).
- **One owner per directory subtree at any moment.** The parallel-group tables in this
  plan are constructed so that concurrently running packages touch disjoint paths. The
  orchestrator must preserve this invariant when re-scoping or adding packages.
- Shared code (the `contracts` package, `testkit`, DB migrations) is a **serialization
  point**: changes to it are their own work packages, and dependent packages wait.
- Integration branch per phase (`phase-0`, `phase-1`, …). Worktree branches merge into the
  phase branch after review; the phase branch merges to `main` only after the phase gate
  passes **and the human approves**.

### 1.3 Contract-first sequencing

The spec explicitly defers the wire contract (§8 "Wire detail is deferred", §30 item 1).
For parallel agents this is the critical path: **no API/resource implementation starts
before the relevant `api-reference.md` section and the `contracts` package types exist.**
Wave 0 produces these synchronization artifacts. Internal seams (sandbox provider,
operations adapter, session manager) similarly get interface-definition packages before
implementation packages.

---

## 2. Orchestrator Playbook

### 2.1 Boot procedure (a fresh orchestrator starts here)

1. Read `spec.md` **in full** (it is ~2200 lines; read all of it — Appendix A contains
   corrections that override intuition).
2. Read this plan in full.
3. Check repo state: which phase branch exists, which WPs are merged (each merged WP
   leaves a line in `docs/spec/progress.md` — see §2.5).
4. Create/update the task board: one `TaskCreate` per unmerged work package in the current
   wave, with the WP ID in the subject and the brief in the description.
5. Dispatch the current parallel group (§2.2). Do not dispatch beyond the group's
   concurrency cap.

### 2.2 Dispatch protocol

For each work package:

1. Mark task `in_progress`.
2. Compose the agent prompt from the [task brief template](#appendix--task-brief-template)
   + the WP's brief in this plan. The prompt must be **self-contained**: include the exact
   spec § numbers to read, file paths to create/modify, interfaces to implement (paste
   them if they already exist), done criteria, and verification commands. Explicitly state
   whether the agent must write code or only docs.
3. Launch with `subagent_type: general-purpose`, `isolation: "worktree"`,
   `run_in_background: true` for parallel groups. Cap concurrency at **4 coding agents**
   unless the human raises it (host RAM + review bandwidth).
4. On completion: **verify, don't trust.** Check out the branch, read the actual diff, run
   the WP's verification commands yourself, and check the done criteria one by one against
   the diff (not against the agent's summary).
5. Pass → merge into phase branch, mark task `completed`, append to `docs/spec/progress.md`.
   Fail → apply the retry policy (§2.4).

### 2.3 Review checklist (every merge)

- [ ] Verification commands pass (typecheck, lint, unit tests; integration tests where the
      environment allows).
- [ ] Diff touches only the WP's owned paths (plus explicitly allowed shared files).
- [ ] Every changed line traces to the brief (project rule: surgical changes).
- [ ] Spec § cross-check: pick the 3 most load-bearing requirements in the brief and find
      them in the diff.
- [ ] Security-sensitive WPs (anything in §12, §22, §25 territory; auth; the operations
      adapter): dispatch a reviewer agent before merging.
- [ ] No secrets, tokens, or provider keys in code, fixtures, or logs.
- [ ] Docs updated where behavior is documented (api-reference, README, docstrings).

### 2.4 Failure & retry policy

- **Attempt 1 fails review** → send precise, itemized feedback via `resume` on the same
  agent (it retains context and the worktree).
- **Attempt 2 fails** → do **not** retry a third time with the same brief. Diagnose: the
  brief is likely wrong or under-specified. Re-scope (split the WP, tighten the interface,
  or fix the brief) and dispatch a **fresh** agent — or escalate to the human if the
  failure suggests a spec problem.
- **Agent reports blocked** (missing dependency, spec ambiguity, upstream bug): record the
  blocker on the task (`addBlockedBy` / description), park it, and pull forward another
  ready WP. Escalate spec ambiguities to the human; never let a coding agent "decide" an
  `[OPEN]` question from §30.

### 2.5 Progress ledger

`docs/spec/progress.md` — append-only table: `| WP | branch | merged-at | notes |`. This is how
a restarted orchestrator recovers state. Update it in the same commit as the merge.

### 2.6 Phase gates

A phase branch merges to `main` only when:

1. All the phase's WPs are merged and green.
2. The phase's **gate suite** (defined per phase below, mirroring §29's "Verify" blocks)
   passes end-to-end.
3. The human approves (show them the gate output).

---

## 3. Global Conventions

Binding on every agent. Established concretely by WP-0.1; summarized here so briefs can
reference them.

### 3.1 Repository layout (pnpm workspace monorepo)

```
/packages
  /contracts          # wire types + zod schemas, generated-adjacent to api-reference.md.
                      # THE synchronization artifact. Changes = dedicated WP.
  /backend            # the service
    /src
      /api            # HTTP routes, one dir per resource family (agents/, sessions/, ...)
      /domain         # business logic, one dir per subsystem (session-manager/, scheduler/,
                      #   vault/, webhook/, memory/, outcome/, multiagent/, ...)
      /infra          # db/ (pg + migrations), objectstore/, sandbox/ (msb provider),
                      #   telemetry/, config/
      /pi-extensions  # managed-feature Pi extensions loaded into AgentSessions
                      #   (tasks/, goals/, permission-gate/, mcp-bridge/, subagent/,
                      #   custom-tools/)
  /client-extension   # @pi-managed/client (§24)
  /worker             # default self-hosted worker (§10.4, Phase 4)
  /web-console        # @pi-managed/web-console — read-only web console (§26.6)
  /testkit            # shared test fixtures: pg testcontainer, fake sandbox provider,
                      #   SSE test client, tenant/api-key factories
/docs
  api-reference.md    # wire contract (Wave 0)
  db-schema.md        # schema doc (Wave 0)
  internal-contracts.md # internal seam interfaces (Wave 0/Phase 1)
  /spec
    spec.md
    implementation-plan.md
    progress.md       # orchestrator ledger
```

### 3.2 Technology decisions (locked; changing one = human escalation)

- Node 20+, TypeScript strict, ESM. pnpm workspaces.
- HTTP: **Fastify** (SSE via reply hijack; JSON schema validation from `contracts` zod
  schemas). DB: **Postgres via `pg`** + a thin query layer; migrations with **node-pg-migrate**
  (SQL files, forward-only). No heavyweight ORM — row-level tenant filtering must be
  auditable (§27.1), so queries stay explicit; a `tenantScoped(query)` helper makes the
  filter mandatory by construction.
- Validation: **zod** (single source in `contracts`, reused server + client extension).
- Tests: **vitest**; integration tests use testcontainers-Postgres; sandbox/KVM tests are
  tagged `@kvm` and run only on the KVM-capable runner.
- IDs: prefixed (`agent_`, `env_`, `sess_`, `vault_`, `mem_`, `memver_`, `skill_`,
  `file_`, `job_`, `wh_` — §6.6), ULID payload, generated server-side.
- Password/API-key hashing: **argon2id** (§8). Secrets encryption at rest: AES-256-GCM
  with a KMS-or-keyfile-provided key (§28).
- Errors: single wire error shape defined in api-reference.md conventions; internal errors
  extend one `BackendError` class with machine-readable `code`.
- Lint/format: eslint + prettier, configured once in WP-0.1; agents never restyle
  neighboring code.

### 3.3 Reference material paths (paste into briefs that need them)

- Pi SDK docs: `/home/mauro/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs`
  (`sdk.md`, `extensions.md`, `session-format.md`, `rpc.md`, `skills.md`, `compaction.md`)
  and `examples/` (`extensions/todo.ts`, `extensions/subagent/`,
  `extensions/permission-gate.ts`, `extensions/ssh.ts`).
- microsandbox: pinned version per WP-1.3; docs live in the upstream repo
  (`docs/sandboxes/*.mdx`, `docs/security/*.mdx`, `sdk/node-ts/`). Appendix A of `spec.md`
  lists the exact evidence files.
- `pi-goal` reference: local `node_modules/pi-goal/README.md` (per Appendix A.2 #10).

### 3.4 Rules every coding agent must be told

1. Work only inside your assigned paths. If you believe you must touch a shared file not
   listed in your brief, **stop and report** — do not edit it.
2. The spec (§ refs in your brief) is authoritative. If the brief contradicts the spec,
   report the contradiction; don't pick silently.
3. Verify before reporting: run the listed commands; report actual output honestly.
4. No new dependencies without listing them in your report (orchestrator approves).
5. Never place provider credentials in `process.env`, code, or fixtures (§4.2, §25).
6. Match existing conventions exactly; no drive-by refactors.
7. Do not commit — leave the worktree dirty-or-committed per orchestrator instruction
   (default: commit to your branch, never push, never merge).

---

## 4. Dependency Graph Overview

```
WAVE 0 (docs + scaffold; mostly parallel)
  WP-0.1 scaffold ──────────────┐
  WP-0.2 api-ref conventions ─┬─┼────────────┐
  WP-0.3..0.6 api-ref parts ◀─┘ │ (0.3–0.6 parallel, after 0.2)
  WP-0.7 api-ref audit ◀── 0.3..0.6          │
  WP-0.8 db-schema.md ◀── 0.2 (soft)         │
  WP-0.9 contracts pkg ◀── 0.7, 0.1          │
  WP-0.10 internal-contracts.md ◀── 0.1      │
                                             ▼
PHASE 0 (after 0.1; parallel where shown)
  WP-P0.1 config/logging/OTEL/health
  WP-P0.2 pg layer + migrations + tenant scoping   (∥ P0.1, P0.3)
  WP-P0.3 object store                              (∥ P0.1, P0.2)
  WP-P0.4 tenants + api-keys + auth ◀── P0.2, 0.9
  WP-P0.5 http cross-cutting (idempotency, 429, pagination) ◀── P0.2, 0.9
  GATE-0 ◀── all P0.*

PHASE 1 (after GATE-0 + WP-0.9 + WP-0.10)
  group A (∥): WP-1.1 agents API │ WP-1.2 environments API │ WP-1.3 msb provider
               │ WP-1.9 vaults │ WP-1.11a extension skeleton
  group B (∥): WP-1.4 ops adapter ◀─1.3 │ WP-1.5 session manager ◀─1.10*
               │ WP-1.6 sessions API ◀─1.1,1.2 │ WP-1.10 usage/budget
  group C (∥): WP-1.7 events+SSE ◀─1.5,1.6 │ WP-1.8 toolset config ◀─1.5
               │ WP-1.12 files API (outputs) ◀─1.6 │ WP-1.11b ext commands+panel ◀─1.7
  group D (∥): WP-1.11c ext tools+gating ◀─1.11b │ WP-1.13 wiring/E2E ◀─all
  WP-1.14 phase-1 verification suite ◀── 1.13
  GATE-1 ◀── 1.14

PHASE 2 (after GATE-1; all five subsystems parallel)
  WP-2.1 scheduler │ WP-2.2 memory stores │ WP-2.3 permission gates
  │ WP-2.4 vault refresh/re-resolution │ WP-2.5 webhooks
  then WP-2.6 extension additions ◀─ 2.1,2.2,2.4 ; GATE-2

PHASE 3 (after GATE-2)
  WP-3.1 multi-agent │ WP-3.3 MCP connector │ WP-3.4 custom tools │ WP-3.5 skills+files-full
  WP-3.2 outcomes ◀─ 3.1 (grader is a subagent) ; GATE-3

PHASE 4 (after GATE-3)
  WP-4.1 self-hosted envs ─ WP-4.2 default worker ◀─4.1
  │ WP-4.3 multi-host scheduling │ WP-4.4 quotas/tiers │ WP-4.5 web console
  │ WP-4.6 MCP tunnels (research spike) ; GATE-4

PHASE 5 (after GATE-4)
  WP-5.1 plugin interfaces │ WP-5.2 onboarding │ WP-5.3 billing hooks
  │ WP-5.4 OTEL conventions+dashboards │ WP-5.5 tier limits ; GATE-5
```

`*` WP-1.5 needs WP-1.10's usage-recording interface only; the orchestrator can extract
that interface into `internal-contracts.md` first and run them in parallel.

---

## 5. Wave 0 — Prerequisite Documents & Scaffold

**Purpose:** produce the synchronization artifacts that make parallel implementation safe:
the wire contract, the DB schema, the internal seam interfaces, the repo scaffold, and the
`contracts` package. Doc WPs here are **writing tasks, not coding tasks** — say so in the
briefs.

**Resolution of §30 items required during Wave 0** (orchestrator asks the human once,
batched, before dispatching WP-0.2): final event-type strings policy (accept the
provisional §9.2 names?), default pre-built skills (item 11), default tool timeout (item
5), retention default (item 6), `rescheduling` retry policy (item 7). Record answers in
`docs/spec/decisions.md`.

### WP-0.1 — Repo scaffold & conventions

- **Depends on:** nothing. **Parallel with:** WP-0.2, WP-0.8.
- **Owns:** repo root, all package skeletons, CI config.
- **Deliverables:** pnpm workspace per §3.1; tsconfig (strict, ESM) + eslint + prettier +
  vitest wiring; empty-but-compiling packages (`contracts`, `backend`, `client-extension`,
  `testkit`); CI pipeline (typecheck, lint, unit; a separate `@kvm` job stub);
  `docs/spec/progress.md` + `docs/spec/decisions.md` seeded; `CONVENTIONS.md` capturing §3.2.
- **Done when:** `pnpm -r build && pnpm -r test` passes on a fresh clone; CI config lints.

### WP-0.2 — api-reference.md: conventions & cross-cutting semantics

- **Depends on:** decisions batch (above). **Spec:** §8 preamble, §6.6, §9.1, §27.1.
- **Deliverables:** `docs/api-reference.md` skeleton with: auth (`Authorization: Bearer`),
  error envelope (single JSON shape + machine `code` taxonomy), status-code policy,
  cursor pagination contract, `Idempotency-Key` semantics (scope, replay window, conflict
  behavior), 429 + `Retry-After`, ID format, name rules (1–128 chars, per-tenant unique),
  timestamp format, `metadata` field rules, versioned base path `/v1`, event-type naming
  scheme (`{domain}.{action}` — finalize the §9.2 provisional strings here).
- **Done when:** every later section can be written against it without inventing a
  convention; reviewed by a reviewer agent against §8/§9.

### WP-0.3 … WP-0.6 — api-reference.md: resource sections (4 parallel agents, after WP-0.2)

Each agent writes exact request/response JSON schemas, field constraints, status codes,
and examples for its family. Each **must not** edit WP-0.2's conventions section — file is
split by heading ownership; orchestrator merges.

| WP | Families | Spec sections |
|---|---|---|
| 0.3 | Agents, Environments, Sessions (incl. agent-field 3 forms, session state machine, budget) | §6.1–6.3, §8.1–8.3 |
| 0.4 | Events catalog + SSE wire format (persisted events, deltas, `Last-Event-ID` replay, custom-tool & confirmation flows, `system.message`) | §8.4, §9 |
| 0.5 | Vaults, Memory stores, Files, Skills, Outcomes | §8.5, §8.6, §8.9–8.11, §12, §13, §16, §20, §21 |
| 0.6 | Scheduled jobs, Webhooks (payload shape, signatures, auto-disable), Tenant/admin, self-hosted work queue (stub for Phase 4) | §8.7, §8.8, §8.12, §17, §23, §10.4 |

- **Done when:** every endpoint in §8 has schemas; every §9.2 event has a schema; every
  constraint in the spec's resource sections (limits, immutability, cascade rules) appears
  as a normative statement.

### WP-0.7 — api-reference.md consistency audit

- **Depends on:** 0.3–0.6. **A reviewer agent**, fresh context.
- **Brief:** read spec §6, §8–§9, §12–§23 and the full api-reference; produce a defect list
  (contradictions, missing endpoints/fields, convention violations, borrowed API idioms
  that leaked in against §2 "not a clone"). Orchestrator routes fixes back to the owning WP
  agents (resume), then re-audits. **Human reviews and approves the final doc** — it is
  the contract everything else builds on.

### WP-0.8 — db-schema.md

- **Depends on:** WP-0.2 (soft — conventions for IDs). **Parallel with:** 0.3–0.6.
- **Spec:** §28 (authoritative table), §27, §6, §12.4, §13.5, §17.8, §23.6.
- **Deliverables:** `docs/db-schema.md`: every Postgres table (columns, types, indexes,
  FKs), with mandatory `tenant_id` on every tenant-scoped table; unique constraints the
  spec demands (`(job_id, scheduled_at)` run claim §17.8; per-tenant name uniqueness §6.6;
  vault key uniqueness §12.4); encrypted-column strategy for secrets; what is **not** in
  Postgres (JSONL conversation — §28 "does not duplicate"); object-store key layout
  (JSONL sync path, memory stores, files, skill bundles, snapshots); retention/purge
  columns (30-day windows §6.3/§13.5).
- **Done when:** every state row in §28's table has DDL; a reviewer agent confirms no
  resource in §6/§8 lacks storage.

### WP-0.9 — `contracts` package

- **Depends on:** WP-0.7 (approved api-reference), WP-0.1.
- **Owns:** `packages/contracts`.
- **Deliverables:** zod schemas + inferred TS types for every request/response body,
  every persisted event, SSE frame types, error envelope, ID validators/prefix helpers.
  Organized by resource family mirroring api-reference headings. Include a
  `contracts/README.md` stating: *this package mechanically mirrors api-reference.md;
  change the doc first, then this package, in the same WP*.
- **Done when:** package builds; a golden test validates every example payload from
  api-reference.md against its schema (copy examples into fixtures).

### WP-0.10 — internal-contracts.md (seam interfaces)

- **Depends on:** WP-0.1. **Parallel with:** WP-0.9. **Spec:** §5.4, §10.2, §29.6.
- **Deliverables:** `docs/internal-contracts.md` + `packages/backend/src/domain/ports.ts`
  (or a small `ports/` dir): TypeScript interfaces for the internal seams so Phase-1
  packages can build against fakes in parallel:
  - `SandboxProvider` — `provision(spec) → SandboxHandle`, `exec`, `execStream`, `stop`,
    `start`, `snapshot`, `destroy`, `reattachByLabels`, `status` (incl. `crashed`),
    secret-binding registration, network-policy compilation (`unrestricted`→publicOnly,
    `limited`→default-deny+allowHost — §6.2, §10).
  - `SessionRuntime` — `wake(sessionId)`, `sendEvent`, `subscribe`, `interrupt`,
    `getEntries(range)` (§5.4).
  - `SecretStore`, `ObjectStore`, `UsageRecorder` (tokens per provider report + price
    table — §9.7), `Clock`/`Scheduler` tick abstraction, `WebhookSink`.
  - Fake implementations of each in `packages/testkit`.
- **Done when:** interfaces compile; testkit fakes exist; a reviewer agent checks each
  interface against the spec §s cited above (especially that nothing in an interface
  would force credentials through the harness — §25.5).

**Wave-0 gate:** api-reference approved by human; contracts package golden tests green;
db-schema reviewed; internal contracts reviewed. Merge `wave-0` → `main` (with human
approval).

---

## 6. Phase 0 — Foundations

**Spec:** §29.1, §7, §27, §28. **Goal:** deployable skeleton: auth, tenants, storage.

### WP-P0.1 — Service scaffold: config, logging, OTEL, health

- **Owns:** `backend/src/infra/config`, `infra/telemetry`, `src/server.ts`, `api/health`.
- **Brief:** Fastify app factory; layered config (env vars > config file > defaults) with
  zod-validated config schema; structured JSON logging (pino) with tenant/session
  correlation fields; OTEL SDK wiring via `OTEL_*` env vars (§26.5 — use backend-specific
  span names for now; conventions finalized in WP-5.4); `/healthz` (liveness) and
  `/readyz` (readiness: pg + object store + sandbox runtime checks, each pluggable).
- **Done:** server boots with no DB (readyz red, healthz green); config errors are fatal
  with a clear message; unit tests for config precedence.

### WP-P0.2 — Postgres layer, migrations, tenant scoping

- **Owns:** `backend/src/infra/db`, `migrations/`. **Depends:** WP-0.8.
- **Brief:** pg pool wiring; node-pg-migrate setup; initial migrations for the Phase-0/1
  tables from db-schema.md (tenants, api_keys, agents, agent_versions, environments,
  sessions, events-metadata if any, vaults, vault_credentials, files, usage); the
  `tenantScoped` query helper that makes it **impossible to run a tenant-scoped query
  without a tenantId** (compile-time: helper takes `TenantCtx` as first arg; runtime:
  assert the SQL references `tenant_id`); testcontainers harness in `testkit`.
- **Done:** migrations up/down clean; a negative test proves the helper rejects an
  unscoped query; cross-tenant read returns nothing (row-level filter test — §29.1
  verify).

### WP-P0.3 — Object store abstraction

- **Owns:** `backend/src/infra/objectstore`. **Parallel with:** P0.1/P0.2.
- **Brief:** `ObjectStore` port (WP-0.10) with two impls: local filesystem (v1 default,
  §7.3) and S3-compatible (SaaS). Keys per db-schema.md layout. Streaming get/put,
  conditional put (for JSONL sync), versioning capability flag (§28 backup note).
- **Done:** contract test suite runs against both impls (fs always; S3 against MinIO
  container in integration CI).

### WP-P0.4 — Tenants, API keys, auth middleware

- **Owns:** `backend/src/domain/tenant`, `api/tenant`, auth middleware. **Depends:**
  P0.2, WP-0.9. **Security-sensitive → reviewer agent required.**
- **Brief:** tenant model (single-tenant deployments auto-create the implicit tenant —
  §7.1); API-key issuance (`POST /v1/api-keys`, list, revoke — §8.12) with argon2id-hashed
  storage, shown once (§8); bearer auth middleware resolving key → `TenantCtx` attached to
  every request; `GET /v1/tenant` with quota-usage stub.
- **Done:** §29.1 verify block: curl an authenticated endpoint; create tenant + key;
  negative cross-tenant test (key A cannot see tenant B's resources — implement against a
  dummy resource if agents API not merged yet).

### WP-P0.5 — HTTP cross-cutting: idempotency, rate limiting, pagination

- **Owns:** `backend/src/api/middleware`. **Depends:** P0.2, WP-0.9.
- **Brief:** `Idempotency-Key` middleware per api-reference (persisted response replay,
  conflict on same-key-different-body); 429 + `Retry-After` (per-tenant token bucket,
  limits from config); cursor-pagination helpers matching the contract; wire the error
  envelope from `contracts` as the global error handler.
- **Done:** unit tests per behavior; a replayed POST returns the stored response byte-for-byte.

**GATE-0** (§29.1 verify): fresh deploy from README instructions; authenticated curl;
tenant + key issuance; cross-tenant negative test. Orchestrator runs these literally, then
requests human approval to merge `phase-0` → `main`.

---

## 7. Phase 1 — Core Managed Sessions (MVP)

**Spec:** §29.2 + §4–§6, §9–§12, §24. The largest phase. Sequenced as four parallel
groups (see §4 graph). Everything here builds against `contracts` (wire) and `ports`
(internal seams); packages in the same group must not share paths.

### Group A (5 parallel agents)

#### WP-1.1 — Agents API

- **Owns:** `backend/src/api/agents`, `domain/agent`. **Spec:** §6.1, §8.1.
- **Brief:** CRUD per api-reference: create/list/get/update/archive/versions. Update
  creates a new immutable version; archive is terminal (no unarchive, blocks new
  sessions); no hard delete; per-tenant name uniqueness; `metadata` passthrough. Agent
  config validation: tools allow/exclude lists, skills refs, extensions refs, mcpServers
  (validate shape only — MCP lands Phase 3; enforce the §19.3 toolset↔server referential
  rule at the schema level now). Store as versioned config blobs.
- **Done:** integration tests for all lifecycle rules (esp. archived-agent-blocks-new-session
  exposed as a domain function for WP-1.6 to call); OpenAPI-ish parity check vs
  api-reference.

#### WP-1.2 — Environments API

- **Owns:** `backend/src/api/environments`, `domain/environment`. **Spec:** §6.2, §8.2.
- **Brief:** CRUD incl. hard delete **and** archive (both exist — §6.2); `cloud` type
  only (reject `self_hosted` with a clear "Phase 4" error); fields: image, resources,
  networking (`unrestricted`/`limited`+allowedHosts), packages, mounts, maxDuration,
  idleTimeout; not versioned. Compile-to-sandbox-spec function (env → `SandboxProvider`
  provision spec, incl. network-policy mapping §6.2) lives here, tested against the fake
  provider.
- **Done:** CRUD integration tests; policy compilation unit tests (`unrestricted` ≠
  allowAll; `limited` = default-deny + explicit hosts).

#### WP-1.3 — microsandbox provider (real `SandboxProvider`)

- **Owns:** `backend/src/infra/sandbox`. **Spec:** §5.3, §10.1, §10.3, §10.5, §27.2,
  §30 item 13, Appendix A.1. **Needs the KVM runner.**
- **Brief:** pin exact msb version (record in `docs/spec/decisions.md`); implement
  `SandboxProvider` on the NAPI SDK: `Sandbox.builder()` with tenant-namespaced names
  (`t<tenant>-s<session>`), labels, `.detached(true)`, volumes, env/secret bindings,
  network policies; exec + execStream over the control channel with cwd/env/timeout/rlimit
  passthrough; stop/start (checkpoint/resume — cold boot, processes lost §10.3); snapshot;
  crash detection (`crashed` status); boot-time re-attach by labels (§4.2); secret-binding
  purge on session end + msb home dir permissions note (§12.1 constraints). Start the
  **upstream-upgrade test suite** (§30 item 13): secrets substitution, egress policy,
  stop/start, snapshot — tagged `@kvm`, doubles as the version-bump gate.
- **Done:** `@kvm` suite green on the KVM host; fake-vs-real contract test parity (same
  contract tests run against testkit fake and real provider).
- **Orchestrator note:** confirm KVM availability on the target host **before**
  dispatching (§30 item 12 for primus — but access to servers requires explicit human
  request; ask the human where `@kvm` CI runs).

#### WP-1.9 — Vaults (basic) + egress substitution wiring

- **Owns:** `backend/src/api/vaults`, `domain/vault`. **Spec:** §8.5, §12 (except §12.3
  refresh → Phase 2), §25.1, §25.4. **Security-sensitive → reviewer agent.**
- **Brief:** vault + credential CRUD; categories `static_bearer` and
  `environment_variable` (mcp_oauth lands Phase 2/3); write-only sensitive fields (never
  serialized out — enforce in the contracts schema *and* a serialization test); unique
  immutable keys per vault; max 20 creds (config); archive-cascade vs hard-delete
  semantics (§12.7); encrypted at rest (P0.2 column strategy). Expose
  `resolveBindingsForSession(sessionCtx) → SecretBinding[]` for the session manager: env-var
  creds become msb secret bindings (`$MSB_<VAR>` placeholders — §12.1); document the
  verified constraints (TLS interception; gzipped/H2/large bodies blocked) in the API
  error copy so agents get clear tool errors.
- **Done:** serialization test proves no secret ever leaves; binding resolution unit
  tests; archive/delete cascade tests.

#### WP-1.11a — Client extension skeleton: config, auth, API client

- **Owns:** `packages/client-extension` (src/config, src/api-client). **Spec:** §24.3,
  §24.4, §24.11, §24.13.
- **Brief:** extension entry point registering nothing user-visible yet; settings schema
  (`piManaged.*` keys per §24.4 table); `auth.json` storage via Pi's `AuthStorage`
  (`apiKeyRef` — never the raw key in settings); env-var overrides
  (`PI_MANAGED_BACKEND_URL`, `PI_MANAGED_API_KEY`); typed API client generated over
  `contracts` (REST + SSE consumer with `Last-Event-ID` reconnect + polling fallback per
  §24.9/§24.10); `/remote:config` command incl. first-run flow + `GET /v1/tenant`
  validation; version-compat warning (§24.13). Read Pi's `docs/extensions.md` fully first.
- **Done:** loads in a local Pi; `/remote:config` round-trips against a mock server
  (testkit provides one); unit tests for settings/env precedence and SSE reconnect.

### Group B (4 parallel agents; dispatch each as its dependency merges)

#### WP-1.4 — Sandbox Operations adapter (all seven tools)

- **Owns:** `backend/src/domain/session-manager/operations`. **Depends:** 1.3 (real) +
  testkit fake. **Spec:** §5.3–5.4, §10.2, §11.1, §11.3. **Security-critical → reviewer
  agent mandatory.**
- **Brief:** implement Pi's `*Operations` for **all seven** built-ins (`bash`, `read`,
  `write`, `edit`, `grep`, `find`, `ls`) delegating to `SandboxProvider.exec` (read Pi's
  `docs/extensions.md` "Remote Execution" + `examples/extensions/ssh.ts` first). Build the
  session tool factory that constructs every tool with remote operations and **asserts at
  construction that no default-ops tool is registered** (§10.2 "completeness is
  mandatory"); disable host-executing paths (`user_bash`). Large-output policy: >100k
  tokens → write to sandbox file, return truncated preview + path (§11.3). Streaming exec
  → streaming tool results. Backend-hosted `web_fetch`/`web_search` tools with the §11.1
  SSRF guard (deny private/loopback/link-local/metadata; DNS resolve-then-pin; redirect
  cap with per-hop re-check; no internal creds on egress).
- **Done:** the **host-escape CI test** (§10.2/§29.2): for each of the seven tools,
  perform a side-effecting call and prove effects exist in the VM and are absent on the
  host (`@kvm`); construction-time assertion test; SSRF guard unit tests (metadata IP,
  rebinding, redirect-to-private).

#### WP-1.5 — Session manager (the harness)

- **Owns:** `backend/src/domain/session-manager` (except `operations/`). **Depends:**
  ports (0.10), usage interface (1.10 extracted). **Spec:** §4.2, §5, §6.3 state machine,
  §28 durability. Read Pi `docs/sdk.md` + `docs/session-format.md` fully.
- **Brief:** per-session `AgentSession` lifecycle: materialize agent config →
  `createAgentSession()` with `AuthStorage.inMemory()` (provider keys from agent config —
  never process env), `SettingsManager.inMemory()`, explicit cwd, per-session
  `DefaultResourceLoader({ extensionFactories })` (§4.2, Appendix A.2 #1/#13);
  `wake(sessionId)` from JSONL (§5.2); state machine `idle → running → rescheduling →
  terminated` with `stopReason`s; idle policy loop (idleTimeout → provider.stop; resume →
  provider.start + surface "processes not preserved" to the model §10.3); crash recovery
  (crashed sandbox → re-provision → resume from log); JSONL durability: local write +
  object-store sync on every idle transition + 30s periodic while running (§28); boot-time
  re-attach walk (§4.2).
- **Done:** integration tests with fake provider: full lifecycle, kill-and-wake recovery,
  JSONL sync points observed; state-machine property tests; no test reads process-global
  Pi config (assert isolation).

#### WP-1.6 — Sessions API

- **Owns:** `backend/src/api/sessions`, `domain/session` (resource layer above the
  runtime). **Depends:** 1.1, 1.2 merged; 1.5 interface. **Spec:** §6.3, §8.3, §30 item 8.
- **Brief:** create (three agent forms: bare ID / pinned / overrides with
  omit-inherit·null-clear·value-replace — §6.3; provisions sandbox lazily, no work starts);
  list/get with status+usage; PATCH tools/mcpServers only, idle-only, full-replacement;
  delete (archive JSONL, independent resources untouched); **fork = new session resource
  sharing the JSONL tree to the fork point** (Pi-native, not a copy — §30 item 8);
  entries/tree/messages/usage read endpoints over `SessionRuntime.getEntries` + Pi's
  post-compaction messages view; budget field stored + handed to WP-1.10 enforcement.
- **Done:** integration tests for all three agent forms, override semantics matrix,
  idle-only update rejection, fork sharing (edit-after-fork isolation), delete
  independence (§6.3).

#### WP-1.10 — Usage tracking & budget enforcement

- **Owns:** `backend/src/domain/usage`. **Spec:** §6.3 budget, §9.7, §26.2.
- **Brief:** `UsageRecorder` impl: per-model-request token capture from Pi events
  (input/output/cache-create/cache-read as the provider reports — provider-dependent,
  §9.7), per-model price table (config file) → USD; cumulative per-session rollup (DB);
  budget enforcement hook: when `maxTokens`/`maxUsd` exceeded → interrupt session → `idle`
  with `stopReason: budget_exhausted` (§6.3). Per-tenant rollup query for §8.12.
- **Done:** unit tests incl. unknown-model fallback pricing; enforcement integration test
  with a scripted fake model.

### Group C (4 parallel agents)

#### WP-1.7 — Events API + SSE streaming

- **Owns:** `backend/src/api/events`, `domain/event-stream`. **Depends:** 1.5, 1.6.
  **Spec:** §8.4, §9.1–9.3, §9.6–9.7.
- **Brief:** `POST /events` (`user.message` starts/continues; `user.interrupt`;
  `system.message` per §9.6 — rejected while `requires_action`); persisted-event list
  (paginated); SSE stream: persisted frames carry SSE `id` = sequence position,
  `Last-Event-ID` replay from the session log (§9.3); opt-in deltas
  (`?eventDeltas=agent.message`): `event_start`/`event_delta`/buffered reconcile, never
  persisted, never replayed, primary thread text only; `processedAt` semantics (§9.1).
  Map Pi `AgentSession` subscribe events → wire event types per contracts.
- **Done:** SSE integration tests: reconnect-with-gap replay is gap-free for persisted
  events and delta-free; delta opt-in matrix; interrupt round-trip.

#### WP-1.8 — Built-in toolset configuration

- **Owns:** `backend/src/domain/toolset`. **Depends:** 1.5 interfaces. **Spec:** §11.1
  (config shape), §22.2 (storage only — gate behavior is Phase 2).
- **Brief:** `defaultConfig` + per-tool `configs` (enable/disable/override), everything-off
  pattern; validation against known tool names; materialization into the session factory
  (which tools get constructed); store `permissionPolicy` per tool (enforced Phase 2 —
  persist and expose now so agent configs are forward-compatible).
- **Done:** unit tests for the config algebra; session-factory integration (disabled tool
  absent from the model's tool list).

#### WP-1.12 — Files API (session outputs slice)

- **Owns:** `backend/src/api/files`, `domain/file`. **Depends:** 1.6, P0.3. **Spec:**
  §8.9, §21, §16.6, §24.8.
- **Brief:** upload (multipart)/list/get/download/delete over object store; session-scoped
  outputs listing: enumerate `/mnt/session/outputs/` of an **idle** session's sandbox and
  expose as downloadable files (the `remote_read_outputs` surface). *Note: the spec's
  §29.2 list omits Files, but J1/§24.8 requires it in Phase 1 — this plan pulls the
  minimal slice forward; full reuse (rubric refs) lands Phase 3.*
- **Done:** upload/download round-trip; outputs fetch from a fake-provider session;
  idle-only enforcement.

#### WP-1.11b — Client extension: commands + live-view panel

- **Owns:** `client-extension/src/commands`, `src/panel`. **Depends:** 1.11a, 1.7 (real
  SSE shape). **Spec:** §24.2, §24.5, §24.7, §24.9, §24.10.
- **Brief:** commands `/remote:start`, `/remote:resume`, `/remote:sessions`,
  `/remote:delegate`, `/remote:attach`, `/remote:fork`; live-view panel exactly per §24.7:
  **two** durable `custom` entries per delegation (start marker + completion summary,
  `customType: "pi-managed:delegation"`, rendered via `registerEntryRenderer`); all live
  state via `ctx.ui.setWidget`/`setStatus` (never appended per remote event); interactive
  vs delegate forwarding rules (§24.7 step 4); disconnect/reconnect UX + polling fallback;
  offline-completion surfacing on startup (§24.9); error surfaces (§24.10). Commands must
  be RPC-invokable (extension commands are — §24.5).
- **Done:** manual E2E against the phase-1 backend (orchestrator runs this at GATE-1);
  unit tests for entry-append discipline (exactly 2 entries per delegation) and forwarding
  rules.

### Group D

#### WP-1.11c — Client extension: agent-facing tools + gating

- **Owns:** `client-extension/src/tools`. **Depends:** 1.11b. **Spec:** §24.6, §24.11.
  **Security-sensitive → reviewer agent.**
- **Brief:** tools per §24.6 table (`remote_delegate`, `remote_start_session`,
  `remote_send_event`, `remote_get_status`, `remote_list_sessions`,
  `remote_read_outputs`, `remote_fork_session`; cron/memory/vault tools stubbed until
  their backend features exist — register only what works). **Extremely detailed tool
  descriptions** (§11.2 — this is called out twice in the spec; treat description quality
  as a done-criterion). Gating: `delegationPolicy` `confirm` → `tool_call` hook blocks +
  confirm dialog; `autonomous` → non-blocking cost notice, confirm above
  `confirmThreshold`; cost preview from historical median with per-model fallback, labeled
  an estimate; **map spend caps to the server-side `budget` field on session create**
  (client caps are UX; the server enforces — §24.6). `--remote*` flags via `registerFlag`.
- **Done:** gating matrix tests (policy × threshold); created sessions carry `budget`;
  outputs land under `outputsDir` and are returned as local paths.

#### WP-1.13 — Wiring & E2E assembly

- **Owns:** `backend/src/server.ts` composition root, `docs/deploy.md`. **Depends:** all
  of groups A–C.
- **Brief:** compose all subsystems in the app factory; deployment doc (single binary +
  Postgres + object store + msb home, per §7); docker-compose for dev; an E2E test
  script: create agent → environment → session → send `user.message` → agent writes a
  file in the VM → goes idle → fetch outputs → resume → fork.
- **Done:** E2E green against the real provider on the KVM runner.

#### WP-1.14 — Phase-1 verification suite (§29.2 exit criteria)

- **Owns:** `backend/test/phase1-gate`. **Depends:** 1.13. **Spec:** §29.2 verify block,
  §30 items 4/15.
- **Brief:** four gate tests, runnable as one command:
  1. **Credential-injection test:** vault env-var secret; from inside the sandbox prove
     the value is unreadable (env, msb config, git config) while an egress call to an
     allowed host authenticates.
  2. **Host-escape test:** re-run WP-1.4's seven-tool suite in the assembled system.
  3. **Load test:** N concurrent sessions (N set with the human); measure per-session
     heap + VM RSS; produce the capacity-envelope report (feeds quota defaults, §30
     items 4/15). Record results in `docs/capacity.md`.
  4. **Restart test:** `kill -9` mid-turn; detached VMs survive; sessions resume from the
     log; (scheduler double-fire check deferred to Phase 2 — note it).
- **Done:** all four pass; capacity report written.

**GATE-1** (orchestrator, then human): run §29.2's verify narrative literally — install
extension in a local Pi, `/remote:delegate "write a hello world node app"`, watch the
panel, resume after idle, fork; plus WP-1.14 suite. Human approves `phase-1` → `main`.

---

## 8. Phase 2 — Scheduling, Memory, Permission Gates

**Spec:** §29.3. Five independent subsystems → five parallel agents, then extension
additions. All build on merged Phase-1 code; owned paths are disjoint.

#### WP-2.1 — Scheduled jobs (crons)

- **Owns:** `backend/src/domain/scheduler`, `api/jobs`. **Spec:** §8.7, §17, §14.4.
- **Brief:** jobs CRUD; POSIX cron + IANA timezone with literal wall-clock semantics
  (spring-forward skip, fall-back double-fire — §17.2), ≤10s jitter; minute-tick loop with
  **exactly-once via `INSERT … ON CONFLICT DO NOTHING` on `(job_id, scheduled_at)`**
  (§17.8); catch-up window (default 5 min) + skipped-run records; run records with error
  taxonomy (§17.4); pause/unpause (no backfill), archive (terminal; auto-archive when
  agent archived), manual run (works while paused); failure auto-pause with
  `pausedReason.error.type` mirroring (§17.6); rate-limited run recorded without retry;
  one-shot jobs (single-fire schedule) for remote delegation (§14.4); 1,000-job tenant
  limit (config).
- **Done:** §29.3 verify (every-minute cron fires, run records, pause/resume); DST unit
  tests with fixed clocks; double-fire test: two scheduler loops against one DB, each
  occurrence fires once; kill-9 catch-up test (closes the Phase-1 deferred check).

#### WP-2.2 — Memory stores

- **Owns:** `backend/src/domain/memory`, `api/memory-stores`. **Spec:** §8.6, §13.
- **Brief:** stores + memories CRUD; limits (100kB/memory, 2,000/store, 8 stores/session,
  4,096-char instructions); immutable versions (`memver_`, belong to the store, survive
  memory deletion, 30-day retention with recent-always-kept); `contentSha256` optimistic
  concurrency (§13.4); redact (content scrubbed, audit preserved; head-of-live-memory
  rejected — §13.6); mount pipeline: object store → volume staged into the sandbox at
  `/mnt/memory/<slug>/` (slug rule §13.3), `mountPath` on the session resource,
  `read_only` enforced at mount level, write-back sync on idle; system-prompt note per
  mount (§13.1); attach at session creation only.
- **Done:** §29.3 verify (attach read-only; agent write fails); version/redact/concurrency
  integration tests; write-back round-trip across two sessions sharing a store (`@kvm`).

#### WP-2.3 — Permission policies (`always_ask`)

- **Owns:** `backend/src/pi-extensions/permission-gate`, event-flow glue in
  `domain/event-stream`. **Spec:** §9.5, §22. Read Pi
  `examples/extensions/permission-gate.ts` first.
- **Brief:** managed-feature Pi extension intercepting `tool_call` for `always_ask` tools
  → block → emit `session.status_idle` + `stopReason: requires_action` + blocking event
  IDs → await `user.tool_confirmation` (`allow`/`deny`+`denyMessage`; denied call returns
  a rejection tool result — §9.5); defaults: built-ins `always_allow`, MCP `always_ask`
  (§22.1); running sessions keep creation-time config (§22.2); WP-1.8's stored policies
  now enforced.
- **Done:** §29.3 verify (confirmation round-trip); multi-blocking-event test; deny-message
  propagation test.

#### WP-2.4 — Vault refresh & re-resolution

- **Owns:** `domain/vault` (extend), `api/vaults` (validate endpoint). **Spec:** §12.3,
  §12.5, §8.5. **Security-sensitive → reviewer agent.**
- **Brief:** `mcp_oauth` credential type + refresh block (`none`/`client_secret_basic`/
  `client_secret_post`); periodic re-resolution loop propagating rotation/archival to
  running sessions without restart (§12.5); `validate` → `valid`/`invalid`/`unknown`
  taxonomy; `vault_credential.refresh_failed` event emission (consumed by 2.5).
- **Done:** refresh against a mock OAuth server (expiry, failure → event); re-resolution
  integration test (rotate mid-session, next use gets the new binding).

#### WP-2.5 — Webhooks

- **Owns:** `backend/src/domain/webhook`, `api/webhooks`. **Spec:** §8.8, §23, §12.7
  (vault events), §17 (job events).
- **Brief:** endpoint registration (HTTPS:443, public hostname; `whsec_` signing secret
  shown once); thin payloads (type + id + createdAt, fetch-on-receipt — §23.2);
  `X-Webhook-Signature` HMAC + 5-minute tolerance; at-least-once retries with persisted
  queue (Postgres), same `event.id` across retries; 2xx-only ack, no redirect following;
  auto-disable (~20 consecutive failures, or immediately on private-IP resolution /
  redirect) with machine-readable `disabledReason`; test-delivery endpoint; event sources:
  session/thread/outcome lifecycle (§23.1) + vault + job/run events.
- **Done:** §29.3 verify (register, trigger status change, verify signature); auto-disable
  tests (private IP, redirect, failure streak); retry-idempotency test.

#### WP-2.6 — Client extension: crons, memory, vault surfaces

- **Owns:** `client-extension` (extend). **Depends:** 2.1, 2.2, 2.4.
- **Brief:** `/remote:cron <list|create|pause|unpause|run|archive>`, `/remote:jobs`,
  `/remote:memory <list|show|edit|mount>`, `/remote:vault <list|create|add-cred|validate>`
  (§24.5); corresponding agent tools (`remote_create_cron` etc. — §24.6) with the same
  description-quality bar; un-stub WP-1.11c placeholders.
- **Done:** J4 journey manually verified at GATE-2; tool-description review.

**GATE-2:** the full §29.3 verify block, run end-to-end by the orchestrator; human
approval.

---

## 9. Phase 3 — Multi-Agent, Outcomes, MCP

**Spec:** §29.4. Work-package resolution; the orchestrator decomposes each WP into 2–4
agent-sized sub-briefs at dispatch time (following the Phase-1 brief style), because
internal interfaces here depend on Phase-1/2 code shapes that exist by now.

#### WP-3.1 — Multi-agent orchestration

- **Owns:** `backend/src/domain/multiagent`, `pi-extensions/subagent`, thread event glue.
  **Spec:** §18. Read Pi `examples/extensions/subagent/` first.
- **Key requirements:** roster (1–20 entries; by-ID latest-pinned-at-creation, pinned
  version, `{"type":"self"}`); snapshot-at-creation semantics; **one level of delegation
  only**; shared vs isolated modes (shared sandbox vs per-thread sandbox); threads =
  per-thread `AgentSession` + own event stream; primary-thread condensed view; ≤25
  concurrent threads; inter-thread messages (`agent.thread_message_*` with from/to
  fields); cross-posting of blocking events to the primary thread with `sessionThreadId`
  routing for `user.tool_confirmation`/`user.custom_tool_result` responses (§18.7);
  vault first-match-wins across threads (§12.6).
- **Suggested decomposition:** (a) thread runtime + lifecycle events; (b) subagent Pi
  extension + roster/config; (c) cross-posting + response routing; (d) shared-sandbox mode.
- **Gate slice:** coordinator fans out to two parallel subagents and synthesizes (§29.4).

#### WP-3.2 — Outcomes

- **Owns:** `backend/src/domain/outcome`, `api/sessions/:id/outcomes`. **Depends:** 3.1
  (grader is a subagent). **Spec:** §8.11, §16.
- **Key requirements:** `user.define_outcome` (description, rubric text-or-fileId,
  maxIterations default 3 max 20); grader = separate `AgentSession` with own context +
  rubric, reading `/mnt/session/outputs/`; iteration loop produce→grade→feedback; result
  taxonomy (`satisfied`/`needs_revision`/`max_iterations_reached`/`failed`/`interrupted`)
  with the §16.5 transitions; one outcome at a time, chainable; `span.outcome_evaluation_*`
  + `session.outcome_evaluation_*` events; deliverables via Files API (§16.6).
- **Gate slice:** rubric-driven `needs_revision` → `satisfied` loop (§29.4).

#### WP-3.3 — MCP connector

- **Owns:** `backend/src/pi-extensions/mcp-bridge`, `domain/mcp` (proxy). **Spec:** §19,
  §25.3. **Security-sensitive → reviewer agent (credential proxy).**
- **Key requirements:** streamable-HTTP remote servers; two-step config (servers on the
  agent, auth via session `vaultIds`, URL exact-match incl. scheme/trailing slash — §19.5);
  toolset config same algebra as WP-1.8, default `always_ask`; referential integrity
  toolset↔server (§19.3, schema already enforces); **credential-injecting proxy in the
  backend — the harness never sees tokens** (§25.3); no connectivity validation at
  creation; failure events with `mcpServerName` + `retryStatus`
  (`mcp_connection_failed_error` / `mcp_authentication_failed_error`), retry on next
  idle→running (§19.6); MCP tool outputs subject to the 100k-token rule (§11.3). Tunnels
  are Phase 4/never (§19.1).
- **Gate slice:** vault-authenticated MCP server, agent calls its tools (§29.4).

#### WP-3.4 — Custom tools flow

- **Owns:** `domain/event-stream` (extend), session-factory glue. **Spec:** §11.2, §9.4.
- **Key requirements:** custom-tool declarations on the agent → `defineTool` shims whose
  execution relays `agent.custom_tool_use`, pauses (`requires_action` + blocking IDs),
  resumes on `user.custom_tool_result` keyed by `customToolUseId`; permissions
  deliberately don't apply (§22 preamble); works cross-thread via 3.1's cross-posting.

#### WP-3.5 — Skills + full Files API

- **Owns:** `backend/src/domain/skill`, `api/skills`, `api/files` (extend). **Spec:**
  §8.10, §20, §21.
- **Key requirements:** upload (zip or files) → `skill_` ID + versions; `displayTitle`
  uniqueness; pre-built set (per Wave-0 decision on §30 item 11) seeded per tenant;
  attach via agent `skills[]`, ≤20/session counted across all agents;
  materialization into the session (`.pi/skills/` or `skillsOverride`) preserving Pi's
  progressive disclosure; `/skill:name` invokable over RPC (§20.4); files usable as rubric
  refs (§16.2).
- **Gate slice:** upload a custom skill; agent loads it on demand (§29.4).

**GATE-3:** the §29.4 verify block end-to-end; human approval.

---

## 10. Phase 4 — Self-Hosted Sandboxes + SaaS Hardening

**Spec:** §29.5. Same decomposition rule as Phase 3.

#### WP-4.1 — Self-hosted environments (work queue)

- **Spec:** §10.4, §8.2 (work-stats). Environment `type: self_hosted` unlocked; work-item
  queue (session assigned → enqueue; worker claims; results return as `user.tool_result`
  events — §9.2); `work-stats` endpoint (`depth`, `pending`, `oldestQueuedAt`,
  `workersPolling`); `work.stop` (+`force`) with org-key auth + docs warning (§10.4);
  environment-scoped worker keys; enforce the unsupported-features matrix (no memory
  stores, no env-var creds — §10.4/§13.7) with clear errors.

#### WP-4.2 — Default worker (`packages/worker`)

- **Depends:** 4.1. **Spec:** §10.4. Always-on poller (outbound HTTPS only) +
  webhook-triggered mode; two control levels (out-of-the-box; spawn-script hand-off);
  ships as its own npm package.
- **Gate slice:** session's tools execute on the worker host (§29.5).

#### WP-4.3 — Multi-host sandbox scheduling

- **Spec:** §7.2, §4.2. Sandbox-host pool registry; placement routing (backend owns it —
  msb has no multi-host scheduler); host liveness + alerting; re-attach across hosts;
  work-queue + worker-pool for sandbox operations (§4.2). *Largest architectural change of
  the phase — orchestrator should commission a design note (Plan agent) before
  implementation briefs.*

#### WP-4.4 — Quota enforcement + tiers

- **Spec:** §27.3, §29.5. Per-tenant limits (concurrent sessions/sandboxes, jobs, vault
  size, memory size, file storage, token spend) enforced at API + scheduler; quota plans ↔
  tier mapping; defaults seeded from `docs/capacity.md` (WP-1.14).

#### WP-4.5 — Web console

- **Spec:** §26.6. Session list (status/creation/model), tracing view (chronological
  events, content, timestamps, tokens), tool-execution details. Read-only v1; own package;
  auth via API keys.

#### WP-4.6 — MCP tunnels (research spike)

- **Spec:** §19.1. Timeboxed spike: assess upstream maturity; output a go/no-go note in
  `docs/spec/decisions.md`. No implementation without human approval.

**GATE-4:** §29.5 verify block (worker execution, 2-host placement, quota rejection,
console browse); human approval.

---

## 11. Phase 5 — Extensibility Polish

**Spec:** §29.6.

#### WP-5.1 — Plugin interfaces

- Formalize + document the ports (sandbox provider, secret store, scheduler, tool
  registry) as public plugin contracts with default impls; contract-test kits per
  interface (the fake/real parity suites from earlier phases become the published
  conformance tests). §29.6, §3 principle 3.

#### WP-5.2 — Tenant onboarding (SaaS)

- Sign-up flow → tenant + API key issuance → hand back `pi install` command + backend URL
  (§29.6, §24.3); `/remote:login` OAuth-style flow on the extension side (§24.5).

#### WP-5.3 — Billing integration hooks

- Usage → metering events → pluggable billing sink (§29.6). Hook interface + a no-op and a
  webhook-emitting impl; no processor integration without human direction.

#### WP-5.4 — OTEL conventions + dashboards

- Resolve §30 item 3 with the human (mirror Pi SDK conventions vs backend-specific);
  finalize span/metric names; ship Grafana dashboards incl. msb-metrics pipeline (§26.4).

#### WP-5.5 — SLA/limits configurability per tier

- Tier-config surface consolidating every "configurable per tier" knob accumulated in
  earlier phases (cred limits §12.4, job limits §17.3, quotas §27.3, retention §6.3).

**GATE-5:** subscription-shaped E2E: onboard a new tenant from zero → install extension →
delegate → billed usage visible; human approval.

---

## 12. Cross-Cutting Test Strategy

- **Test pyramid per WP:** unit (always) → integration with testkit fakes (always) →
  `@kvm`-tagged real-sandbox tests (where sandbox behavior matters).
- **Fake/real parity:** every port has one contract-test suite run against both the
  testkit fake and the real impl. Divergence = bug in the fake; fix the fake, not the test.
- **Security tests are gate criteria, not nice-to-haves:** credential-injection (§25.1),
  host-escape (§10.2), SSRF guard (§11.1), secret-serialization (§12.4), cross-tenant
  isolation (§27.1). They run in CI on every phase branch, forever — not just at their
  introducing gate.
- **Upstream-upgrade suite** (WP-1.3) gates every microsandbox version bump; the pinned
  version changes only via a dedicated WP that runs it (§30 item 13).
- **KVM runner:** `@kvm` tests need `/dev/kvm`. The orchestrator confirms with the human
  where these run (dev machines are Linux/KVM or macOS-dev-only — §7.3; server access
  requires explicit user request per project rules).

## 13. Risk Register & Escalation Triggers

| Risk | Mitigation in this plan | Escalate when |
|---|---|---|
| microsandbox beta churn (§30 #13) | Pin version (WP-1.3); everything behind `SandboxProvider`; upgrade-gating suite | Upstream breaking change blocks a WP |
| Pi per-session global config (§4.2, A.2 #13) | In-memory auth/settings per session; isolation asserted in WP-1.5 tests | Any test finds cross-session config bleed |
| Unquantified per-session heap (§30 #15) | WP-1.14 load test → `docs/capacity.md` | Envelope too small for target concurrency |
| Wire-contract drift | contracts pkg = mirrored artifact; golden tests; change-doc-first rule | Any impl WP "needs" a contract change — route to a contracts WP, never edit inline |
| Parallel-agent path collisions | One-owner-per-subtree invariant; disjoint groups | Two agents legitimately need one file — orchestrator serializes |
| Security invariant regression | §12 suites permanent in CI; reviewer agents on sensitive WPs | Any red security test — stop all merges, human immediately |
| `[OPEN]`/`[GAP]` spec items (§30) | Wave-0 decision batch; `docs/spec/decisions.md` | A coding agent hits an unresolved item mid-WP — park, ask human |

---

## Appendix — Task Brief Template

The orchestrator fills this out completely for every dispatch. No field may be left for
the agent to infer.

```markdown
# Work Package: WP-<id> — <title>

## Mission
<2–4 sentences: what this builds and why, in the context of the Pi Managed Backend —
a control plane around the Pi coding agent with microsandbox microVM execution.>
You are implementing code (or: writing documentation only — no code).

## Required reading (in order, before writing anything)
- spec.md §<…>, §<…>   (path: /home/mauro/projects/pi-backend/docs/spec/spec.md)
- docs/api-reference.md §<…> / docs/internal-contracts.md §<…> / docs/db-schema.md §<…>
- <Pi docs / examples / upstream docs paths, from plan §3.3>
- CONVENTIONS.md

## Owned paths (create/modify ONLY here)
- <paths>
Shared files you may read but must not modify: <paths>. If you believe a shared file
must change, STOP and report why instead of editing it.

## Interfaces you consume (already merged — do not modify)
<paste the exact TS interfaces / schemas>

## Deliverables
1. <concrete artifact>
2. <…>

## Done criteria
- [ ] <verifiable statement>
- [ ] Tests: <what must be covered>
- [ ] Docs updated: <which>

## Verification (run these; paste real output in your report)
- pnpm --filter <pkg> typecheck && pnpm --filter <pkg> lint && pnpm --filter <pkg> test
- <WP-specific commands>

## Rules
<paste plan §3.4 verbatim>

## Report format
Summary (≤200 words); files changed; new dependencies (if any — justify); verification
output; open questions / discrepancies found between brief and spec.
```
