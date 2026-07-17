# User Journeys — Pi Managed Backend

> Every journey the system serves, organized by persona: the **platform admin** who
> operates the service, the **tenant admin** who governs an organization on it, and the
> **user** — the Pi coder the whole thing exists for. Machine actors (workers, host
> agents) are covered at the end for completeness.
>
> The user journeys J1–J5 are normative in [`spec/spec.md`](spec/spec.md) §24.2; this
> document restates them alongside the admin journeys the spec defines only implicitly.
> System internals referenced here are described in
> [`architecture.md`](architecture.md); wire details in
> [`api-reference.md`](api-reference.md).

---

## 1. Personas and the access model

An honest note first: these personas are **roles, not account types**. The backend has
exactly one authenticated identity mechanism — the tenant-scoped API key and its
scopes. What distinguishes the personas is *which surface they touch*:

| Persona | Who | Credential | Surface |
|---|---|---|---|
| **Platform admin** | Whoever deploys and operates the backend process(es) — an individual self-hoster or the SaaS operator | None at the API level — shell access, env config, the database, the hosts | Deployment config, `docker compose`, migrations, OTEL, backups. There is **no `/v1` platform-admin API**; operating power comes from owning the process |
| **Tenant admin** | The owner of a tenant: sets up keys, credentials, agents, environments, governance | API key with `admin` scope (the key issued at onboarding) | Full `/v1` API, key management, vaults, webhooks, the web console |
| **User (Pi coder)** | A developer using Pi locally who delegates, schedules, and resumes remote work | API key with `read`+`write` scopes (least privilege), configured into the client extension | The `/remote:*` commands and `remote_*` tools in local Pi; optionally raw `/v1` and the web console |
| **Machine actors** | Self-hosted workers, sandbox host agents, webhook receivers | Worker key (`self_hosted_worker:<envId>`), per-host bearer + mTLS, HMAC signatures | Three work-queue routes; the host-agent wire contract; webhook POSTs |

In the v1 self-hosted shape there is **one implicit tenant**, so one person often plays
all three roles — the layering still holds, they just switch hats (and keys).

---

## 2. Platform admin journeys

### P1 — Stand up a single-host deployment

*Goal: a working backend on one Linux/KVM machine.*

1. Provision a Linux host with `/dev/kvm`, Node ≥ 20, Docker (or managed
   Postgres 16 + an S3-compatible or GCS store).
2. `pnpm install && pnpm build`; start dependencies (`docker compose up -d postgres
   minio` in dev).
3. One-time microsandbox bootstrap: `node -e "import('microsandbox').then(m =>
   m.install())"` — populates `~/.microsandbox/`.
4. Generate and safely store a 32-byte **vault key**; set `VAULT_KEY` (or
   `VAULT_KEY_FILE`). The process **refuses to boot without one** — losing it later
   makes every stored credential undecryptable, so treat it as a backup artifact from
   day one.
5. Set `DB_URL`, `OBJECT_STORE_ROOT`, `PI_SESSION_LOCAL_DIR` (durable disk, not
   `/tmp`), `SANDBOX_RUNTIME=enabled`, and boot `dist/main.js`. Migrations run
   forward-only on boot.
6. Verify: `GET /healthz` (liveness), `GET /readyz` (db + objectStore + sandbox all
   `up`).
7. Create the first tenant + admin key — either enable onboarding temporarily or run
   the signup route once (`POST /v1/onboarding/signup`) — and hand the key to the
   tenant admin (often: yourself, switching hats).

*Behind the scenes:* boot is fail-closed — invalid config, missing vault key, or a
misconfigured billing sink exits 1 before serving. Full variable reference:
[`deploy.md`](deploy.md).

*Watch out:* a host without KVM boots fine but every session wake fails; set
`SANDBOX_RUNTIME=disabled` explicitly on API-only hosts. Use a non-superuser,
non-`BYPASSRLS` database role or the row-level-security backstop silently does nothing
([`deploy.md` §2](deploy.md)).

### P2 — Open the platform to tenants (SaaS shape)

*Goal: self-service signup with per-tenant isolation and billing.*

1. Switch the object store to S3-compatible or GCS; set `RATE_LIMIT_STORE=postgres` so rate
   ceilings hold across replicas.
2. Set `ONBOARDING_ENABLED=true` (off by default — a self-hosted install should not
   silently accept strangers). Anonymous signup is rate-limited per IP
   (`RATE_LIMIT_ANON_RPM`).
3. Optionally wire metering: `BILLING_SINK=webhook` + `BILLING_WEBHOOK_URL/SECRET`
   sends HMAC-signed usage events to your billing processor.
4. If running >1 replica: give each instance a distinct `INSTANCE_ID` — two instances
   sharing one id will reclaim each other's live sessions on boot recovery.

*Behind the scenes:* signup creates a tenant + admin key and returns install
instructions the new tenant pastes into their Pi. Tenant quotas come from plan tiers;
every request is tenant-pinned at both the query layer and Postgres RLS.

### P3 — Scale sandbox capacity across hosts

*Goal: more KVM machines running microVMs, placement owned by the backend.*

1. On each new host: install the microsandbox runtime, deploy the **host agent** (the
   HTTPS listener wrapping that host's local sandbox provider).
2. Issue per-host bearer secrets (`SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>`) and mTLS
   material (`HOST_AGENT_TLS_CERT/KEY/CA`) — the control plane **refuses to boot**
   multi-host without both.
3. Set `SANDBOX_MODE=multi` + `SANDBOX_HOSTS`; restart. Hosts are upserted into the
   Postgres registry; placement is least-loaded with capacity fit; a liveness monitor
   probes each host and pulls failures from rotation.
4. Subscribe a webhook to `sandbox.host_unhealthy` for alerting.

*Watch out:* multi-host is incompatible with the session-worker pool (refused at boot,
deliberately) and per-VM metrics are not served for multi-host sessions. Design and
trust model: [`spec/multi-host-design.md`](spec/multi-host-design.md).

### P4 — Contain the blast radius of one bad session

*Goal: one tenant's harness crash must not take the API down.*

Set `SESSION_WORKER_MODE=pool` (+ optional `SESSION_WORKER_COUNT`,
`SESSION_WORKER_MAX_SESSIONS`). Harnesses move into bounded child processes sharded by
session id; a crash kills one worker's sessions, which transparently re-wake on the
respawned child and re-attach their *same* VMs. Trade-offs and honest limits (no RPC
timeout, no rebalancing): [`session-worker-pool.md`](session-worker-pool.md).

### P5 — See what the fleet is doing

1. Set `OTEL_EXPORTER_OTLP_ENDPOINT` — the single master switch; spans and metrics
   flow with no code change. Import the Grafana dashboards from `docs/dashboards/`.
2. Live per-VM numbers: `GET /v1/sessions/:id/metrics` (pull, side-effect-free). The
   per-VM OTEL gauges are named but **not yet emitted** — don't alert on them
   ([`observability.md` §3](observability.md)).
3. Watch `/readyz` per instance; watch work-queue depth via each self-hosted
   environment's `work-stats`.

### P6 — Routine operations

- **Upgrade:** build, restart. Migrations are forward-only and run on boot; there is
  no down path — roll forward. Detached VMs survive the restart; boot recovery
  re-attaches them by label and resets only *this instance's* stale sessions
  (lease-scoped).
- **Backup:** three things, together or the backup is useless — Postgres, the object
  store, and the **vault key**. The JSONL logs in the object store are the
  conversations; Postgres alone cannot reconstruct them.
- **Key rotation:** API keys are revocable per key (`DELETE /v1/api-keys/:id` — tenant
  admin surface); host-agent tokens rotate per host with an agent restart.
- **Capacity planning:** budget ≈ 76 MiB per idle woken session, 512 MiB worst case
  per guest; the control plane is not the constraint ([`capacity.md`](capacity.md)).

### P7 — Incident response

| Symptom | First look |
|---|---|
| `/readyz` 503 | The response names which check is down (`db`, `objectStore`, `sandbox`) |
| Host marked unhealthy | `sandbox.host_unhealthy` webhook fired; placements route around it; VMs on it re-provision on next wake |
| Work queue backing up | `GET /v1/environments/:id/work-stats` — `depth`, `oldestQueuedAt`, `workersPolling` tell you whether workers are dead or slow |
| One session misbehaving | `GET /v1/sessions/:id` + `/metrics`; interrupt via a `user.interrupt` event; pool mode bounds the damage |
| Suspected stuck cron | `job_runs` records every attempt including skips; the scheduler re-fires claimed-but-untriggered runs each tick |

---

## 3. Tenant admin journeys

### T1 — Onboard the tenant

**SaaS:** `POST /v1/onboarding/signup {tenantName, adminEmail}` → tenant + **admin API
key** (shown once) + install instructions. **Self-hosted:** the platform admin runs the
same call and hands over the key. Either way, verify with `GET /v1/tenant` — tenant
info plus live quota usage against limits.

### T2 — Issue keys with least privilege

1. Keep the admin key offline; issue purpose-bound keys: `read`+`write` for coders,
   `read` for dashboards/CI reporting.
2. New keys default to `["read"]` — scopes are opt-up, never opt-out.
3. Rotate by issuing a replacement and `DELETE`-ing the old one; the raw secret is
   only ever visible at creation.

*Watch out:* never put the org key on a worker host — that's what worker keys are for
(T5).

### T3 — Define the team's agents and environments

1. Create **agents** — named, versioned behavior definitions (model, system prompt,
   toolset config, skills, MCP servers, optional multi-agent roster). `PATCH` never
   mutates: it creates the next version, and running sessions keep the version they
   started with.
2. Create **environments** — execution shapes: a `cloud` environment picks an OCI
   image, resources, and a network policy (`unrestricted` still can't reach the host
   or cloud metadata; `limited` is default-deny plus named hosts); a `self_hosted`
   environment routes execution to your own infrastructure (T5).
3. Archive rather than delete when retiring agents: archival is terminal, and
   archiving an agent auto-archives the scheduled jobs that reference it.

### T4 — Register credentials (the step nothing works without)

1. Create a **vault**, then add credentials by category: `model_provider_key`
   (**required** — a session whose agent's model has no resolvable key fails closed
   before its first model call), `environment_variable`, `static_bearer` /
   `mcp_oauth`, git tokens.
2. Secret fields are write-only — they never appear in any response, ever.
3. `POST …/credentials/:key/validate` checks a credential live; a background loop
   re-resolves credentials into running sessions (~60 s), so rotation propagates
   without restarts.
4. Reference vaults by id at session/job creation (`vaultIds`).

*Behind the scenes:* credentials reach a sandbox only as `$MSB_…` placeholders
resolved host-side; MCP tokens are injected per-request by the backend proxy. Neither
the model nor the guest ever sees a value ([`architecture.md` §5.5](architecture.md)).

### T5 — Set up self-hosted execution

*Goal: sessions orchestrated by the backend, tools running on the tenant's own
machines.*

1. Create an environment with `type: "self_hosted"`.
2. Mint a **worker key**: `POST /v1/environments/:id/worker-keys` — scoped to exactly
   three routes, deny-by-default everywhere else. This is the only key that belongs on
   the worker host.
3. Run the shipped worker: `pi-managed-worker --backend-url … --env-id … --worker-key …`
   — outbound HTTPS polling only, it never listens. Choose a control level: `builtin`
   (tools run directly on the host — the host *is* the sandbox) or `spawn` (each work
   item piped to your own script, which owns isolation).
4. Monitor with `work-stats`; drain with `work-stop` (`{force}` to interrupt).

*Watch out:* memory stores and `environment_variable` credentials are rejected (422)
in self-hosted sessions — both require the backend-managed boundary.

### T6 — Wire notifications

`POST /v1/webhooks` with a URL + event types → a `whsec_` signing secret, shown once.
Deliveries are thin (`type` + `id` — fetch the object on receipt), HMAC-signed with a
5-minute freshness window, retried at-least-once, and the endpoint is auto-disabled
after persistent failure. `POST /v1/webhooks/:id/test` before trusting it.

### T7 — Watch usage and spend

- `GET /v1/tenant` — quota usage vs limits at a glance.
- Per session: `GET /v1/sessions/:id/usage` — cumulative tokens + USD.
- Set `budget: {maxTokens?, maxUsd?}` on sessions (or via job `sessionConfig`) for
  hard per-session caps — exhaustion stops the session with
  `stopReason: budget_exhausted`, it doesn't silently keep billing.
- The **web console** (`/console`, read-only, paste any key with `read`) gives the
  team a browsable view of sessions, event traces, and usage without granting anyone
  write access.

### T8 — Govern tool execution

- **Permission policies** per tool: `always_allow` (built-in default), `always_ask`
  (session pauses `requires_action` until a human answers — MCP default),
  `always_deny`.
- Network policy per environment (T3); memory stores can be mounted `read_only` for
  agents processing untrusted input.
- The event stream is the audit log: every tool call, confirmation, and result is a
  persisted, replayable event.

---

## 4. User journeys (the Pi coder)

The persona ([`spec/spec.md` §24.1](spec/spec.md)): a developer already coding in
local Pi who wants to delegate long work, run things on a schedule, resume anywhere,
and borrow bigger environments — without leaving their terminal. Journeys U2–U6
restate the spec's normative J1–J5.

### U1 — Install and connect

1. `pi install npm:@pi-managed/client`
2. First run triggers `/remote:config`: paste the backend URL + the API key your
   tenant admin issued (or `/remote:login` browser flow on SaaS). The key lands in
   Pi's `auth.json`; settings store only a reference to it. Optionally set
   `defaultAgent` / `defaultEnvironment` for one-command delegation.
3. The extension validates by fetching `GET /v1/tenant` and caches your quota summary.

### U2 — Delegate and continue (J1)

Mid-task, type `/remote:delegate "run the full E2E suite and report failures"`. A
live-view panel opens showing the remote agent working; **you keep coding** — your
local context stays clean because remote events render in the panel, never into your
local session's LLM context. The panel flips to "completed; 2 failures"; pull the
report into your cwd (`remote_read_outputs` → `./.pi-managed/outputs/` by default) and
let your local agent act on it. The remote session runs to completion even if you
close Pi.

### U3 — Start a fresh remote session (J2)

`/remote:start [agent] [env]` — an interactive remote session as your agent's home:
your local prompts forward as `user.message` events, the panel streams the work. Use
it when you want the backend's environment (packages, network, horsepower), not a
specific delegated task.

### U4 — Resume from another machine (J3)

On any machine with the extension configured: `/remote:sessions` → find the idle
session → `/remote:resume <id>` → continue where you left off. The backend cold-wakes
the whole stack from the durable log; the filesystem is preserved from the checkpoint.
One caveat to know: **processes are not preserved** — a dev server you left running is
gone, and the agent is told so in its resume context. `/remote:fork <id>` instead
branches the session — a new session sharing history up to the fork point.

### U5 — Run it on a schedule (J4)

`/remote:cron create` (or the API): a schedule (POSIX cron + IANA timezone) plus the
same recipe a session takes. The backend fires it whether or not your Pi is open —
each occurrence exactly once — and every attempt is inspectable via `/remote:jobs`. A
job whose agent got archived or vault disappeared **auto-pauses** with the reason
rather than failing silently forever. Delegation itself is a one-shot job under the
hood.

### U6 — Let the local agent delegate (J5)

Your local agent can call `remote_delegate` itself when it judges a subtask expensive,
then poll `remote_get_status` and fetch `remote_read_outputs` without you driving.
Gating is yours to set: `delegationPolicy: confirm` (default — you approve each
delegation) or `autonomous`, with client-side spend caps (`spendCapPerSession`,
`spendCapPerDay`) always applying. Server-side, per-session `budget` caps back this up
with a hard stop.

### U7 — Carry knowledge across sessions

`/remote:memory` manages **memory stores** — directories of text documents mounted
into every session that attaches them (`/mnt/memory/<slug>/`). The agent reads and
writes them with ordinary file tools; edits persist across sessions and every mutation
creates an immutable version you can inspect or restore from. Mount `read_only` when
the session handles untrusted input.

### U8 — Steer, answer, interrupt

While a remote session runs: follow-up messages queue as events; `user.interrupt`
stops the turn (state is never lost — the log is durable). When the agent hits an
`always_ask` tool or a custom tool, the session pauses (`requires_action`) and the
blocking request surfaces in the panel; your confirmation or tool result resumes it.
If SSE is blocked (corporate proxy), the extension degrades to polling — same events,
same positions, nothing missed.

---

## 5. Machine-actor journeys

For completeness — the non-human callers the system is designed around:

- **Self-hosted worker:** claim (`work-claim`, long-poll loop or webhook-woken) →
  execute locally → post (`work-result`). Its key opens exactly those routes. Skips
  items whose session requested a stop; treats backend errors as retryable, never
  fatal.
- **Sandbox host agent:** serves the provision/exec/lifecycle wire contract for its
  host, authenticating **every** request (bearer + mTLS, `/healthz` included) —
  anyone who could speak this protocol unauthenticated would own every tenant's
  sandbox on that host.
- **Webhook receiver:** verifies the HMAC signature and 5-minute freshness, then
  fetches the referenced object with its own credentials — the payload deliberately
  contains nothing worth stealing.
- **The scheduler (as an actor):** wakes every minute, claims due occurrences via a
  unique-constraint insert, creates sessions with the stored recipe, and records a run
  either way.

---

## 6. Journey → documentation map

| If you are… | Start with | Then |
|---|---|---|
| Platform admin | [`deploy.md`](deploy.md) | [`architecture.md`](architecture.md), [`observability.md`](observability.md), [`capacity.md`](capacity.md), [`session-worker-pool.md`](session-worker-pool.md), [`spec/multi-host-design.md`](spec/multi-host-design.md) |
| Tenant admin | [`api-reference.md`](api-reference.md) | [`architecture.md` §2](architecture.md) for the mental model, [`db-schema.md`](db-schema.md) §6 for retention |
| User (Pi coder) | The README quick start | [`spec/spec.md` §24](spec/spec.md) for the full extension surface |
| Plugin author | [`plugins.md`](plugins.md) | [`internal-contracts.md`](internal-contracts.md) |
