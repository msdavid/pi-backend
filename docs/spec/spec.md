# Pi Managed Backend — Specification

> **Status:** Draft for collaboration. Not yet approved for implementation.
> **Purpose.** A self-deployable service that gives the Pi coding agent managed-agent
> capabilities: remote tasks, scheduled jobs (crons), remote agent sessions, durable
> state, sandboxed execution, and a client extension that makes all of this feel native
> to a local Pi user. The service is **tailored for Pi** — it provides the full
> managed-agent concept set (agents, sessions, environments, events, tools, memory,
> multi-agent orchestration, outcomes, scheduled deployments) in **Pi-native idioms**.
>
> **Source research.** Pi-native concept mapping: derived from Pi's docs
> (`@earendil-works/pi-coding-agent`).
> Sandbox technology: `superradcompany/microsandbox` (microVM runtime).
>
> **Feasibility verified (2026-07-12).** The load-bearing upstream claims were audited
> against microsandbox `main` (superradcompany/microsandbox, HEAD 2d46ce7) and Pi's local
> SDK docs. Verdicts, corrections, and residual risks are in **Appendix A**. Two design
> errors found in the draft were fixed in place (live-view panel §24.7; git-token
> injection §10.1/§25.2).
>
> **Decisions locked (this kickoff):**
> - Backend written in **TypeScript/Node**, embedding Pi in-process via its SDK.
> - Single spec doc, **phased** (full target scoped, v1 vs later clearly separated).
> - Hosting: **both** self-hosted-single-tenant *and* SaaS-multi-tenant supported from
>   the architecture (tenant-aware isolation, but deployable as a single binary).
> - Sandbox: **microsandbox** microVMs (KVM/libkrun), embedded as a child process.
> - Pi-native idioms throughout — no other product's API is mirrored.

---

## Table of Contents

1. [Vision & Goals](#1-vision--goals)
2. [Non-Goals](#2-non-goals)
3. [Guiding Principles](#3-guiding-principles)
4. [Architecture Overview](#4-architecture-overview)
5. [The Three Abstractions (Pi-native)](#5-the-three-abstractions-pi-native)
6. [Resource Model](#6-resource-model)
7. [Hosting & Deployment Models](#7-hosting--deployment-models)
8. [API Surface](#8-api-surface)
9. [Events & Streaming](#9-events--streaming)
10. [Sandbox Layer (microsandbox)](#10-sandbox-layer-microsandbox)
11. [Tools](#11-tools)
12. [Credentials & Secrets (Vaults)](#12-credentials--secrets-vaults)
13. [Memory](#13-memory)
14. [Tasks](#14-tasks)
15. [Goals & Autonomous Loops](#15-goals--autonomous-loops)
16. [Outcomes (define-outcome)](#16-outcomes-define-outcome)
17. [Scheduled Jobs (Crons)](#17-scheduled-jobs-crons)
18. [Multi-Agent Orchestration](#18-multi-agent-orchestration)
19. [MCP Connector](#19-mcp-connector)
20. [Skills](#20-skills)
21. [Files](#21-files)
22. [Permission Policies](#22-permission-policies)
23. [Webhooks](#23-webhooks)
24. [The Pi Client Extension](#24-the-pi-client-extension)
25. [Security Model](#25-security-model)
26. [Observability](#26-observability)
27. [Multi-Tenancy & Isolation](#27-multi-tenancy--isolation)
28. [Persistence & State](#28-persistence--state)
29. [Phasing Roadmap](#29-phasing-roadmap)
30. [Open Questions](#30-open-questions)
31. [Glossary](#31-glossary)
32. [Appendix A — Feasibility Verification](#appendix-a--feasibility-verification-2026-07-12)

---

## 1. Vision & Goals

**The pitch.** Pi is a capable, minimal coding agent harness — but it is local-first and
ephemeral: a session lives on your machine, stops when you close the terminal, and has no
notion of running on a schedule, persisting across servers, or coordinating multiple
agents. Hosted managed-agent services give cloud agents those capabilities. We
are building the **Pi equivalent**: a service you deploy (or subscribe to) that gives any Pi
instance — local or remote — managed-agent superpowers.

**What the service provides, in one sentence each:**

- **Remote agent sessions.** Start a Pi agent on the server, drive it over an API, stream
  its output back. The agent runs in an isolated microVM sandbox with its own filesystem
  and network policy. Survives your laptop closing.
- **Scheduled jobs (crons).** "Run this agent every Monday at 9am with these parameters."
  Cron semantics, run records, pause/resume, manual triggers.
- **Durable sessions.** Conversation history (Pi's JSONL session tree) is stored
  server-side, resumable, inspectable, forkable — the session log is the single source of
  truth, surviving harness crashes.
- **Sandboxed execution.** Every agent runs inside a microsandbox microVM. Code the agent
  writes executes in a real isolated Linux kernel, not the host. Credentials never reach
  the sandbox.
- **Remote tasks.** A local Pi can delegate a long-running task to the backend, keep
  working, and pick up the result later.
- **Memory across sessions.** Carry context (preferences, project conventions, prior
  mistakes) across sessions via mounted memory stores.
- **Multi-agent orchestration.** A coordinator agent delegates to specialized subagents,
  in parallel or sequence, with isolated contexts.
- **Goals & autonomous loops.** Give an agent an outcome and a rubric; it iterates until
  satisfied, self-evaluating against the rubric.
- **Credentials vault.** Register secrets once, reference per-session; tokens are injected
  at the egress boundary and never visible to the agent.
- **Webhooks.** Get notified of session state changes without polling.
- **A Pi extension** that makes all of the above available from inside a local Pi session
  as if it were native.

**Why tailored for Pi.** Pi already embodies the three-abstraction
"meta-harness" design — a durable session log (JSONL tree), a
harness (`AgentSession`), and replaceable execution "hands" (pluggable tool operations).
So we are **not** reimplementing the meta-harness; we are wrapping Pi's existing primitives
with a managed/remote/scheduled/multi-tenant control plane and swapping the execution
layer to microsandbox. Every managed-agent concept maps to a Pi-native idiom (see §5 and
§6). The API speaks Pi's vocabulary.

**Why it can be sold as a subscription.** The backend is tenant-aware from the start: a
single deployment can serve multiple organizations with isolated resources (§27). A
subscriber either self-hosts the binary (single-tenant) or points their Pi extension at a
SaaS deployment we operate (multi-tenant). Same code, two deployment shapes.

## 2. Non-Goals

- **Not an API clone.** We do not mirror any other product's endpoint paths, event-type
  strings, or JSON schemas. We replicate *capabilities*, adapted to Pi.
- **Not a model provider.** The backend routes model calls to the provider configured on
  each agent (any provider Pi supports — e.g. OpenAI, Google, a local model, or a proxied
  gateway). We don't host models.
- **Not a Pi fork.** We consume Pi as a dependency (`@earendil-works/pi-coding-agent`
  SDK). We don't fork or patch Pi core; managed features ship as Pi extensions loaded by
  the service, or as backend logic layered above `AgentSession`.
- **Not ZDR/HIPAA-eligible out of the box.** Sessions are stateful and store conversation
  history, sandbox state, and outputs server-side. (Self-hosters may operate under their
  own compliance posture; the SaaS surface is not ZDR.)
- **No live memory checkpoint/restore of sandboxes.** microsandbox supports filesystem
  snapshots and stop/start (cold reboot preserving disk). Live RAM suspend/resume is out
  of scope (the upstream doesn't support it). Session state durability comes from Pi's
  JSONL log + sandbox snapshots, not memory checkpointing.
- **No built-in TUI.** The backend is a headless service. Humans interact via the API, the
  web console (later), or the Pi client extension.

## 3. Guiding Principles

1. **Pi-native first.** When a Managed-Agents concept has a Pi-native idiom (session tree,
   skills, extension-based tasks/goals), use it. Don't reinvent what Pi already does. The
   backend is a control plane *around* Pi, not a parallel harness.

2. **Concepts, not wire compatibility.** We clone the *capability* of each Managed-Agents
   feature, not its API shape. Our resource names, event types, and schemas are our own,
   chosen for Pi idioms and future extensibility.

3. **Extensibility over completeness.** The service will be sold as a subscription and
   must accommodate features we haven't designed yet. Prefer explicit extension points
   (hooks, plugin interfaces, resource `metadata`) over hardcoding. Every major subsystem
   (sandbox, secrets, scheduler, tool registry) is behind an interface with a default
   implementation.

4. **The session log is the source of truth.** Pi's JSONL session tree is the durable
   record. The harness (`AgentSession`) is stateless-ish and replaceable; the sandbox is
   disposable ("cattle"). Crash recovery = re-read the session log, re-provision a
   sandbox, resume. We do not store authoritative agent state outside the session log.

5. **Tokens never reach the sandbox.** This is the design's load-bearing security insight
   and it maps directly onto microsandbox's host-side secret model. The agent (untrusted
   code in the microVM) can call authenticated APIs but cannot read the credentials — they
   are substituted at the network egress boundary. We preserve this invariant strictly.

6. **Local feels native.** A Pi user who installs the client extension should experience
   remote sessions, crons, and tasks as first-class Pi commands — not as a separate
   "backend product" they context-switch into.

7. **Surgical scope per phase.** v1 delivers a usable, deployable core (agents,
   environments, sessions, events, tools, basic secrets, the client extension). Everything
   else (memory, tasks, goals, outcomes, crons, multi-agent, MCP, webhooks) is specced
   in full but phased. We design for all of it now; we build incrementally.

## 4. Architecture Overview

### 4.1 Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Pi Managed Backend                            │
│                                                                      │
│  ┌────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────┐  │
│  │  HTTP API  │──▶│  Scheduler   │   │  Vault     │   │ Webhook  │  │
│  │  (REST+SSE)│   │  (crons/jobs)│   │  (secrets) │   │ Dispatcher│  │
│  └─────┬──────┘   └──────┬───────┘   └─────┬──────┘   └──────────┘  │
│        │                 │                 │                          │
│        ▼                 ▼                 │                          │
│  ┌─────────────────────────────────────────┴──────────────────────┐  │
│  │                    Session Manager                              │  │
│  │  (one Pi AgentSession per managed session, in-process)          │  │
│  │   • drives AgentSession.prompt() / steer() / subscribe()        │  │
│  │   • loads managed-feature extensions (tasks, goals, gates, MCP) │  │
│  │   • persists JSONL session tree (durable log)                   │  │
│  │   • routes tool calls → Sandbox Operations adapter               │  │
│  └────────────────────────────┬─────────────────────────────────────┘  │
│                               │                                        │
│                 ┌─────────────▼──────────────┐                         │
│                 │  Sandbox Operations Adapter │                        │
│                 │  (Pi *Operations → msb SDK) │                        │
│                 └─────────────┬──────────────┘                         │
│                               │                                        │
│  ┌────────────────────────────▼─────────────────────────────────────┐  │
│  │            microsandbox SDK (embedded, NAPI)                       │  │
│  │   spawns microVM child processes on the KVM host                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────────┐   │
│  │  Tenant /   │  │  Auth / API  │  │  Storage (Postgres + object  │   │
│  │  Quotas     │  │  Keys        │  │  store for files/snapshots)  │   │
│  └─────────────┘  └──────────────┘  └──────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ REST + SSE                       │ Pi extension protocol
        │                                  │ (local Pi ↔ backend)
┌───────┴──────────┐              ┌───────┴──────────────┐
│  External client  │              │  Local Pi + extension │
│  (curl, console,  │              │  (tasks, crons, remote │
│   SDK, etc.)      │              │   sessions, delegation)│
└───────────────────┘              └───────────────────────┘
```

### 4.2 Process model

- **One Node process** runs the backend. It owns the HTTP server, scheduler, vault, and
  session manager.
- **One in-process `AgentSession` per active managed session**, created via Pi's SDK
  `createAgentSession()`. Each session is bound to a sandbox and drives it through the
  Sandbox Operations adapter.
- **Per-session isolation of process-global config.** Pi reads some configuration from
  process globals (env-var API-key fallbacks, `getAgentDir()`, settings files). The
  backend never relies on these: each managed session gets `AuthStorage.inMemory()`
  (provider keys injected from the agent config), `SettingsManager.inMemory()`, an
  explicit `cwd`, and its own `DefaultResourceLoader` instance. Provider credentials are
  never placed in process env (they'd be shared across tenants).
- **One microsandbox microVM (child process) per session** that needs execution. A session
  that's idle with a checkpointed sandbox doesn't hold a running VM; resuming re-provisions
  from the snapshot or a fresh image. VMs are created **detached** so a backend restart
  doesn't kill active sandboxes; on boot the backend re-attaches by tenant/session label.
  (Crash recovery without re-attach — re-provision from the session log — is always safe,
  but re-provisioning every active session at once is a boot storm we avoid.)
- **Capacity is bounded by host RAM** (each microVM reserves its environment's memory
  allocation) and by per-`AgentSession` heap (unquantified upstream). Load-testing target
  concurrency is a Phase-1 exit criterion (§30).
- **Background workers** (scheduler tick, webhook dispatcher, vault re-resolution) run as
  in-process async tasks, not separate processes — adequate for a single-node deployment.
  Multi-host horizontal scale (§7.2) introduces a work-queue + worker pool for sandboxes.

### 4.3 The three trust boundaries

Inherited from the meta-harness design and enforced structurally:

| Boundary | What it holds | What it can access |
|---|---|---|
| **Client** (user / extension) | API keys, OAuth grants | Create/manage agents, sessions, environments; send events |
| **Harness** (backend + `AgentSession`) | Session log, config, routing | Calls the model, routes tool calls to the sandbox; **cannot** expose raw credentials to the sandbox |
| **Sandbox** (microVM) | Project files, runtime, agent code | Runs code, edits files; **cannot** read credentials (only placeholders) |

## 5. The Three Abstractions (Pi-native)

The meta-harness pattern has three internal abstractions: **Session** (durable log),
**Harness** (stateless brain), **Sandbox** (disposable hands). Pi already has all three. We
map them directly:

### 5.1 Session = Pi's JSONL session tree (durable log)

- The append-only, tree-structured record of *everything that happened* in a managed
  session: user messages, assistant messages, tool calls/results, model changes,
  compactions, and `custom` entries for managed-feature state (tasks, goals).
- Lives outside the harness and sandbox. Survives harness crashes and sandbox
  destruction. Is the single source of truth.
- Inspectable via the API: list entries, get the tree, fetch a slice (positional), rewind
  to before an action.
- Branchable/forkable (Pi-native): a managed session can be forked for experimentation.
- **This is the durable log.** We do not duplicate it into a second store; the JSONL tree
  *is* the canonical record. (A DB row per session holds metadata — status, IDs, usage —
  but the conversation is the JSONL.)

### 5.2 Harness = `AgentSession` (the brain)

- Pi's `AgentSession`, created in-process via the SDK. Calls the model, routes tool calls
  to the Sandbox Operations adapter, streams events.
- Stateless-ish: all durable state lives in the session JSONL. If the process dies, a new
  `AgentSession` is recreated from the session file and resume continues.
- Loaded with **managed-feature extensions** (tasks, goals, permission gates, MCP bridge,
  remote-delegation tool) that give the agent its managed capabilities — these are Pi
  extensions loaded via `DefaultResourceLoader` / `extensionFactories`, not separate
  services.
- Crash recovery = `wake(sessionId)`: boot a fresh `AgentSession` bound to the existing
  JSONL, re-provision its sandbox, resume from the last entry.

### 5.3 Sandbox = microsandbox microVM (the hands)

- A real isolated Linux VM (own kernel) spawned as a child process via the microsandbox
  SDK. The agent's `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` tool calls execute
  here, not on the host.
- **Disposable ("cattle").** If a VM dies, a new one is provisioned from the image (or a
  snapshot) and work continues from the session log.
- **The hands interface is `execute(name, input) → string`** — a deliberately minimal
  contract. In our implementation this is the **Sandbox Operations adapter**: Pi's
  pluggable `BashOperations` / `ReadOperations` / etc. interfaces, backed by the
  microsandbox SDK. The brain (AgentSession) calls tools; tools delegate to the adapter;
  the adapter runs commands in the microVM and returns stdout/stderr/exit.
- Can be stopped (checkpointed to disk) and started (cold reboot, filesystem preserved)
  when a session goes idle. Snapshots (filesystem-only) can fork a pre-warmed image.

### 5.4 Interfaces (the named contracts)

| Interface | Where | Purpose |
|---|---|---|
| `execute(name, input) → string` | Harness → Sandbox (via Operations adapter) | Run a tool call in the microVM |
| `provision({resources})` | Backend → Sandbox | Create/recreate a microVM with image, mounts, network, secrets |
| `wake(sessionId)` | Backend → Harness | Boot a fresh `AgentSession` bound to an existing JSONL |
| `getEntries(sessionId, range)` | Harness/Backend → Session | Read the JSONL tree (positional slice, rewind) |
| `emitEntry(sessionId, entry)` | Harness → Session | Pi writes to the JSONL (durability write) |


## 6. Resource Model

Resources are the user-facing nouns the API operates on. All are **tenant-scoped** (§27).
Each has a stable ID, a human-readable name, versioning where it matters, and lifecycle
operations. Names below are **Pi-native**.

### 6.1 Agent

A reusable, versioned definition of how a Pi agent behaves. Create once, reference by ID
across sessions.

- **Fields:** `name`, `model` (provider + id + thinking level), `systemPrompt` (or a
  reference to a `SYSTEM.md`/prompt template), `tools` (allow/exclude built-ins +
  custom tools), `skills` (list of skill IDs/paths), `extensions` (list of extension
  IDs/paths to load — this is how managed features attach), `mcpServers` (§19), optional
  `multiagent` roster (§18), arbitrary `metadata`.
- **Versioning.** Agents are versioned. A session references an agent by ID (→ latest
  version) or pinned version. Lets you stage rollouts independently.
- **Lifecycle:** create, list, get, update, **archive** (terminal; read-only; no new
  sessions can reference; no unarchive), list versions. **No hard delete**
  — only archive (preserves audit trail). Name uniqueness scoped to tenant.
- **Pi mapping:** an agent resource is a *bundle of config* that the backend materializes
  into `createAgentSession({ model, customTools, resourceLoader, ... })` at session start
  (managed-feature extensions load via `DefaultResourceLoader({ extensionFactories })` —
  one loader instance per session). It is not a running process until a session references it.

### 6.2 Environment

Defines the sandbox configuration where sessions run. Create once, reference by ID.

- **Fields:** `name`, `type` (`cloud` = backend-managed microsandbox; `self_hosted` = a
  worker you run pointing at this backend — §10.4), `image` (OCI image ref, e.g.
  `ubuntu:22.04` or a custom image with pre-installed packages), `resources` (vCPUs,
  memory MiB, disk MiB), `networking` (egress policy: `unrestricted` | `limited` with
  `allowedHosts`), `packages` (pre-install list — we bake into a custom image or apply as
  rootfs patches), `mounts` (bind/named volumes — e.g. a git repo, memory stores),
  `maxDuration`, `idleTimeout`. Per-VM resource requests are capped at admission
  (`cpus` ≤ 64, `memoryMiB` ≤ 262144, `diskMiB` ≤ 1048576 — ROB-17).
- **Not versioned.** Keep your own change record; sessions created at
  different times may have used different configs.
- **Lifecycle:** create, list, get, update, **delete** (hard) or **archive**. Has both.
- **microsandbox mapping:** an environment is materialized into a `Sandbox.builder()`
  config: `.image()`, `.cpus()`, `.memory()`, `.env()`, `.volume()` (upstream's name for
  mounts), a `NetworkPolicy`, and secret bindings. Naming note: microsandbox has no
  literal `limited` mode — our `unrestricted` maps to its `publicOnly()` preset (public
  internet allowed, private/host/metadata denied — **not** `allowAll()`), and `limited`
  compiles to a default-deny `NetworkPolicy.builder()` plus explicit `allowHost()` rules.

### 6.3 Session

A running agent instance within an environment, performing a task. The central resource.

- **Fields at creation:** `agent` (ID, pinned version, or an **overrides** form — see
  below), `environmentId`, `title`, `resources` (files, repos, memory stores to mount),
  `vaultIds` (credentials), `budget` (optional `{maxTokens?, maxUsd?}` — hard caps
  enforced server-side; when exceeded the session is interrupted and set `idle` with
  `stopReason: budget_exhausted`), `metadata`.
- **The `agent` field — three forms** (the override/inherit/clear model — omit to
  inherit, `null` to clear, value to replace):
  1. Bare ID → latest version.
  2. Pinned version → exact.
  3. Overrides → override `model`/`systemPrompt`/`tools`/`skills`/`extensions`/`mcpServers`
     for this session only (does not modify the agent resource). Omit → inherit; set null
     → clear; set value → full replace (no merge).
- **State machine:** `idle` (waiting for input) → `running` (executing) →
  `rescheduling` (transient retry) → `terminated` (unrecoverable error). Starts in
  `idle`. Idle sessions have their sandbox checkpointed (stopped, disk preserved).
- **Resumption:** send a `user.message` event to an idle session to resume — the backend
  re-provisions (starts) the sandbox and continues. Checkpoints retained **30 days** after
  last activity (configurable); periodic `user.message` resets the inactivity timer.
- **Updating agent config mid-session:** `tools` and `mcpServers` (incl. permission
  policies) can change without a new agent version — session-local, full-replacement
  semantics. `model`/`systemPrompt`/`skills` are fixed for the session's lifetime (use
  overrides at create time). Session must be `idle` to update (interrupt first if running).
- **Resource independence on deletion:** deleting a session does not delete its files,
  memory stores, vaults, skills, environments, or agents. The JSONL session tree is
  retained (archived) for audit unless explicitly purged.
- **Pi mapping:** a session resource = a row in the sessions DB (metadata, status, usage)
  + a Pi session JSONL file (the durable log) + a sandbox handle (when running). The
  `AgentSession` object exists only while the session is active in-process.

### 6.4 Events

The messages exchanged between client and agent. Sent in, streamed out, persisted in the
session log. Full catalog in §9.

### 6.5 Other resources

Vaults & credentials (§12), memory stores (§13), skills (§20), files (§21), scheduled
jobs (§17), webhooks (§23), multi-agent threads (§18). All tenant-scoped, all
independent of sessions (deleting a session doesn't delete them).

### 6.6 IDs and naming

- **IDs:** opaque, prefixed, globally unique within a deployment. Conventions:
  `agent_…`, `env_…`, `sess_…`, `vault_…`, `mem_…`, `skill_…`, `file_…`, `job_…`,
  `wh_…`. Generated server-side.
- **Names:** human-readable, unique within (tenant, resource-type). 1–128 chars. Used for
  display and stable reference. microsandbox sandbox names are derived from session IDs
  and namespaced by tenant (§27) to avoid the flat-namespace collision.

## 7. Hosting & Deployment Models

The same codebase supports two deployment shapes. The architecture is tenant-aware from
the start so neither shape is a retrofit.

### 7.1 Self-hosted single-tenant

- Subscriber runs one backend instance (a Node process + a Postgres DB + an object store
  for files/snapshots) on a KVM-capable Linux host.
- One implicit tenant (the deployer's org). No tenant isolation machinery exercised, but
  the tenant context still flows through every request — so promoting to SaaS later is a
  config change, not a rewrite.
- Auth: API keys issued by the backend. The deployer owns all keys.
- Sandbox host: the same machine (or a dedicated microsandbox host reachable over the
  network). Each session → one microVM child process.

### 7.2 Self-hosted / SaaS multi-tenant

- One backend instance serves multiple tenants (organizations). Every resource is scoped
  to a `tenantId`. API keys are tenant-scoped. Cross-tenant access is impossible by
  construction (row-level filtering on every query).
- Sandbox host(s): a pool of KVM-capable machines. The backend schedules microVM
  placement across hosts (each host runs a microsandbox home; the backend owns the routing
  — microsandbox itself has no multi-host scheduler). This is the main operational burden
  of the SaaS shape and is phased (v1 is single-host; multi-host scheduling is a later
  phase, §29).
- Quotas: per-tenant limits (concurrent sessions, sandboxes, jobs, vault size, etc.)
  enforced at the API and scheduler.
- Subscription tiers map to quota plans + feature flags.

### 7.3 System requirements

- **Host OS:** Linux with `/dev/kvm` (KVM). macOS (Apple Silicon) supported for dev only.
  Windows (WHP) not a deployment target (upstream supports it; we don't). On GCP, nested
  virtualization requires an Intel x86 machine type (Haswell+) with
  `enableNestedVirtualization` set — unavailable on ARM (T2A) — and carries a measurable
  performance tax vs bare metal.
- **Runtime:** Node 20+.
- **Dependencies:** Postgres (metadata, quotas, job records, webhook deliveries), an
  object store (filesystem in v1; S3-compatible or GCS for SaaS), the microsandbox runtime
  (`~/.microsandbox/` with libkrunfw + agentd).
- **Packaging:** a single distributable (npm package or Docker image) containing the
  backend + the managed-feature Pi extensions. `pi` itself is a dependency, not bundled.

## 8. API Surface

A REST API (JSON over HTTPS) with SSE for live event streaming. Versioned (`/v1/...`).
Auth via `Authorization: Bearer <api_key>` (or a Pi-extension-specific bearer, §24).

**Cross-cutting semantics** (wire detail in the API-reference doc, but locked as behavior
now): every mutating `POST` accepts an `Idempotency-Key` header (safe client retries —
required for the extension and the scheduler); rate-limited responses are `429` +
`Retry-After`; API keys are stored **hashed** (argon2id) server-side and shown once at
issuance; list endpoints are cursor-paginated.

> **Wire detail lives in `docs/api-reference.md`.** This spec is feature-level: it names
> resources and operations, not exact JSON schemas, HTTP status codes, or pagination
> cursors. The API-reference doc pins the wire contract (the `@pi-managed/contracts`
> package mirrors it); the shape below is the feature-level overview.

### 8.1 Agents

```
POST   /v1/agents                       create
GET    /v1/agents                       list (filter by name, metadata)
GET    /v1/agents/:id                    retrieve
PATCH  /v1/agents/:id                    update (creates a new version)
POST   /v1/agents/:id/archive            archive (terminal)
GET    /v1/agents/:id/versions           list versions
GET    /v1/agents/:id/versions/:ver      retrieve a version
```

### 8.2 Environments

```
POST   /v1/environments                  create
GET    /v1/environments                  list
GET    /v1/environments/:id              retrieve
PATCH  /v1/environments/:id              update
DELETE /v1/environments/:id              delete (hard)
POST   /v1/environments/:id/archive      archive
GET    /v1/environments/:id/work-stats   (self-hosted queue depth — §10.4)
```

### 8.3 Sessions

```
POST   /v1/sessions                      create (provisions sandbox, no work starts)
GET    /v1/sessions                      list (filter by status, agent, environment)
GET    /v1/sessions/:id                  retrieve (status, usage, config)
PATCH  /v1/sessions/:id                  update agent.tools / agent.mcpServers (idle only)
DELETE /v1/sessions/:id                  delete (archives JSONL; independent resources untouched)
POST   /v1/sessions/:id/fork             fork (Pi-native tree fork → new session)
GET    /v1/sessions/:id/entries          list session log entries (positional slice)
GET    /v1/sessions/:id/tree             get the JSONL tree structure
GET    /v1/sessions/:id/messages         get the LLM-context messages (post-compaction)
GET    /v1/sessions/:id/usage            cumulative token usage
```

### 8.4 Events (the send/stream surface)

```
POST   /v1/sessions/:id/events           send a user.* or system.* event
GET    /v1/sessions/:id/events           list persisted events (paginated history)
GET    /v1/sessions/:id/stream           SSE stream (live + optional event deltas)
```

- Sending a `user.message` event starts/continues work. Sending `user.interrupt` redirects.
- The SSE stream delivers `session.*`, `agent.*`, `span.*` events (§9). Opt in to live
  text previews via a query param (§9.3).
- Custom-tool results and tool confirmations are sent as events (`user.custom_tool_result`,
  `user.tool_confirmation`), mirroring the Managed-Agents flow — adapted to Pi's event
  vocabulary (§9.2).

### 8.5 Vaults

```
POST   /v1/vaults                        create vault
GET    /v1/vaults                        list
GET    /v1/vaults/:id                    retrieve
DELETE /v1/vaults/:id                    delete (hard)
POST   /v1/vaults/:id/archive            archive (cascades to credentials)
POST   /v1/vaults/:id/credentials        add credential
GET    /v1/vaults/:id/credentials        list
DELETE /v1/vaults/:id/credentials/:key   archive a credential (purges secret, frees key)
POST   /v1/vaults/:id/credentials/:key/validate   validate OAuth status
```

### 8.6 Memory stores

```
POST   /v1/memory-stores                 create
GET    /v1/memory-stores                 list
GET    /v1/memory-stores/:id             retrieve
PATCH  /v1/memory-stores/:id             update (description, instructions)
DELETE /v1/memory-stores/:id             delete
GET    /v1/memory-stores/:id/memories     list memories
POST   /v1/memory-stores/:id/memories     create
GET    /v1/memory-stores/:id/memories/:m  retrieve (with content)
PATCH  /v1/memory-stores/:id/memories/:m  update (optimistic concurrency via sha256)
DELETE /v1/memory-stores/:id/memories/:m  delete
GET    /v1/memory-stores/:id/versions      list memory versions (audit trail)
GET    /v1/memory-stores/:id/versions/:v  retrieve a version
POST   /v1/memory-stores/:id/versions/:v/redact   redact (scrub content, keep audit)
```

### 8.7 Scheduled jobs

```
POST   /v1/jobs                          create (agent + environment + initial_events + schedule)
GET    /v1/jobs                          list
GET    /v1/jobs/:id                      retrieve
POST   /v1/jobs/:id/pause                pause (running sessions continue; manual run allowed)
POST   /v1/jobs/:id/unpause              resume (missed triggers not backfilled)
POST   /v1/jobs/:id/archive              archive (terminal, immutable)
POST   /v1/jobs/:id/run                  manual trigger (works while paused)
GET    /v1/jobs/:id/runs                 list deployment runs (session_id or error)
```

### 8.8 Webhooks

```
POST   /v1/webhooks                      register endpoint (URL + event types)
GET    /v1/webhooks                      list
GET    /v1/webhooks/:id                  retrieve
DELETE /v1/webhooks/:id                  delete
POST   /v1/webhooks/:id/test             send a test event
```

### 8.9 Files

```
POST   /v1/files                         upload (multipart)
GET    /v1/files                         list
GET    /v1/files/:id                     retrieve metadata
GET    /v1/files/:id/content             download content
DELETE /v1/files/:id                     delete
```

### 8.10 Skills

```
POST   /v1/skills                        upload (zip or individual files; returns skill_ id)
GET    /v1/skills                        list
GET    /v1/skills/:id                    retrieve
GET    /v1/skills/:id/versions           list versions
DELETE /v1/skills/:id                    delete
```

### 8.11 Outcomes

```
POST   /v1/sessions/:id/outcomes         define an outcome (description + rubric + max_iterations)
GET    /v1/sessions/:id/outcomes         list outcome evaluations + results
```

(Outcome lifecycle is event-driven — see §16. The REST surface is minimal: define + list.)

### 8.12 Tenant / admin (SaaS shape)

```
GET    /v1/tenant                        current tenant info + quota usage
POST   /v1/api-keys                      issue an API key (scoped to tenant)
GET    /v1/api-keys                      list keys
DELETE /v1/api-keys/:id                  revoke
```


## 9. Events & Streaming

Communication is event-based: the client sends `user.*` / `system.*` events; the backend
streams `session.*` / `agent.*` / `span.*` events back. Event history is persisted in the
session log (the JSONL tree) and fetchable in full.

### 9.1 Event-type naming

Persisted event types follow `{domain}.{action}`. Stream-only preview events (`event_start`,
`event_delta`) are the exception. Every persisted event carries a `processedAt` timestamp
(`null` = queued, handled after preceding events finish).

**Our type names are our own** (Pi-native). The strings below are **final** (pinned in
`docs/api-reference.md` and `@pi-managed/contracts`).

### 9.2 Persisted event catalog

| Type | Dir | Description |
|---|---|---|
| `user.message` | in | User message (text). Start/continue work. |
| `user.interrupt` | in | Stop mid-execution; follow with `user.message` to redirect. |
| `user.custom_tool_result` | in | Response to a custom-tool call. |
| `user.tool_confirmation` | in | Approve/deny a tool call a permission policy requires (`allow`/`deny` + optional `denyMessage`). |
| `user.define_outcome` | in | Define an outcome (§16). |
| `user.tool_result` | in | **Self-hosted environments only** — your worker provides tool results. |
| `system.message` | in | Update the system prompt between turns. Model-dependent; see §9.4. |
| `session.status_idle` | out | Awaiting input (includes `stopReason`, e.g. `requires_action` + blocking event IDs). |
| `session.status_run_started` | out | Transition to `running`. |
| `session.status_rescheduled` / `session.status_terminated` | out | Retry / terminal error. |
| `session.error` | out | Error (MCP failures carry `mcpServerName` + `retryStatus`). |
| `session.thread_*` | out | Multi-agent thread lifecycle/communication (§18). |
| `session.outcome_evaluation_*` | out | Outcome grader lifecycle (§16). |
| `agent.message` | out | Agent's buffered response text (authoritative record). |
| `agent.thinking` | out | Agent's thinking block. |
| `agent.tool_use` / `agent.mcp_tool_use` | out | Agent requests a tool call. |
| `agent.tool_result` | out | Result of a server-executed tool. |
| `agent.custom_tool_use` | out | Agent requests a custom-tool call (you execute). |
| `agent.thread_message_received` / `agent.thread_message_sent` | out | Multi-agent inter-thread messages. |
| `span.model_request_start` / `span.model_request_end` | out | Per-model-request boundaries. |
| `span.outcome_evaluation_*` | out | Outcome grader lifecycle. |

### 9.3 Streaming mechanism

**SSE.** Live stream (`GET /v1/sessions/:id/stream`) or poll/list (paginated history).

**Live previews (event deltas) — opt-in.** By default, agent text arrives as buffered
`agent.message` events (emitted after the model request finishes). Event deltas render text
incrementally as a best-effort display aid; the buffered `agent.message` is always
authoritative. Same semantics as Managed Agents:

- Opt in per stream connection via a query param (`eventDeltas=agent.message` etc.).
- Wire: `event_start` (announces upcoming event `type` + `id`) → `event_delta` (incremental
  text, keyed by `eventId` + `delta.index`) → buffered `agent.message` reconciles.
- `agent.thinking`: `event_start` only (content arrives in the buffered event).
- **Never persisted** — deltas live only on the connection that opted in; no replay on
  reconnect (reopen stream + list history; history includes buffered events).
- Primary thread, text only.

**Reconnect semantics (persisted events).** Every SSE frame for a persisted event carries
an SSE `id` (the event's sequence position in the session log). Clients reconnect with
`Last-Event-ID` (standard SSE) and the backend replays persisted events from that position
— so buffered events are gap-free across drops without a separate history call. Deltas are
never replayed (above).

### 9.4 Custom-tool flow

`agent.custom_tool_use` → session pauses (`session.status_idle`, `stopReason: requires_action`,
blocking event IDs) → you execute the tool → send `user.custom_tool_result` per blocking
event (passing the event ID as `customToolUseId`) → returns to `running`.

### 9.5 Tool-confirmation flow (permission policies)

`agent.tool_use`/`agent.mcp_tool_use` → `session.status_idle` with `stopReason: requires_action`
+ blocking `eventIds` → you send `user.tool_confirmation` per event (`allow`/`deny` + optional
`denyMessage`) → returns to `running`; denied tools return a tool result saying the call was
rejected (including your `denyMessage`).

### 9.6 `system.message` (mid-conversation system update)

Pi rebuilds the system prompt per turn (the `before_agent_start` extension hook can return
a replacement `systemPrompt`; the SDK also exposes `systemPromptOverride`). The
`system.message` event exposes this over the API. **Not model-dependent** — the system
prompt is sent fresh with every provider request, so mid-conversation updates work with
any model. The practical cost is
prompt-cache invalidation, not model support. Cannot be sent while idle with
`stopReason: requires_action`.

### 9.7 Usage tracking

The session object carries cumulative token usage: `inputTokens`, `outputTokens`,
`cacheCreationInputTokens`, `cacheReadInputTokens`. Cache TTL and pricing are
**provider-dependent** (cache TTLs vary by provider; some providers
have no cache) — the backend records what each provider reports and applies a
per-model price table for USD accounting. Used for cost tracking, `budget` enforcement
(§6.3), quota accounting. Per-tenant rollups in the SaaS shape.

## 10. Sandbox Layer (microsandbox)

The execution environment for every session. Each session that needs to run code gets its
own microsandbox microVM — an isolated Linux VM with its own kernel, spawned as a child
process of the backend via the NAPI SDK.

### 10.1 Provisioning

When a session starts work (first `user.message`, or resume of an idle session), the
backend calls `provision()`:

```
Sandbox.builder(tenantNamespacedName)
  .image(env.image)
  .cpus(env.resources.cpus)
  .memory(env.resources.memoryMiB)
  .volume(...)              // git repo, memory stores, files (upstream's mount API)
  .env(...)                 // vault secrets as $MSB_ placeholder bindings (§12)
  .network(policy)          // publicOnly() (= unrestricted) or default-deny + allowHost()
  .labels({tenant, session})
  .detached(true)           // survive backend restarts (§4.2)
  .create()
```

- **Names are tenant-namespaced** (e.g. `t<tenantId>-s<sessionId>`) to avoid microsandbox's
  flat namespace collisions. Labels carry `tenant=<id>`, `session=<id>` for metrics
  attribution and bulk operations.
- **Git repos** are cloned at provisioning time. **The token must never land in the
  guest filesystem** — writing it into the remote URL or a credential file inside the VM
  would make it readable by the agent (`git remote -v`, `cat .git/config`), defeating
  §25.1. Instead the token is registered as a microsandbox **secret binding**: the remote
  URL / `http.extraHeader` carries the `$MSB_<VAR>` placeholder, and the real token is
  substituted at the egress proxy when git talks to the allowed host. Clone, push, and
  pull work normally; the guest never holds the credential. (We deliberately avoid the
  "wire the token into the remote config" pattern — it is only safe when the
  git credential store is outside the sandbox, which is not our topology.)
- **Files** referenced in session `resources` are staged into the working directory before
  tool execution begins.

### 10.2 The Sandbox Operations adapter

Pi's built-in tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) call pluggable
`*Operations` interfaces (`BashOperations`, `ReadOperations`, `EditOperations`, etc.). We
implement these interfaces to delegate every tool call to the microVM:

```
BashOperations.exec(cmd, opts) → msb.sandbox.exec(cmd, {cwd, env, timeout})
ReadOperations.read(path)      → msb.sandbox.exec(['cat', path]) (or fs read via agentd)
...etc.
```

- Exec goes over microsandbox's control channel (virtio-console, framed CBOR) — **not
  SSH/network**, so it works even with networking fully disabled.
- **Completeness is mandatory:** *all seven* built-in tools must be constructed with
  remote operations (via the exported tool factories, e.g.
  `createReadTool(cwd, { operations })`, `createBashTool(cwd, { spawnHook })`) — any tool
  left on default operations executes **on the backend host**, a sandbox escape. The
  session factory asserts this at construction (no default-ops tool can be registered),
  and a CI test proves that every tool's side effects land in the VM, not the host.
  Host-executing paths like `user_bash` are disabled in managed sessions.
- Large outputs (>100k tokens) are auto-written to a file in the sandbox; the model gets a
  truncated preview + the file path.
- Streaming exec (`exec_stream`) pipes stdout/stderr to the agent tool result in real time.
- Per-exec options: `cwd`, `env`, `timeout`, `rlimit` — passed through from Pi tool options.

### 10.3 Lifecycle & checkpointing

- A session's sandbox runs detached while the session is active (survives backend
  restarts; re-attached by label on boot — §4.2).
- When a session goes **idle**, the backend **stops** the sandbox (config + filesystem
  persisted to disk by microsandbox). Idle-stop is **our** policy loop (after
  `idleTimeout`), not an upstream automatic mechanism — microsandbox provides explicit
  `stop()`/`start()`; the backend drives them. Resume **starts** it again (cold reboot,
  filesystem preserved; **processes are not preserved** — anything the agent left running,
  e.g. a dev server, is gone after resume; the harness should surface this to the model in
  the resume context). Checkpoints retained 30 days (configurable) after last activity.
- If a sandbox **crashes**, the backend detects it (microsandbox surfaces `Crashed` status),
  provisions a fresh one from the image (or a snapshot), and the harness resumes from the
  session log — transparent to the client.
- **Snapshots** (filesystem-only, requires stopped sandbox) can pre-warm images (e.g.
  "python + deps installed") for fast per-task boot, or fork a session's filesystem state.
  No live memory checkpoint (upstream limitation; §2 non-goal).

### 10.4 Self-hosted environments

For `self_hosted` environments, orchestration stays on the backend but tool execution
moves into infrastructure the subscriber controls.

- The `self_hosted` environment acts as a **work queue**: when a session is assigned, the
  backend enqueues a work item; the subscriber's worker claims items, runs tools locally,
  posts results back as `user.tool_result` events.
- **Worker patterns:** always-on (polls the queue; outbound HTTPS only) or
  webhook-triggered (wakes on `session.status_run_started`). The backend ships a default
  worker (Node) with two control levels: out-of-the-box, and a work-poller that hands each
  claimed session to a user-supplied spawn script (for per-session sandbox isolation).
- **`/v1/environments/:id/work-stats`** returns queue `depth`, `pending`,
  `oldestQueuedAt`, `workersPolling` (for liveness alerting).
- `work.stop` asks the worker handling a session to shut it down cleanly; `force: true`
  interrupts immediately. These calls auth with the org API key (not the environment key),
  and the docs warn against setting the org key on the worker host.
- **Differences from cloud env:** the subscriber stages files/repos themselves (passed via
  session `metadata`); memory stores and environment-variable credentials are **not
  supported** in self-hosted sandboxes (memory needs the
  managed mount, env-var secrets need the egress substitution boundary).

### 10.5 Default network policy

microsandbox's default egress policy is already a sane SSRF default for agent tool use:
public internet allowed; private/loopback/link-local/cloud-metadata/**host** denied.
High-risk agents tighten to `limited` + an explicit allow-list. Inbound only via published
ports (bound to 127.0.0.1 by default).

## 11. Tools

### 11.1 Built-in toolset

Pi's built-in tools — `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` — are the
default agent toolset. All execute in the sandbox via the Operations adapter (§10.2). Web
tools (`web_fetch`, `web_search`) are provided as managed features (the backend hosts the
fetch/search implementation; the agent calls them as tools) — these are **not** sandboxed,
they run in the backend process, because they need network egress the sandbox may not have.

**SSRF guard for backend-hosted web tools.** Because `web_fetch`/`web_search` execute in
the backend process with agent-controlled URLs, they bypass the sandbox egress policy —
an injected agent could otherwise probe `localhost`, RFC1918 ranges, or cloud metadata
*from the control plane*. The backend applies its own egress filter to these tools
(deny private/loopback/link-local/metadata; resolve-then-pin DNS to prevent rebinding;
cap redirects and re-check each hop) and never attaches internal credentials to fetched
requests. Environments with `limited` networking also constrain `web_fetch` to the same
allow-list by default (overridable per agent).

Toolset configuration (a default config plus per-tool overrides):

- Enable the full toolset by default; control availability via per-tool config.
- `defaultConfig` (baseline for every tool) + per-tool `configs` to disable or override.
- Each config entry can set a `permissionPolicy` (§22).
- To start with everything off: `defaultConfig.enabled: false`; enable per-tool.

### 11.2 Custom tools

User-defined tools. You define the contract (operations + return shapes); the agent emits
a structured request (`agent.custom_tool_use`); your code runs the operation; the result
flows back (`user.custom_tool_result`). The model never executes anything on its own.

- **Pi mapping:** custom tools are `defineTool({name, description, parameters, execute})`
  passed to `createAgentSession({customTools})` — but the `execute` function lives **in
  the client** (or in a webhook target), not the backend. The backend relays the call as
  an event and pauses the session until the result arrives.
- **Best practices (from the docs, enforced by our tooling):** extremely detailed
  descriptions (the biggest factor in tool performance); consolidate related operations
  into one tool with an `action` parameter; meaningful namespacing (`db_query`,
  `storage_read`); return only high-signal info (stable identifiers, only needed fields).
- **Permissions don't apply** to custom tools — you execute them, you decide whether to run
  before sending back the result.

### 11.3 Large tool outputs

When a tool output exceeds **100,000 tokens**, it's auto-written to a file in the sandbox;
the model receives a truncated preview + the file path. Same for MCP tool outputs.

## 12. Credentials & Secrets (Vaults)

Vaults are collections of credentials registered once and referenced by ID at session
creation — so you don't transmit tokens on every call, and per-user auth is a session-time
parameter. The vault reference is **per-session**: manage your product at agent granularity,
your users at session granularity.

### 12.1 Credential categories

- **MCP credentials** (`mcp_oauth`, `static_bearer`) — keyed by `mcpServerUrl`. When the
  agent connects to a server at that URL, the token is injected automatically.
- **Environment variables** (`environment_variable`) — keyed by `secretName` (the env var
  name). Stored in the sandbox as an **opaque placeholder**; substituted with the real
  secret **at the network egress boundary** when the agent makes an outbound request to an
  allowed host. The agent never sees the secret value. **Not supported in self-hosted
  sandboxes** (the egress boundary is the subscriber's, not ours).
- **Model-provider keys** (`model_provider_key`) — keyed by the Pi provider id (e.g.
  `openai`). The tenant's own model-provider API key (§4.2), resolved host-side at
  session wake into the session's in-memory `AuthStorage`. Never exposed to the sandbox,
  never returned by the API; an unresolvable key fails the wake closed rather than falling
  through to any host-level key.

**This is microsandbox's native secret model** — the exact credential-isolation invariant
our security model requires (§25). The backend writes secrets as microsandbox secret
bindings; the guest sees only `$MSB_<VAR>` placeholders; real values live host-side and are
swapped in only at egress, gated by four checks (allowed-host SNI match, DNS pin, TLS
identity, Host/`:authority`–SNI alignment).

**Verified upstream constraints the design must carry** (from microsandbox docs — see
Appendix A):

- Substitution requires **TLS interception** for the destination host — hosts that pin
  certificates or use non-TLS protocols can't use env-var substitution (use an MCP-style
  proxy or a custom tool instead).
- Request bodies that are **gzipped, HTTP/2-framed, or large fixed-length** are not
  rewritten — the request is **blocked**, not sent with the placeholder. Agents get a
  clear tool error; docs must tell subscribers to send secrets in headers where possible.
- Raw `.value()` secrets persist **verbatim in microsandbox's on-disk config** — the
  backend therefore treats the msb home directory as secret-bearing (owner-only perms,
  encrypted volume recommended for SaaS hosts) and purges bindings when sessions end.

### 12.2 Workspace-scoped

Anyone with an API key for the same tenant can reference a vault/credential when creating a
session. To revoke: delete the vault or credential.

### 12.3 `mcp_oauth` refresh

If you supply a `refresh` block, the backend refreshes the access token when it expires.
Refresh-call auth: `client_secret_basic` / `client_secret_post`. On refresh
failure: a `vault_credential.refresh_failed` event is emitted.

### 12.4 Constraints

- Unique key per vault (`mcpServerUrl` for MCP creds, `secretName` for env-var creds;
  duplicates error; keys immutable — to change one, archive and create a new).
- Max 20 credentials per vault (configurable per tier).
- Sensitive fields (`token`, `accessToken`, `refreshToken`, `clientSecret`,
  `secretValue`, `apiKey`) are **write-only** — never returned in API responses.

### 12.5 Lifecycle & re-resolution

Credentials are re-resolved periodically (during a session and during the vault lifecycle),
so rotation/archival/deletion propagates to running sessions without a restart. For
`mcp_oauth`, re-resolution also refreshes the token if expired. A `validate` operation
returns `valid` / `invalid` (grant gone — 401/403/404/410 → prompt re-auth) / `unknown`
(transient — other 4xx/5xx/429/network → retry).

### 12.6 Multi-agent note

MCP servers are agent-scoped (each agent declares its own); vault credentials are
session-scoped (`vaultIds` at session creation apply to every thread). Include a credential
for every MCP server used across all agents; to limit an agent's access, declare only the
servers it needs. In multi-agent sessions, the first vault with a matching credential wins.

### 12.7 Lifecycle operations

- **Archive a vault** cascades to all credentials (secrets purged, records retained for
  audit; future sessions referencing it fail; running sessions continue).
- **Archive a single credential** purges the secret payload but the key remains visible and
  is freed for a replacement.
- **Delete** is a hard delete (no record retained). Use archive if you need an audit trail.

Vault/credential webhook events: `vault.archived`, `vault.deleted`,
`vault_credential.archived`, `vault_credential.deleted`, `vault_credential.refresh_failed`.

## 13. Memory

Each session starts with fresh context by default; when it ends, agent-built state is gone.
**Memory stores** carry information across sessions: user preferences, project conventions,
prior mistakes, domain context.

### 13.1 What it is

A tenant-scoped collection of text documents optimized for the agent. When attached to a
session, it is **mounted as a directory inside the sandbox** (`/mnt/memory/<slug>/`). The
agent reads/writes it with the same file tools it uses for the rest of the filesystem, and
a note describing each mount is added to the system prompt. The agent toolset is required.

### 13.2 Each memory

Addressed by a path; read/edited directly through the API. Every change creates an immutable
**memory version** (audit trail + point-in-time recovery).

- Limits: individual memory ≤ 100 kB (~25k tokens); store holds max 2,000 memories. Structure
  as many small focused files. Max 8 memory stores per session.
- Attach at session creation only (via `resources[]` — a bare list of store IDs).
  `instructions` (≤4096 chars) and `access` (`read_write` default; `read_only` supported)
  are properties of the **store itself**, not of the attachment.
- **Read-only for untrusted input** — prevents a prompt injection writing malicious content
  into a `read_write` store that later sessions read as trusted memory.

### 13.3 Mounting (microsandbox)

The store mounts as a **bind/named volume** in the microVM under `/mnt/memory/<slug>/`.
Directory name = store display name sanitized to a filesystem-safe slug (lowercased;
non-alphanumeric runs → single hyphen). The exact path is in the `mountPath` field on the
session's memory-store resource (read it, don't construct it). Writes under the mount path
persist back to the store and sync across sessions sharing it; writes elsewhere under
`/mnt/memory/` land in container-local scratch and are lost on session end. `access` is
enforced at the filesystem level (read-only mount).

### 13.4 Safe content edits

`memories.update` accepts an optional `contentSha256` precondition — the update only
applies if the stored hash still matches; on mismatch, re-read and retry.

### 13.5 Memory versions

Every mutation creates an immutable version (`memver_…`). Versions belong to the store (not
the individual memory) and survive even after the memory is deleted — the audit trail stays
complete. Retained 30 days; recent versions always kept regardless of age. No dedicated
restore endpoint — to roll back, retrieve the version and write its `content` back. To
preserve history longer, export through the API.

### 13.6 Redact

Scrubs content out of a historical version while preserving the audit trail (who/what/when)
— for compliance (leaked secrets, PII, deletion requests). A version that is the current
head of a live memory cannot be redacted — write a new version first (or delete the memory),
then redact the old one.

### 13.7 Self-hosted note

Memory is **not** supported with self-hosted sandboxes (the managed mount is the backend's
responsibility; self-hosted workers stage their own files).

### 13.8 Pi mapping

Memory stores are **not** a Pi core concept. The backend implements them as a managed
resource (DB rows + object storage) mounted into the sandbox as a volume. The agent
interacts with them as ordinary files via the built-in tools — appearing in the event
stream as normal `agent.tool_use`/`agent.tool_result` events.


## 14. Tasks

Pi explicitly has **no built-in to-dos** (its philosophy: they confuse models; use a
TODO.md file or build your own with extensions). Managed Agents has no direct equivalent
either. We include a tasks feature because remote/scheduled work *needs* a backlog: a cron
that fires while you're asleep should be able to pick up a queue of pending tasks.

### 14.1 What it is

A lightweight, **per-session** task list the agent uses to track multi-step work within a
session. Not a cross-session project-management system (use memory stores for that).

### 14.2 Pi-native implementation

Following Pi's idiomatic pattern (see `examples/extensions/todo.ts`):

- Tasks are stored in **tool result `details`** (not external files) so they are
  **branching-correct** — forking a session forks the task state with it.
- State is reconstructed on `session_start` by scanning the session branch for the task
  tool's result entries.
- The backend ships this as a managed-feature Pi extension; the agent gets a `todo` tool
  (create/update/list/get/delete tasks with status `pending`/`in_progress`/`completed`).

### 14.3 Scope

Per-session (per active branch). Tasks do not persist across sessions by design — if you
need durable cross-session task tracking, use a memory store or an external system via
custom tools. This keeps the feature small and aligned with Pi's philosophy.

### 14.4 Remote task delegation (the cross-session case)

Separately from per-session tasks, the **client extension** (§24) supports delegating a
task to a *remote* session: "start an agent on the backend with this goal, notify me when
done." That is a **scheduled job** (one-shot, not cron) or a manually-created session —
not the per-session todo list. The two concepts are distinct and both exist.

## 15. Goals & Autonomous Loops

Pi has **no core goal concept** — the `pi-goal` package provides it as an extension, and
it's the reference implementation we follow. A goal is a persistent, autonomous objective
the agent works toward across multiple turns, self-continuing until complete or blocked.

### 15.1 What it is

A durable objective (with optional token budget) attached to a session. While active, the
agent autonomously continues after each turn ends, until the goal is complete/paused/cleared
or the budget is exhausted.

### 15.2 Pi-native implementation (following pi-goal)

- Goal state is stored in **tool-result details** (the branching-correct pattern tasks
  use, §14.2) and reconstructed on session start by scanning the branch for the latest
  `create_goal`/`update_goal` result. It follows the active session branch, survives
  reloads, needs no external DB.
- **Continuation mechanism:** the extension injects a compact "Goal active" custom message
  (carrying continuation instructions), triggers an agent turn, accounts time/tokens on
  `turn_end`, and **queues another continuation on `agent_end`** while the
  goal is active.
- `create_goal` is only callable when explicitly requested; `get_goal`/`update_goal` are
  only exposed to the model while a goal is `active` (avoids unrelated sessions calling
  them). Reloading pauses an active goal (no silent resume).
- The **pi-goal-writer skill** drafts strong goal contracts (outcome, verification surface,
  constraints, boundaries, iteration policy, blocked stop condition).

### 15.3 Backend integration

The backend ships `pi-goal` (or a backend-managed equivalent) as a managed-feature
extension loaded into every session by default (toggleable per agent). Over the API, a goal
is created by sending a `user.message` that requests one (the agent calls `create_goal`);
the continuation loop runs server-side — the session stays `running` across turns
without client pings. (A direct REST endpoint, `POST /v1/sessions/:id/goal`, remains
planned but is not implemented.)

### 15.4 Lifecycle

`active` → `paused` (manual or on reload) → `completed` | `blocked`. Status inspectable
via the API. Token/time budget enforcement is server-side (the backend kills the loop when
the budget is exhausted, transitioning the goal to `blocked` with a reason).

## 16. Outcomes (define-outcome)

Elevates a session from *conversation* to *work*: define what the end result should look
like and how to measure quality; the agent works toward that target, **self-evaluating and
iterating** until the outcome is met.

### 16.1 Auto-provisioned grader

When you define an outcome, the backend provisions a **grader** — a separate `AgentSession`
with its own context window (to avoid being influenced by the main agent's implementation
choices). The grader evaluates the artifact against a rubric and returns an explanation
summarizing which criteria passed/failed; that feedback is handed back to the agent for the
next iteration.

### 16.2 Rubric (required)

A markdown document describing per-criterion scoring. Pass inline as text on
`user.define_outcome`, or upload through the Files API for reuse across sessions.

### 16.3 `user.define_outcome` inputs

A `description`, a required `rubric` (`{type: "text", content}` or `{type: "file", fileId}`),
and `maxIterations` (default 3, max 20).

### 16.4 Pi-native implementation

- The main agent = an `AgentSession` running toward the outcome.
- The grader = a second `AgentSession` with a grader system prompt + the rubric, reading
  the main agent's output files. The backend orchestrates the iteration loop: main agent
  produces → grader evaluates → feedback to main agent → repeat.
- This is the classic generator/evaluator pattern, following Pi's
  own `examples/extensions/subagent/` reference. The grader is a subagent (§18) specialized
  for evaluation.

### 16.5 Evaluation results

| Result | Next |
|---|---|
| `satisfied` | Session → `idle`. |
| `needs_revision` | Agent starts a new iteration cycle. |
| `max_iterations_reached` | No further cycles; agent may run one final revision before `idle`. |
| `failed` | Session → `idle`. Rubric fundamentally doesn't match the task. |
| `interrupted` | Only if evaluation already started before a `user.interrupt`. |

Only one outcome at a time; chain outcomes in sequence (send a new `user.define_outcome`
after the terminal event of the previous). Listen on the event stream for
`span.outcome_evaluation_end`, or poll `GET /v1/sessions/:id/outcomes`.

### 16.6 Retrieving deliverables

The agent writes output files to `/mnt/session/outputs/` inside the sandbox. Once the session
is idle, fetch them through the Files API scoped to the session.

## 17. Scheduled Jobs (Crons)

A scheduled job allows an agent to start sessions **autonomously** on a recurring cron
schedule — enabling task completion over a predictable cadence.

### 17.1 What goes in a job

A `name`, an `agent` (same three forms as session creation), an `environmentId`,
`initialEvents` (a `user.message` event that starts the work — **required**), optional
session config (`resources`, `vaultIds`, etc.), and a `schedule`.

### 17.2 Cron & timezone semantics

Standard POSIX cron. Timezone is an IANA identifier. Max granularity: minute level. Literal
wall-clock matching (so `"0 20 * * *"` in `America/New_York` fires at 8 PM local
regardless of EST/EDT). Wall-clock times that don't exist on a spring-forward day are not
triggered; times that occur twice on a fall-back day fire twice. Schedule outside the 1–3 AM
local window or use UTC when missed/duplicate executions are unacceptable. Jitter up to 10
seconds to distribute load.

### 17.3 Limit

Max 1,000 scheduled jobs per tenant (configurable per tier).

### 17.4 Job runs

Each trigger attempt (scheduled or manual) writes a **run record** carrying either the
created `sessionId` or an `error.type` (`environment_archived`, `agent_archived`,
`vault_not_found`, `session_rate_limited`, `service_unavailable`).

### 17.5 Lifecycle

- **Pause:** suppresses scheduled triggers going forward; running sessions from a prior run
  continue; manual `run` is still allowed; sets `pausedReason: {"type": "manual"}`.
- **Unpause:** resumes from the next scheduled occurrence. **Missed triggers are not
  backfilled.**
- **Archive:** terminal — schedule stops, job becomes immutable. (A job whose agent has
  been archived is handled by §17.6: the next trigger records a failed `agent_archived`
  run and auto-pauses the job — it is not auto-archived.)

### 17.6 Failure behavior

Session-creation rate-limit responses are recorded immediately as a `session_rate_limited`
run **without retry**; the schedule tries again at the next occurrence. If a subagent
referenced by the agent has been archived, the next trigger records a failed run
(`agent_archived`) and the job is **automatically paused** so you can update the agent
and resume. Other unrecoverable session-creation errors (archived environment or vault)
behave the same: failed run + auto-pause; `pausedReason.error.type` mirrors the failed run's
`error.type`.

### 17.7 Manual run

Triggers a session immediately and writes a run marked as manual — lets you test before
committing to the schedule. Works while paused.

### 17.8 Implementation

The scheduler is an in-process async loop (single-node v1) that ticks every minute, computes
due jobs, and creates sessions. **Exactly-once firing** is enforced through Postgres, not
the loop: each occurrence is claimed by inserting a run row keyed on
`(job_id, scheduled_at)` with a unique constraint (`INSERT … ON CONFLICT DO NOTHING`), so
a crashed-and-restarted scheduler — or a second control-plane node later — cannot
double-fire. On restart, occurrences missed while down within a small catch-up window
(default 5 min, configurable) fire late; older misses are recorded as skipped runs
(consistent with "missed triggers are not backfilled", §17.5). For the multi-host SaaS
shape, scheduling stays on the control-plane node; session *execution* fans out to sandbox
hosts. Jobs persist to Postgres (across restarts). One-shot "run once" tasks (the
remote-delegation case, §14.4) are jobs with a single-fire schedule.

## 18. Multi-Agent Orchestration

Pi explicitly has **no sub-agents** (philosophy: spawn pi instances via tmux, or build your
own with extensions). We build our own, following Pi's `examples/extensions/subagent/`
reference, and expose it as a managed capability.

### 18.1 What it is

One agent (the **coordinator**) coordinates with others to complete complex work. Agents act
in parallel with isolated context, improving output quality and time to completion.

### 18.2 Shared vs isolated

- **Shared:** all agents share the same sandbox, filesystem, and vault credentials.
- **Isolated:** each agent runs in its own **session thread** — a context-isolated event
  stream with its own conversation history and its own configuration (model, system prompt,
  tools, MCP servers, skills). Tools/MCP/context are **not** shared. Threads are
  **persistent** — the coordinator can send a follow-up to an agent it called earlier, and
  that agent retains everything from its previous turns. The coordinator reports activity in
  the **primary thread**.

### 18.3 Roster entries (1–20)

- Reference a previously created agent by ID (pinned to the latest version at coordinator
  creation time if no `version`).
- Pin a specific version.
- `{"type": "self"}` — allow the coordinator to spawn copies of itself (session-level
  overrides apply to these copies).

The coordinator's config (including the roster) is **snapshotted at creation/update**;
referenced agents stay pinned to the versions resolved then. The coordinator can delegate to
only **one level** of agents (depth > 1 is ignored). Max 20 unique agents, but the coordinator
can call multiple copies of each.

### 18.4 When to use

Complex tasks across a variety of surfaces, or multiple well-scoped tasks contributing to an
overall goal. Patterns: **parallelization** (fan out independent subtasks, coordinator
synthesizes); **specialization** (route to agents with domain-focused prompts/tools);
**escalation** (consult a more capable agent/model for complex subtasks).

### 18.5 Threads

The session-level event stream is the **primary thread** — a condensed view of all activity
across all threads (start/end of subagents' work, blocking events). **Session threads** are
where you drill into a specific agent's activity. Max 25 concurrent threads.

### 18.6 Primary-thread multi-agent events

`session.thread_created`, `session.thread_status_running`, `session.thread_status_idle`,
`session.thread_status_terminated`, `agent.thread_message_received` (includes
`fromSessionThreadId`, `fromAgentName`, `content`), `agent.thread_message_sent` (includes
`toSessionThreadId`, `toAgentName`, `content`).

### 18.7 Tool permissions and custom tools across threads

If a subagent needs something from your client (permission to run an `always_ask` tool, or
a custom-tool result), the event is **cross-posted to the primary thread** with
`sessionThreadId` identifying the originating thread. Post `user.tool_confirmation` or
`user.custom_tool_result`; the backend routes the response to the correct thread.

### 18.8 Pi-native implementation

Each thread = its own `AgentSession` (in-process) bound to its own sandbox (or a shared one,
per shared/isolated mode). The coordinator is the primary thread's `AgentSession`, loaded
with a subagent extension that spawns child `AgentSession`s and routes inter-thread
messages. This directly follows `examples/extensions/subagent/` (single/parallel/chain
modes, agent `.md` definitions).

## 19. MCP Connector

Pi explicitly has **no MCP** (philosophy: build CLI tools with READMEs, or build an
extension that adds MCP support). We bridge MCP as a managed feature.

### 19.1 What it is

The backend connects to **remote MCP servers** that expose an HTTP endpoint (streamable HTTP
transport), or to **private MCP servers through MCP tunnels** (limited research preview —
phased late).

### 19.2 Two-step configuration (deliberate split)

1. **Agent creation** declares which MCP servers the agent connects to (by `name` + `url`).
   No auth tokens here.
2. **Session creation** supplies auth by referencing a pre-registered **vault** (§12).

This keeps secrets out of reusable agent definitions while each session authenticates with
its own credentials.

### 19.3 MCP server declaration

Each server needs a unique `name`, a `url` (http/https), `type: "url"` (no length bounds
are enforced on `name`/`url` in v1). Max 20 MCP servers per agent. Every `mcp_servers` entry must be referenced by an `mcp_toolset`
entry in the `tools` array, and vice versa — the API rejects unreferenced/dangling entries.

### 19.4 MCP toolset configuration

Same `defaultConfig` / `configs` shape as the built-in toolset, applied to the tools the MCP
server exposes. By default all tools exposed by the server are enabled; to enable only
specific tools, set `defaultConfig.enabled: false` and explicitly enable. Defaults to
permission policy `always_ask` (§22).

### 19.5 Authentication at session creation

Pass `vaultIds`; credentials are matched by URL (exact match including scheme and trailing
slash). If none matches, the connection is attempted unauthenticated.

### 19.6 Connection & auth failure handling

Session creation does **not** validate MCP connectivity. If a server is unreachable or rejects
the credential, the session still starts. A `session.error` event is emitted with the
affected server's `mcpServerName` and a `retryStatus`:

- `mcp_connection_failed_error` — server unreachable (network/timeout/non-auth HTTP failure).
- `mcp_authentication_failed_error` — server reached but rejected the credential.

Retried on the next `session.status_idle` → `session.status_running` transition.

### 19.7 Pi-native implementation

An MCP client extension that registers MCP tools as Pi tools (`pi.registerTool`) backed by
an MCP client library. The MCP proxy (credential injection) is backend logic: the backend
intercepts MCP tool calls, fetches credentials per-session from the vault, injects them into
the request. The harness (`AgentSession`) never sees credentials.

## 20. Skills

Pi has a native skills system (Agent Skills standard) — we use it directly.

### 20.1 Two types

- **Pre-built skills:** common document tasks (`pptx`, `xlsx`, `docx`, `pdf`), available in
  every tenant by default.
- **Custom skills:** authored by the subscriber, uploaded to their tenant.

The agent invokes both automatically when relevant (progressive disclosure: only name +
description in the system prompt; full `SKILL.md` loaded on demand).

### 20.2 Custom skill creation

A directory with a `SKILL.md` + supporting files, uploaded as a zip or individual files.
Returns a `skill_…` ID. Optional `displayTitle` (derived from `SKILL.md` if omitted; must be
unique among custom skills in the tenant).

### 20.3 Attach to agent

At agent creation, in the `skills` array. Each session supports up to 20 skills total
(counted across every agent in the session). Each entry: `type` (`prebuilt` or `custom`),
`skillId`, `version` (custom only; pin or `latest`; defaults to `latest`).

### 20.4 Pi-native implementation

Skills are stored as managed resources (object storage for the bundle, DB for metadata).
At session start, the backend materializes them into the session's `.pi/skills/` (or injects
via `DefaultResourceLoader({ skillsOverride })`) so Pi's native progressive-disclosure
loading applies unchanged. Skill *commands* (`/skill:name`) are available in RPC/SDK mode, so
they're invokable over the API too.

## 21. Files

A separate Files API for uploading and managing files. Upload, list, retrieve metadata,
download content, delete. Files are referenced by ID (e.g. in outcome rubrics as
`{type: "file", fileId}`, or in session `resources`). Files are independent resources — not
affected by session deletion. Files referenced via `/mnt/session/outputs/` for deliverables
are fetched scoped to the session once idle.

## 22. Permission Policies

Control whether **server-executed tools** (the built-in toolset + MCP toolset) run
automatically or wait for approval. Custom tools are executed by your application and
controlled by you — **not** governed by permission policies.

### 22.1 Three policy types

| Policy | Behavior |
|---|---|
| `always_allow` | Executes automatically, no confirmation. |
| `always_ask` | Session pauses, waits for your approval (§9.5). |
| `always_deny` | Unconditionally blocked — excluded from the model's tool list and hard-blocked at call time (no confirmation, no override). |

Each toolset has its own default: the **built-in toolset** defaults to `always_allow`;
**MCP toolsets** default to `always_ask` (so new tools added to an MCP server don't execute
without approval).

### 22.2 Configuration scope

Set in the agent's `tools` config at agent creation; change later by updating the agent. Apply
via `defaultConfig.permissionPolicy` (every tool) or per-tool via `configs`. Running
sessions keep the config they were created with; updates apply to sessions created afterward.

### 22.3 Pi-native implementation

The `tool_call` extension event can return `{ block: true, reason }` — this is the native
hook for `always_ask`. The backend's managed-feature extension intercepts `tool_call` for
tools with `always_ask`, blocks the call, emits the `session.status_idle` +
`requires_action` event, and waits for `user.tool_confirmation`. `always_allow` = no
interception. See `examples/extensions/permission-gate.ts`.

## 23. Webhooks

Sessions are long-running. Webhooks notify you of major state changes without polling.

### 23.1 Supported event types

`session.status_run_started`, `session.status_idled`, `session.status_rescheduled`,
`session.status_terminated`, `session.thread_created`, `session.thread_idled`,
`session.thread_terminated`, `session.outcome_evaluation_ended`, `session.updated`,
`session.deleted`. (Vault/credential and job/run lifecycle events are also delivered as
webhooks.)

### 23.2 Payload shape

Webhook events return the event `type` and `id`, **not** the full object. On receipt, you
fetch the object with a `GET`. This avoids stale data on retries and keeps deliveries small.
Every payload: event type, identifier, timestamp of object creation. The top-level
`event.id` is unique per event, not per delivery — if you receive the same `event.id` twice,
it's a retry, discard it.

### 23.3 Endpoint registration

A webhook endpoint = a **URL** (HTTPS on port 443, publicly resolvable hostname), the
**event types** subscribed, and a **signing secret** (`whsec_`-prefixed, shown once at
creation).

### 23.4 Signature verification

Every delivery carries an `X-Webhook-Signature` header. Verify the signature; reject if
invalid or the payload is more than 5 minutes old.

### 23.5 Delivery behavior

- **Ordering not guaranteed** — use `createdAt` to sort.
- **Retries:** at least once; same `event.id`.
- **Acknowledgment:** any `2xx` acknowledges; anything else (including `3xx`) fails and
  triggers a retry. Redirects are **not** followed.
- **Auto-disable:** an endpoint is auto-disabled (with a machine-readable `disabledReason`)
  after ~20 consecutive failed deliveries, or immediately if the hostname resolves to a
  private IP or the endpoint returns a redirect. Re-enable manually after fixing.

### 23.6 Implementation

An in-process webhook dispatcher (single-node v1) with a retry queue persisted to Postgres.
For the SaaS shape, this is a candidate for a dedicated worker pool.


## 24. The Pi Client Extension

> **Decision summary (resolved).**
> - **Event rendering:** Remote agent events render as a **separate live-view panel**
>   driven by the extension UI sub-protocol (`ctx.ui.setWidget`), which is ephemeral and
>   works over TUI and RPC. They are **not** interleaved into the local session's LLM
>   context. The local session records only a compact delegation entry + a completion
>   summary. (Pi's session log is strictly append-only — entries cannot be mutated in
>   place — so live updates go through the UI protocol, never through log rewrites.)
> - **Local↔remote relationship:** Local and remote are **separate sessions with separate
>   agents and sandboxes**. The local agent orchestrates remote sessions **via `remote_*`
>   tools** (status, steer/followUp, read outputs, spawn more) but does not execute code
>   inside them directly.
> - **Delegation gating:** `remote_delegate` is **configurable** (autonomous vs.
>   confirm) with tiered defaults — confirm for new tenants, autonomous for established
>   ones; spend caps always apply.

### 24.1 The Pi-coder persona

The client of this service is a **Pi coder** — a developer already using Pi locally to
write, debug, and run code. The extension adds remote capabilities without forcing them to
leave their local Pi. The core value props:

- **Delegate long work.** "This full E2E suite / build / migration will take 10 minutes;
  run it on the backend, I'll keep coding locally and pick up the result."
- **Run on a schedule.** "Every morning at 7am, pull the latest, run tests, report
  failures." (scheduled jobs, §17 — managed entirely backend-side; the extension is just
  the CRUD surface.)
- **Resume anywhere.** A session started from the laptop can be resumed from the phone or
  another machine via the backend, because the durable log lives server-side.
- **Use bigger/different environments.** Run an agent in a sandbox with packages or network
  access the local machine doesn't have, or that you don't want to pollute it with.

### 24.2 Reference journeys

**J1 — Delegate and continue.** Coder is mid-task in local Pi. Types
`/remote:delegate "run the full E2E suite and report failures"`. A live-view panel opens
showing the remote agent working. The coder keeps coding locally. The panel updates to
"completed; 2 failures". The coder runs `remote_read_outputs` (or the panel offers a
"pull outputs" action) to fetch the test report into the local cwd. The local agent reads
it and continues.

**J2 — Start a fresh remote session interactively.** Coder types `/remote:start`, picks an
agent + environment (or accepts defaults), types prompts in the local terminal that forward
to the remote session as `user.message` events; watches the remote agent work in the panel.
This is "use the backend's environment/sandbox as my agent's home" without delegating a
specific task.

**J3 — Resume from another machine.** Coder opens Pi on a second machine, runs
`/remote:sessions`, finds the idle session from J1/J2, runs `/remote:resume <id>`, continues
interacting. The backend re-provisions the sandbox; the JSONL tree resumes.

**J4 — Manage crons.** Coder runs `/remote:cron create "every weekday 7am: pull + test +
report"`, then `/remote:cron list` later to inspect runs. All execution happens backend-side
even when the local Pi is closed; the extension is the CRUD + inspection surface.

**J5 — Local agent self-delegates.** The local agent, mid-task, decides a subtask is
expensive and calls `remote_delegate` itself (if the gating policy allows). The local
agent then calls `remote_get_status` / `remote_read_outputs` to retrieve results and acts
on them — without the human driving.

### 24.3 Install & first-run

- **Install:** `pi install npm:@pi-managed/client` (or add to settings `extensions` array).
- **First run:** the extension detects no config and runs a `/remote:config` prompt
  (or, in TUI, a dialog) asking for:
  - backend URL (e.g. `https://api.pi-managed.example.com` or a self-hosted URL),
  - API key (paste), OR an OAuth-style `/remote:login` flow for the SaaS shape (opens a
    browser, returns a key stored in `auth.json`),
  - optional defaults: `defaultAgent`, `defaultEnvironment`.
- **Storage:** backend URL + key reference stored in Pi's `auth.json` via `AuthStorage`.
  The extension **never** handles model-provider keys — those live on the backend.
- **SaaS onboarding flow** (backend-side, §29.6): the tenant signs up, receives the
  install command + backend URL + API key, pastes them here.
- **Validation:** the extension pings `GET /v1/tenant` on first config; on success it
  records the tenant info and quota summary.

### 24.4 Configuration surface

The extension adds the following settings keys (under a `piManaged.*` namespace in
`~/.pi/agent/settings.json` or project `.pi/settings.json`):

| Key | Type | Default | Description |
|---|---|---|---|
| `piManaged.backendUrl` | string | — | Backend base URL. Required. |
| `piManaged.apiKeyRef` | string | `pi-managed-backend` | Reference into `auth.json` for the API key. |
| `piManaged.defaultAgent` | string | null | Agent ID/name for one-command delegate. |
| `piManaged.defaultEnvironment` | string | null | Environment ID/name. |
| `piManaged.delegationPolicy` | enum | `confirm` | `confirm` or `autonomous`. New tenants default to `confirm`; the SaaS onboarding may set `autonomous` after trust. |
| `piManaged.spendCapPerSession` | number | unset | Auto-abort a delegated remote session if estimated spend exceeds this. |
| `piManaged.spendCapPerDay` | number | unset | Daily aggregate cap across delegated sessions (client-side guard; see §24.6). |
| `piManaged.confirmThreshold` | number | unset | When policy is `autonomous`, still prompt if estimated cost ≥ this (not yet wired into the gating hook; see §24.6). |
| `piManaged.pollingIntervalMs` | number | 5000 | How often to poll a running delegated session for panel updates when SSE isn't usable (e.g. behind a corp proxy). |
| `piManaged.streamTimeoutMs` | number | 1800000 | Max duration to hold an SSE stream open before reconnecting. |
| `piManaged.outputsDir` | string | `./.pi-managed/outputs/` | Where retrieved remote outputs land locally. |
| `piManaged.tenant` | object | (from API key) | Cached tenant info `{tenantId, name?, quotaPlan?}`; read-only. |

**CLI flags** (registered via `pi.registerFlag`): `--remote` (run this prompt as a
delegation instead of locally), `--remote-agent <id>`, `--remote-env <id>`,
`--no-remote` (force local even if defaults say remote).

**Env vars:** `PI_MANAGED_BACKEND_URL`, `PI_MANAGED_API_KEY` (override settings; useful for
CI).

### 24.5 Commands

All invokable in TUI and via RPC/SDK `prompt` (extension commands are RPC-invokable, unlike
built-in TUI commands).

- `/remote:config` — set/change backend URL, API key, defaults.
- `/remote:login` — SaaS OAuth flow (opens browser, stores key).
- `/remote:start [agent] [env]` — start a fresh interactive remote session; opens the
  live-view panel; subsequent local prompts forward as `user.message`.
- `/remote:resume <sessionId>` — resume an idle remote session interactively.
- `/remote:sessions` — list remote sessions (status, title, last activity, usage).
- `/remote:fork <sessionId>` — fork a remote session (new session resource sharing the
  JSONL tree up to the fork point).
- `/remote:delegate <task>` — delegate a task (creates session + initial `user.message`,
  opens the live-view panel, returns the session ID). Runs to completion even if local Pi
  closes.
- `/remote:attach <sessionId>` — attach the live-view panel to an already-running
  delegated session (e.g. one started by a cron or by the local agent via the tool).
- `/remote:detach <sessionId>` — detach the live-view panel from a session.
- `/remote:cron <list|create|pause|unpause|run|archive>` — scheduled-job CRUD.
- `/remote:jobs` — list job runs.
- `/remote:memory <list|show|edit|mount>` — manage memory stores.
- `/remote:vault <list|create|add-cred|validate>` — manage vaults/credentials.

### 24.6 Tools (exposed to the local agent)

These are what enable J5 (local agent self-delegates). Each has an extremely detailed
description (the biggest factor in tool performance — §11.2) so the agent uses them well.

> **Wiring status:** the tools, gating hook, and `--remote*` flags are implemented and
> exported (`registerRemoteTools` et al.), but the default extension factory registers
> only the commands and renderers — tool registration requires a configured
> `ManagedApiClient` (which exists only after `/remote:config`), so it is done by an
> explicit wiring pass, not by default.

| Tool | Purpose | Returns |
|---|---|---|
| `remote_delegate` | Start a remote session with a task; returns immediately. | `{sessionId, status, costEstimate}` |
| `remote_start_session` | Start an interactive remote session (no initial task). | `{sessionId, status}` |
| `remote_send_event` | Send a `user.message` or `user.interrupt` to a remote session. | `{status}` |
| `remote_get_status` | Poll a remote session's status + last entry summary. | `{status, stopReason?, usage, lastEntry}` |
| `remote_list_sessions` | List the tenant's remote sessions (filterable). | `[{sessionId, title, status, ...}]` |
| `remote_read_outputs` | Fetch deliverables from a completed/idle session's `/mnt/session/outputs/` into the local cwd (under `outputsDir`). | `{paths: [...]}` |
| `remote_fork_session` | Fork a remote session. | `{newSessionId}` |
| `remote_create_cron` / `remote_list_crons` / `remote_pause_cron` / `remote_run_cron` | Job CRUD. | job records |
| `remote_memory_*` / `remote_vault_*` | Resource management. | resource records |

**Autonomy gating (§24.4 `delegationPolicy`):**

- `confirm` — `remote_delegate` and `remote_start_session` are `always_ask` (§22) at the
  client side: the local agent proposes, the user confirms before the backend session
  starts. Implemented via the `tool_call` interception hook returning `{ block: true,
  reason: "Remote delegation requires confirmation; cost estimate: $X" }` and surfacing a
  confirm dialog.
- `autonomous` — the agent may call `remote_delegate` directly. A **cost preview** is
  shown as a non-blocking notice. (`confirmThreshold`-triggered confirmation in autonomous
  mode is specified but not yet wired into the gating hook — today autonomous always
  allows.) The preview is deliberately crude — pre-run cost estimation for agentic work
  is unreliable, so it is computed from historical data (tenant's median per-session spend
  for this agent, falling back to a per-model default) and labeled as an estimate. The
  *real* protection is the hard cap: `spendCapPerSession` maps to the server-side session
  `budget.maxUsd` field (§6.3) and is enforced by the backend regardless of client policy —
  a compromised or buggy client cannot bypass it. (`spendCapPerDay` is a client-side-only
  guard today; it has no server-side field.)

### 24.7 The live-view panel

**Design constraint (verified):** Pi's session log is **strictly append-only** — there is
no API to mutate an existing entry. So the panel cannot be "an entry updated in place."
The correct Pi-native split is: **ephemeral live state via the UI sub-protocol, durable
state via (few, compact) appended entries.**

**Lifecycle:**

1. On `/remote:start` or `/remote:delegate`, the extension appends **one** `custom` entry
   (`customType: "pi-managed:delegation"`) recording the durable fact
   (`{sessionId, task, startedAt}`); `pi.registerEntryRenderer` renders it as a compact
   delegation marker.
2. The extension opens an SSE stream (`GET /v1/sessions/:id/stream`) and, on each
   `agent.message`/`agent.thinking`/`agent.tool_use`/`agent.tool_result`/`session.*`
   event, updates the live panel via `ctx.ui.setWidget` / `ctx.ui.setStatus` (buffered
   text, current tool, status). This is display-only — **nothing is appended to the local
   log per remote event**, so the log stays compact and the LLM context stays clean.
3. On `session.status_idle` (remote done), the widget shows a completion summary + a
   "pull outputs" affordance, and the extension appends a **second** `custom` entry
   recording the compact result (`{sessionId, status, usage, outputsAvailable: true}`) —
   **this** summary is what enters the local LLM context, not the full remote transcript.
   (Two durable entries per delegation: start + completion. Both survive forks correctly.)
4. Local prompts typed while the panel is attached are forwarded to the remote session as
   `user.message` events (interactive mode). In delegate mode, local prompts are NOT
   forwarded (the remote agent works toward its task autonomously); the user must
   `/remote:attach` and explicitly steer if they want to intervene.

**Why not interleave into context:** keeping the remote transcript out of the local LLM
context (a) prevents context pollution, (b) avoids the local agent confusing remote-agent
messages for its own, (c) keeps the local session log small and forkable. The local agent
gets the *result* via `remote_read_outputs` / the completion summary, not the full transcript.

### 24.8 Output retrieval

- `remote_read_outputs` tool + a "pull outputs" panel action fetch files from the remote
  session's `/mnt/session/outputs/` via the Files API (scoped to the session, idle-only)
  into the local `outputsDir` (default `./.pi-managed/outputs/<sessionId>/`).
- The tool returns the local paths so the local agent can `read` them with its normal
  file tool.
- For large outputs, the backend writes them to files (§11.3) rather than streaming — the
  local agent reads paths, not huge blobs.

### 24.9 Notifications for delegated work

Delegated sessions run to completion backend-side even when local Pi is closed. The
notification model:

- **While Pi is running:** the live-view panel streams in real time (SSE). No polling.
- **While Pi is closed:** no push is possible (a local terminal has no public webhook
  endpoint). On next Pi launch, the extension fetches the session list, finds sessions
  that completed while offline, and surfaces them as `custom` entries
  (`{sessionId, completedAt, status, outputsAvailable}`) so the user sees "sess_abc
  completed while you were away" on startup.
- **Optional webhook (advanced):** users who *do* have a public HTTPS endpoint can
  register a webhook (§23) pointing at a script that pings them (e.g. via `ntfy`/Slack).
  This is user-operated, not an extension feature.
- **Polling fallback:** if SSE is unusable (corp proxy), the panel polls
  `remote_get_status` every `pollingIntervalMs`.

### 24.10 Offline & error handling

- **Backend unreachable on `/remote:*`:** the command fails with a clear error; no local
  queueing (the backend is the executor; queuing locally would duplicate the scheduler).
  Retrying is the user's call.
- **SSE stream drops mid-session:** the panel shows "disconnected, reconnecting…", the
  extension reconnects with backoff, and on reconnect lists event history to reconcile
  (buffered events emitted while disconnected are in history; missed deltas are not — same
  semantics as §9.3).
- **Backend returns an error event (`session.error`, `session.status_terminated`):** the
  panel renders it; the completion summary records the failure reason.
- **Rate-limited:** surface the `session_rate_limited` run error verbatim; suggest slowing
  delegation cadence.

### 24.11 Client-side trust & security

- **No model-provider keys locally.** The extension holds only the backend API key. Model
  access is configured on the backend, per agent.
- **Delegation gating** (§24.6) prevents a prompt-injected local agent from burning remote
  compute — `confirm` policy or spend caps always apply.
- **API key storage:** in `auth.json` (Pi's secure credential store), referenced by
  `apiKeyRef`, never logged.
- **Output trust:** files fetched from a remote session are **untrusted** (the remote
  agent may have processed untrusted input). The extension writes them under
  `outputsDir` and does not auto-execute them. The local agent treats them as data.
- **No credential pass-through:** the extension never sends local env vars, SSH keys, or
  project secrets to the backend. If the remote session needs credentials, they must be
  registered as a vault (§12) on the backend and referenced by ID at session creation.

### 24.12 Architecture recap

```
┌───────────────┐     ┌─────────────────────────┐     ┌──────────────────────┐
│ Local Pi +    │     │  Extension (in-process)  │     │  Backend              │
│  extension    │     │  - commands (registerCommand)  │                     │
│               │     │  - tools (registerTool)       │                     │
│  TUI / RPC    │────▶│  - live-view renderer         │────▶ REST/SSE ──────▶│ AgentSession + sandbox
│  local agent  │     │  - tool_call gating hook      │     (HTTPS + SSE)     │ (remote)
│  (bash etc.)  │     │  - settings + auth.json       │                      │
└───────────────┘     └─────────────────────────┘     └──────────────────────┘
```

The extension is a **thin client**: HTTPS calls + SSE consumption + Pi-native rendering
hooks. It does not embed a second Pi; the remote agent is the backend's `AgentSession`.
The local Pi is the controller; the backend is the executor.

### 24.13 Distribution

- **npm package** `@pi-managed/client` (or similar). Install via `pi install
  npm:@pi-managed/client` or the settings `extensions` array.
- **Versioning:** the extension is versioned and pins a tested backend API version
  (`/v1`). Mismatched extension/backend versions surface a warning.
- **SaaS onboarding:** the backend's tenant onboarding flow (§29.6) hands the user the
  install command + backend URL + API key in one step.
- **Bundling:** the extension is a separate deliverable from the backend (the backend is
  the server; the extension is the client). They ship on independent release cadences but
  advertise compatible API versions.

## 25. Security Model

### 25.1 The load-bearing invariant: tokens never reach the sandbox

The sandbox environment does **not** contain API keys, OAuth tokens, or other secrets. Even
if the agent is prompt-injected, it **cannot exfiltrate credentials** because they're not in
its environment. This is enforced structurally by microsandbox's host-side secret model
(§12): secrets live host-side; the guest sees only `$MSB_<VAR>` placeholders; real values
are swapped in only at the network egress boundary, checked against observed DNS+TLS
identity.

### 25.2 Git access-token injection at provision

When a sandbox is provisioned with a git repo, the token is registered as a microsandbox
secret binding and the git remote carries only the `$MSB_<VAR>` placeholder; the real
token is substituted at the egress proxy (§10.1). Clone/push/pull work normally; the
agent can read its own git config and still learns nothing. We deliberately do **not**
wire the token into the local remote config — inside our
topology the remote config *is* agent-readable, so doing so would break the §25.1
invariant. Constraint inherited from §12: the git host must be TLS-interceptable for
substitution to work; hosts that can't be intercepted need a host-side clone staged into
the VM as a volume (fallback path, no push support).

**Implemented shape (R6.8).** A `repo` mount carries an `auth` *reference* — never a
token: `{ type: "git_token", vaultId, credentialKey }`, pointing at an
`environment_variable` credential whose value is the PAT. It also carries a `clone` mode:

| `clone` | What happens | Push? |
|---|---|---|
| `egress` (default) | The PAT is registered as a `git_token` secret binding scoped to the repo's git host (`allowHost(<host>)`, plus `trustHostCAs` so the guest accepts the interception cert). The provider clones **inside the guest** from `https://x-access-token:$MSB_GIT_TOKEN_<slug>@<host>/…`. That placeholder is what git persists into `.git/config`, so `git remote -v` / `cat .git/config` / `env` show the placeholder only; microsandbox substitutes the real token at egress (§25.4), and only toward the allowed host. | Yes |
| `staged` | **Fallback for git hosts that cannot be TLS-intercepted** (cert pinning, non-TLS transports; §12, §30 item 14). The backend clones the repo **host-side** into the tenant's managed repo root (the token is passed to `git` through the child process's env via an inline `credential.helper`, never through argv) and bind-mounts the working copy **read-only**. The guest holds no credential at all — and therefore cannot push. `readOnly: false` on a `staged` repo is ignored: the mount is always read-only. | No |

Compilation lives in `compileGitTokenBindings` / `compileRepoClones` (§6.2 → `ProvisionSpec`),
resolution in the `SecretStore` (bindings, value-free) + `VaultSecretResolver` (host-side
decryption), and materialization in `MicrosandboxProvider.provision`. The binding is the
only carrier that crosses the port surface, and it carries a placeholder + an opaque
credential ref — never a value (§25.5).

Known limits of the `egress` path: request bodies that are gzipped / HTTP-2-framed / large
fixed-length are **blocked rather than rewritten** by microsandbox (§12) — git's smart-HTTP
pushes send credentials in headers, so auth substitution is unaffected, but any git host
that pins certificates must use `clone: "staged"`.

### 25.3 MCP OAuth via vault + dedicated proxy

OAuth tokens are stored in a vault (not in the sandbox or harness environment). The agent
calls MCP tools via a dedicated proxy that intercepts MCP tool calls, fetches credentials
per-session from the vault, and injects them into the request. The harness never sees
credentials. Flow: `Vault → Proxy (per-session fetch + inject) → MCP Server`.

### 25.4 Env-var credential substitution at egress

For services authenticating through env vars, the secret is stored in the sandbox as an
opaque placeholder; at egress the placeholder is substituted with the real secret. The
agent never sees the value. (microsandbox-native; not supported in self-hosted sandboxes.)

### 25.5 Three trust boundaries

| Boundary | What it contains | What it can access |
|---|---|---|
| **Client** (user / extension) | API keys, OAuth grants | Provision sessions, send events, manage sandboxes |
| **Harness** (backend + `AgentSession`) | Session state (via getEntries) | Call the model, route tool calls; **cannot** see credentials |
| **Sandbox** (microVM) | Project files, execution env | Run code, edit files; **cannot** see credentials |

### 25.6 Prompt-injection mitigations

1. **Credential isolation** — even a fully compromised agent cannot exfiltrate credentials.
2. **Dedicated proxy for MCP tools** — the agent can call tools but cannot access underlying
   credentials.
3. **Network egress rules** — `unrestricted` (default-deny private/host/metadata) or
   `limited` + allow-list; even an injected agent can't send data to arbitrary hosts.
4. **Read-only memory mounts** for untrusted input — prevents writing malicious content
   into a shared store that later sessions read as trusted.

### 25.7 Tenant isolation (SaaS)

Row-level filtering on every query; sandbox names tenant-namespaced; API keys tenant-scoped;
no cross-tenant access by construction. Quotas prevent noisy-neighbor abuse. See §27.

## 26. Observability

### 26.1 Event stream as observability

The session log itself is the primary observability surface — every action recorded and
queryable. Full audit trail of agent actions, debugging (rewind to what led to a decision),
replay (reconstruct the exact sequence of events). See §9.

### 26.2 Usage tracking

The session object carries cumulative `usage` (input/output/cache-creation/cache-read tokens;
5-minute cache TTL). Per-session, per-tenant, per-agent cost accounting. Attribution via
session `metadata.userId`.

### 26.3 Span events

`span.model_request_start` / `span.model_request_end` bound per-model-request activity
(per-turn observability + reconciling preview deltas); `span.outcome_evaluation_*` covers
the grader lifecycle.

### 26.4 Sandbox metrics

microsandbox exposes point-in-time metrics + a stream (CPU/mem/disk-IO/net-IO/uptime) and
exports to Prometheus/Grafana/OpenTelemetry/Datadog via the `msb-metrics` collector. The
backend surfaces per-session sandbox metrics via the API and (for the SaaS shape) aggregates
per-tenant.

### 26.5 OpenTelemetry

The backend exports its own traces/metrics/logs via OpenTelemetry (configured via `OTEL_*`
env vars). **[RESOLVED]** span/metric names mirror the Pi Agent SDK's where they exist,
with backend-specific `pi.<domain>.<action>` additions (`infra/telemetry/conventions.ts`,
`docs/observability.md`); emission is wired end-to-end. Remaining gap: the per-VM
`pi.sandbox.*` gauges have no producer yet (observability.md §3).

### 26.6 Web console (later phase)

A web UI for browsing sessions (status, creation time, model), a tracing view (chronological
events, content, timestamps, token usage), and tool-execution details. Phased after the
core API is stable.

## 27. Multi-Tenancy & Isolation

### 27.1 Tenant context

Every API request carries a tenant context (derived from the API key). Every resource is
scoped to a `tenantId`. Every DB query applies row-level filtering on `tenantId`. Cross-tenant
access is impossible by construction. As defense-in-depth, a Postgres **row-level-security**
policy (migration `040_row_level_security.sql`, keyed on the `app.current_tenant` GUC set
via `SET LOCAL` in the `tenantScoped*` helpers) backstops the app-layer filter so a
hand-written query cannot cross tenants; system/cross-tenant sweeps leave the GUC unset.

### 27.2 Sandbox isolation

- Sandbox names are tenant-namespaced (`t<tenantId>-s<sessionId>`) — microsandbox's flat
  namespace is partitioned by us.
- microsandbox labels (`tenant=<id>`, `session=<id>`) carry attribution for metrics and
  bulk operations.
- Each sandbox is a real microVM with its own kernel — isolation between tenants is
  hardware-level, not namespace-level.

### 27.3 Quotas

Per-tenant limits enforced at the API and scheduler: concurrent sessions, concurrent
sandboxes, jobs, vault credential count, memory store count, file storage (bytes), monthly
token spend (via `metadata.userId` attribution). Quota plans map to subscription tiers.

### 27.4 Resource independence

Resources (agents, environments, vaults, memory stores, skills, files, jobs, webhooks)
belong to a tenant and are independent of sessions. Deleting a session never touches them.

## 28. Persistence & State

| State | Store | Notes |
|---|---|---|
| Session JSONL tree (durable log) | Local disk (write path) + object store (durability) | The source of truth. Path keyed by tenant + session ID. See durability note below. |
| Session metadata (status, usage, config) | Postgres | A row per session. |
| Agents, environments, vaults, memory, jobs, webhooks, files metadata | Postgres | Standard resource tables. |
| Secrets (vault credentials) | Postgres (encrypted) + microsandbox host-side store at runtime | Write-only from the API; never logged. |
| Memory store contents | Object store | Mounted into sandboxes as volumes. |
| Uploaded files | Object store | Referenced by ID. |
| Sandbox filesystems | microsandbox home (`~/.microsandbox/`) | Ephemeral per-session; checkpointed on idle; snapshot for forks. |
| Job/scheduler state | Postgres | Survives restarts. |
| Webhook deliveries + retry queue | Postgres | |

The backend does **not** duplicate the conversation into Postgres — the JSONL tree is the
canonical record; Postgres holds only metadata for queryability.

**JSONL durability (the log must be more durable than everything it recovers).** Pi's
`SessionManager` writes JSONL to local disk; "crash recovery = re-read the log" only holds
if the log survives the crash. Policy: active sessions append to local disk (Pi-native);
the backend syncs the file to the object store on every `session.status_idle` transition
and at a periodic interval while `running` (default 30 s, configurable). A host loss can
therefore lose at most the tail of the current turn — acceptable, since an incomplete turn
is re-runnable — but never an idle session. Self-hosted deployments using plain filesystem
as the "object store" should point it at durable storage.

**Backup & DR (self-hosted guidance, SaaS requirement):** Postgres PITR (WAL archiving) +
object-store versioning covers everything except in-flight sandbox filesystems, which are
expendable by design (§5.3). Vault credentials are encrypted at rest with a KMS-managed
key (SaaS) or a key file (self-hosted); the key is required for restore and must be backed
up separately from the database.

## 29. Phasing Roadmap

The full feature set is specced above. Build is incremental. Each phase delivers a usable,
verifiable increment.

### 29.1 Phase 0 — Foundations

**Goal:** a deployable backend skeleton with auth, tenants, and the storage layer.

- Node + TypeScript service scaffold; Postgres + object-store wiring.
- Tenant + API-key model; `Authorization: Bearer` auth middleware; row-level tenant
  filtering.
- Config + env-var loading; structured logging; basic OTEL.
- Health/readiness endpoints.

**Verify:** `curl` an authenticated endpoint; create a tenant + API key; confirm cross-tenant
isolation with a negative test.

### 29.2 Phase 1 — Core managed sessions (the MVP)

**Goal:** create an agent, create an environment, start a session, stream events, run code in
a sandbox.

- Agents API (create/list/get/update/archive/versions).
- Environments API (cloud type only; self-hosted deferred).
- Sessions API (create/list/get/fork/delete/entries/tree/messages/usage).
- Events API (send `user.message`/`user.interrupt`; SSE stream with `session.*`/`agent.*`/
  `span.*` events; event-delta previews).
- microsandbox integration: the Sandbox Operations adapter (bash/read/write/edit/grep/find/ls
  → microVM); provisioning; stop/start on idle; crash recovery.
- Built-in toolset with per-tool config + `defaultConfig`.
- Basic vaults: `static_bearer` + `environment_variable` credentials; egress substitution.
- Usage tracking (token accounting).
- The **Pi client extension** (§24) with `/remote:start`, `/remote:resume`,
  `/remote:sessions`, `/remote:delegate`, `/remote:config`.

**Verify:** install the extension in a local Pi; `/remote:delegate "write a hello world
node app"`; watch the remote agent create files in a microVM; resume the session after it
goes idle; fork it. Confirm credentials in the vault are never readable from inside the
sandbox (injection test). **Host-escape test:** every built-in tool's side effects land in
the VM, never the backend host (§10.2). **Load test:** N concurrent sessions (target set
during Phase 1; measure per-session heap + VM RSS) — exit criterion for declaring the
single-node capacity envelope. **Restart test:** kill -9 the backend mid-turn; confirm
detached VMs survive, sessions resume from the log, and no scheduler double-fire occurs.

### 29.3 Phase 2 — Scheduling, memory, permission gates

**Goal:** crons, cross-session memory, and approval flows.

- Scheduled jobs API (cron semantics, runs, pause/unpause, manual run, auto-pause on
  failure).
- Memory stores API (mount as volume, versions, redact, optimistic concurrency).
- Permission policies (`always_ask` via the `tool_call` interception hook; confirmation
  flow).
- `mcp_oauth` credential refresh + `vault_credential.refresh_failed` events.
- Webhooks (endpoint registration, signature verification, retries, auto-disable).

**Verify:** create a cron that fires every minute; confirm run records; pause and resume;
create a memory store, attach read-only, confirm the agent can't write to it; set a tool to
`always_ask`, confirm the confirmation flow round-trips; register a webhook, trigger a
session status change, verify signature.

### 29.4 Phase 3 — Multi-agent, outcomes, MCP

**Goal:** orchestration, self-evaluation, and external tool servers.

- Multi-agent orchestration (roster, threads, shared/isolated, inter-thread messaging,
  cross-posted blocking events).
- Outcomes (`user.define_outcome`, grader subagent, iteration loop, evaluation results,
  deliverables in `/mnt/session/outputs/`).
- MCP connector (server declaration, toolset config, vault auth, connection/auth failure
  handling, MCP proxy for credential injection).
- Custom tools (the `agent.custom_tool_use` / `user.custom_tool_result` flow).
- Skills upload + attach (pre-built + custom).

**Verify:** coordinator delegates to two subagents in parallel, synthesizes results; define
an outcome with a rubric, confirm the grader runs and `needs_revision` → `satisfied`; connect
an MCP server with a vault credential, confirm the agent calls its tools; upload a custom
skill, confirm the agent loads it on demand.

### 29.5 Phase 4 — Self-hosted sandboxes + SaaS hardening

**Goal:** execution on subscriber infrastructure; multi-host scale.

- Self-hosted environments (work queue, always-on + webhook-triggered workers, work-stats,
  work.stop, default worker).
- Multi-host sandbox scheduling (a pool of KVM hosts; the backend routes microVM
  placement; host liveness/alerting).
- Quota enforcement + subscription-tier mapping.
- Web console (session list, tracing view, tool-execution details).
- MCP tunnels (limited research preview — depends on upstream maturity).

**Verify:** run a self-hosted worker against the backend; confirm a session's tools execute
on the worker; scale to 2+ sandbox hosts and confirm placement; hit quota limits and confirm
enforcement; browse sessions in the web console.

### 29.6 Phase 5 — Extensibility polish

**Goal:** make the subscription product real.

- Plugin interfaces for every major subsystem (sandbox provider, secret store, scheduler,
  tool registry) with documented contracts and a default impl.
- Tenant onboarding flow (SaaS): sign up, issue API key, hand the user the
  `pi install` command + backend URL.
- Billing processor integration (the usage → metering → sink hooks already ship —
  `BillingSink` with no-op + HMAC-signed webhook impls; only external billing-processor
  wiring remains).
- SLA/limits configurability per tier.
- OpenTelemetry conventions finalized; dashboards.

## 30. Open Questions

> To resolve collaboratively before/during implementation. Items marked **[GAP]** are
> inherited unknowns from the source research; **[OPEN]** are design decisions for this
> spec.

1. **[RESOLVED] API wire contract.** `docs/api-reference.md` pins the exact JSON schemas,
   HTTP status codes, pagination cursors, field char-limits, and final event-type strings;
   the `@pi-managed/contracts` package mirrors it.

2. **[OPEN] Model-provider routing in SaaS.** Does the backend route model calls through a
   customer-configured provider key per agent, or does the SaaS shape provide a proxy/gateway
   (with `pi.registerProvider` + `before_provider_headers`) for attribution/billing? Affects
   how subscribers supply model access.

3. **[RESOLVED] OTEL conventions.** Mirror the Pi Agent SDK's span/metric names where they
   exist, plus backend-specific `pi.<domain>.<action>` names
   (`infra/telemetry/conventions.ts`, `docs/observability.md`). Emission is wired
   end-to-end; only the per-VM `pi.sandbox.*` gauges lack a producer.

4. **[RESOLVED] Concurrency caps.** Implemented as per-tier quotas `concurrentSessions` /
   `concurrentSandboxes` (`domain/quota/plans.ts`, tier defaults in
   `domain/tier-config/config.ts`; the default *values* remain policy placeholders).

5. **[RESOLVED] Sandbox execution timeouts.** Default per-exec timeout 120s with
   per-agent/per-tool override (`session-manager/operations/remote-operations.ts`).

6. **[GAP] Session log retention.** Beyond the 30-day checkpoint window — how long is the
   JSONL tree retained? Per-tier? Purge-on-request?

7. **[GAP] `rescheduling` semantics.** How many retries, what backoff, before `terminated`?

8. **[RESOLVED] Session forking over the API.** `POST /v1/sessions/:id/fork` returns a
   *new session resource* (`forkedFromSessionId` set) sharing the JSONL tree up to the
   fork point (Pi-native), not a copy.

9. **[RESOLVED] `system.message` model support.** Verified: Pi rebuilds the system prompt
   per turn (`before_agent_start` / `systemPromptOverride`), so mid-conversation updates
   are not model-dependent — no capability flag needed (§9.6). The cost is prompt-cache
   invalidation.

10. **[OPEN] Tasks scope.** §14 keeps tasks per-session only. Confirm we don't want a
    cross-session task backlog (the remote-delegation case covers durable work via
    one-shot jobs).

11. **[OPEN] Default skills.** Which pre-built skills ship by default in v1?
    (`pptx`/`xlsx`/`docx`/`pdf` are the v1 seed set; we may adjust
    based on Pi's audience.)

12. **[RESOLVED] primus KVM availability.** GCP supports nested virtualization on Intel
    x86 machine types (Haswell+) via `enableNestedVirtualization`; not on ARM (T2A).
    Confirm primus's machine type and flip the flag if needed; expect a perf tax vs bare
    metal (§7.3).

13. **[RISK] microsandbox beta churn.** Upstream is explicitly beta ("expect breaking
    changes"); the current embedded/NAPI architecture is a recent ground-up rewrite
    (PR #455) and the Node SDK is the newest, least battle-tested SDK (PR #463). Policy:
    pin the exact msb version; wrap it behind the sandbox-provider interface (§29.6) from
    day one; maintain an upstream-upgrade test suite (secrets substitution, egress policy,
    stop/start, snapshot) that gates version bumps.

14. **[OPEN] Cert-pinned / non-TLS hosts vs env-var secrets.** Egress substitution
    requires TLS interception (§12). Decide the recommended pattern for services that pin
    certificates (likely: custom tool executed client-side, or backend-side proxy tool).

15. **[OPEN] Per-session memory footprint.** Pi does not document per-`AgentSession` heap
    cost; hundreds of concurrent sessions per node is asserted, not measured. The Phase-1
    load test (§29.2) turns this into a number that sets default per-tenant concurrency
    quotas (question 4).

## 31. Glossary

- **Backend / Pi Managed Backend** — the service this spec defines.
- **Pi** — `@earendil-works/pi-coding-agent`, the coding agent harness. Consumed as a
  dependency via its SDK.
- **`AgentSession`** — Pi's in-process object representing one running agent (the "brain").
- **Session JSONL tree** — Pi's durable, append-only, tree-structured session log. The
  source of truth for a managed session.
- **microsandbox** — the microVM runtime used as the sandbox ("hands"). Embedded as a child
  process via its NAPI SDK.
- **Sandbox Operations adapter** — our implementation of Pi's `*Operations` interfaces,
  delegating tool calls to the microVM.
- **Vault** — a collection of credentials, referenced per-session.
- **Memory store** — a mounted collection of text documents carried across sessions.
- **Job** — a scheduled (cron) or one-shot autonomous agent run.
- **Thread** — a context-isolated event stream for a subagent in a multi-agent session.
- **Outcome** — a rubric-defined target the agent self-evaluates against, iterating until
  satisfied.
- **Tenant** — an organization scope. Every resource belongs to one. The SaaS shape serves
  many; self-hosted serves one.
- **Client extension** — the Pi extension (§24) that bridges local Pi to the backend.
- **Meta-harness** — the session/harness/sandbox triad; Pi already
  embodies it, so we wrap rather than reimplement.

---

## Appendix A — Feasibility Verification (2026-07-12)

Audit of every load-bearing upstream claim, performed against microsandbox `main`
(`superradcompany/microsandbox`, HEAD `2d46ce7`, 2026-07-11) and the locally installed Pi
SDK docs (`@earendil-works/pi-coding-agent`). Corrections were applied in place; this
appendix is the evidence record.

### A.1 microsandbox claims

| # | Spec claim | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | Node NAPI SDK, `Sandbox.builder()` with image/cpus/memory/env/mount/create | **Confirmed** (naming: mounts are `.volume()`) | `sdk/node-ts/native/sandbox_builder.rs`; "spawns a local VM as a child process; no daemon" (README, `docs/sdk/overview.mdx`) |
| 2 | Host-side secrets, `$MSB_<VAR>` placeholders, egress substitution checked against DNS+TLS identity | **Confirmed** — four-gate check (SNI allow-list, DNS pin, TLS identity, Host/`:authority` alignment) | `docs/security/secrets.mdx`. Constraints added to §12: TLS interception required; gzipped/HTTP2/large-fixed-length bodies blocked, not rewritten; raw secrets persist in msb on-disk config |
| 3 | Egress policies: default deny private/loopback/link-local/metadata/host; `limited` + allow-list | **Confirmed** (naming: no literal `limited` mode) | `docs/security/network.mdx`; presets `publicOnly()` (our `unrestricted`), custom default-deny + `allowHost()` (our `limited`). Includes DNS-rebind and TOCTOU protections |
| 4 | Stop/start with config+filesystem persisted (checkpoint on idle) | **Confirmed** for stop/start; **corrected**: idle-stop is our policy loop, not upstream automation (§10.3) | `docs/sandboxes/lifecycle.mdx` |
| 5 | Filesystem-only snapshots; no live RAM suspend | **Confirmed** exactly | `docs/sandboxes/snapshots.mdx` ("disk-only", cold boot) |
| 6 | Labels for attribution + bulk ops | **Confirmed** | `.label()/.labels()`, `Sandbox.listWith({labels})` |
| 7 | Metrics point-in-time + stream; `msb-metrics` → OTLP | **Confirmed** (Prometheus via the OTel path, not native) | `sdk/node-ts/src/metrics.ts`, `docs/observability/msb-metrics.mdx` |
| 8 | virtio-console framed-CBOR control channel; exec with networking disabled; `execStream`; cwd/env/timeout/rlimit | **Confirmed** | `crates/protocol/lib/codec.rs`, `crates/agentd/lib/serial.rs`, `docs/security/isolation.mdx` |
| 9 | `Crashed` status surfaced | **Confirmed** | `sandbox-status.ts`: `running\|stopped\|crashed\|draining` |
| 10 | OCI images; bind/named volumes; ports bound to 127.0.0.1 | **Confirmed** | README, `docs/sandboxes/volumes.mdx`, `docs/networking/overview.mdx` |
| 11 | Linux/KVM via libkrun; macOS AS dev; `~/.microsandbox` + agentd | **Confirmed** (upstream also supports Windows/WHP; we don't target it) | README, `sdk/node-ts/src/setup.ts` |
| 12 | Sandboxes as child processes of the embedder | **Confirmed**; `.detached(true)` survives embedder exit — adopted in §4.2 | `docs/sandboxes/lifecycle.mdx` |

**Maturity:** ~6.9k stars, Apache-2.0, very active (releases weekly-to-monthly). Explicitly
**beta**; the embedded/NAPI architecture is a recent ground-up rewrite (PR #455) and the
Node SDK is the newest surface (PR #463). Stale upstream docs still describe the pre-rewrite
JSON-RPC server — ignore them; the spec's process model matches *current* upstream. Risk
management: §30 item 13 (pin version, provider interface, upgrade-gating test suite).

### A.2 Pi SDK claims

| # | Spec claim | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | `createAgentSession()` embedding with model/customTools/resourceLoader | **Confirmed**; `extensionFactories` lives on `DefaultResourceLoader`, not `createAgentSession` (fixed in §6.1) | `docs/sdk.md` |
| 2 | Pluggable `*Operations` for all seven built-in tools | **Confirmed** — tool factories accept `{ operations }` / `{ spawnHook }`; §10.2 now mandates all-seven coverage + host-escape CI test | `docs/extensions.md` "Remote Execution", `examples/extensions/ssh.ts` |
| 3 | Append-only JSONL tree, custom entries, branch-scan reconstruction, resume from file | **Confirmed** | `docs/session-format.md`, `session-manager.d.ts` |
| 4 | Extension API: registerTool/defineTool, `tool_call` → `{block, reason}`, registerCommand/Flag/EntryRenderer, UI sub-protocol over RPC | **Confirmed** (handler errors also block — fail-safe) | `docs/extensions.md`, `docs/rpc.md` |
| 5 | Live-view panel as an entry "mutated in place" | **False** — the log is strictly append-only; no entry-mutation API exists. **§24.7 redesigned**: ephemeral `ctx.ui.setWidget` for live state + two compact appended entries (start/completion) | `session-manager.d.ts:273` |
| 6 | `AuthStorage` / auth.json | **Confirmed** (incl. `.inMemory()`, used per-session in §4.2) | `docs/sdk.md`, `auth-storage.d.ts` |
| 7 | Skills: progressive disclosure, `skillsOverride`, `/skill:name` over RPC | **Confirmed** | `docs/skills.md`, `docs/sdk.md`, `docs/rpc.md` |
| 8 | Mid-session system prompt updates, "model-dependent" | **Confirmed / corrected** — supported per-turn via `before_agent_start`; **not** model-dependent in Pi (§9.6 fixed; §30 item 9 resolved) | `docs/extensions.md` |
| 9 | Reference examples: todo.ts, subagent/, permission-gate.ts | **Confirmed** (todo state in tool-result `details`, branching-correct; subagent single/parallel/chain) | `examples/extensions/` |
| 10 | `pi-goal` package semantics | **Confirmed** (v0.1.7: `customType: "pi-goal"` entries, continuation on `agent_end`, pause on reload) | local `node_modules/pi-goal/README.md` |
| 11 | RPC mode; extension commands invokable, built-in TUI commands not | **Confirmed** | `docs/rpc.md` |
| 12 | Compaction + post-compaction message view | **Confirmed** (`session.messages`, RPC `get_messages`) | `docs/compaction.md` |
| 13 | Many concurrent `AgentSession`s in one process | **Undocumented** — cwd is plumbed per-session (no `process.chdir`), but env-var config and `getAgentDir()` are process-global. Mitigations adopted in §4.2 (in-memory auth/settings per session, no env-var provider keys); load test is a Phase-1 exit criterion | dist type inspection |

### A.3 Corrections applied to this spec (summary)

1. **§24.7 live-view panel** — rewritten from "entry mutated in place" (impossible) to
   ephemeral UI widget + two appended entries.
2. **§10.1/§25.2 git tokens** — rewritten from "token wired into remote config" (readable
   by the agent in our topology) to `$MSB_` placeholder in the remote + egress
   substitution, with a staged-volume fallback for non-interceptable hosts.
3. **§11.1 backend-hosted web tools** — added an explicit SSRF guard (they bypass sandbox
   egress policy).
4. **§9.6 `system.message`** — removed the false model-dependence constraint.
5. **§12 secret substitution** — added verified upstream constraints (TLS interception,
   blocked body encodings, on-disk persistence of raw secrets).
6. **§6.2/§10.5 naming** — `.volume()` not `.mount()`; `limited` compiles to default-deny
   + `allowHost()`; `unrestricted` = `publicOnly()`, not `allowAll()`.
7. **§9.7 cache TTL** — made provider-agnostic (provider-dependent, priced via a table).
8. **§10.3 idle checkpointing** — clarified as backend policy, noted processes don't
   survive resume.
9. **§17.8 scheduler** — added exactly-once firing via unique `(job_id, scheduled_at)`
   run rows + bounded catch-up window.
10. **§28 durability** — added JSONL local-write + object-store sync policy, backup/DR,
    and secrets-at-rest key handling.
11. **§6.3/§24.6 budgets** — added a server-side session `budget` field; client spend caps
    now map to it instead of being client-enforced; cost "estimates" downgraded to
    historical medians.
12. **§8 API semantics** — added idempotency keys, hashed API keys, 429/Retry-After,
    cursor pagination as locked behavior.
13. **§9.3 SSE reconnect** — added `Last-Event-ID` replay for persisted events.
14. **§4.2 process model** — added per-session isolation of Pi's process-global config,
    detached VMs + label re-attach, RAM-bounded capacity note.
15. **§29.2 verification** — added host-escape, load, and kill‑9 restart tests as Phase-1
    exit criteria; **§30** gained items 13–15 and resolved items 9 and 12.

---

*End of spec. This is a draft for your review — please mark up anything that's wrong,
missing, or scoped incorrectly before we move to the API-reference doc and implementation.*
