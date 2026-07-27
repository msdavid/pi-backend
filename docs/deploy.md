# Deployment — Pi Managed Backend (WP-1.13, §7)

The Pi Managed Backend is a **single Node.js process** that composes every
subsystem at boot (`createManagedApp` → `createApp`). It requires three external
dependencies — **Postgres**, an **object store**, and the **microsandbox
runtime** — plus a Linux host with **KVM** for microVM isolation.

## 1. Runtime requirements

| Requirement | Why | Notes |
|---|---|---|
| **Linux host with `/dev/kvm`** | microsandbox microVMs run via libkrunfw + KVM | The sandbox provider is inert without it. `@kvm`-gated tests skip cleanly when absent. |
| **Node.js ≥ 22.19** | ESM service, `dist/main.js` entrypoint | The floor is set by the embedded Pi agent's `undici` (`engines: >=22.19.0`), not by our own code. Build with `pnpm --filter @pi-managed/backend build`. |
| **Postgres 16** | Control-plane DB (sessions, agents, environments, vaults, usage, …) | Migrations run **forward-only on boot** (`runMigrations(dbUrl, "up")`). |
| **Object store** | File payloads, memory stores, snapshots, JSONL sync (§28) | **Local filesystem by default** (`OBJECT_STORE_ROOT` — point it at durable storage), or **Google Cloud Storage** via `OBJECT_STORE_KIND=gcs` + `GCS_BUCKET` (§2). An S3-compatible adapter also exists (`infra/objectstore/s3.ts`) but is composition-time only. |
| **microsandbox runtime** | Provisiones/execs detached microVMs (§5.4, §10) | One-time `microsandbox` install bootstrap (§3 below). |

## 2. Configuration

All config is via **environment variables** (precedence: env > config file > defaults;
see `infra/config/index.ts`). The composed app requires:

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `DB_URL` | **yes** | — | Postgres connection URL. The app refuses to boot without it. |
| `OBJECT_STORE_KIND` | no | `filesystem` | Which object-store impl to build. `filesystem` → a local directory at `OBJECT_STORE_ROOT`. `gcs` → Google Cloud Storage on `GCS_BUCKET`. S3 is **not** env-selectable (it needs endpoint/region/credential fields the schema does not carry) — inject it at composition time via `createApp({ objectStoreConfig: { kind: "s3", … } })`. |
| `OBJECT_STORE_ROOT` | no | `./data/objectstore` | Filesystem root for the local object store. Used when `OBJECT_STORE_KIND=filesystem`. Put it on **durable** storage — it holds the JSONL transcripts. |
| `GCS_BUCKET` | **yes*** | — | GCS bucket backing the object store. **Required when `OBJECT_STORE_KIND=gcs`** — boot fails closed without it rather than silently falling back to local disk. Credentials come from **Application Default Credentials** (the attached service account on GCE / Cloud Run / GKE, or `GOOGLE_APPLICATION_CREDENTIALS` locally); the backend holds no key material of its own. Enable **object versioning** on the bucket — the adapter probes for it and purges every generation on delete. |
| `SANDBOX_RUNTIME` | no | `disabled` | `enabled` to wire the `MicrosandboxProvider` (provisions real microVMs). `disabled` → the `sandbox` readiness check reports `down` and sessions cannot wake. |
| `PORT` | no | `3000` | HTTP bind port. |
| `LOG_LEVEL` | no | `info` | pino level. |
| `VAULT_KEY` / `VAULT_KEY_FILE` | **yes*** | — (boot refuses) | 32-byte key (hex/base64) for vault-secret encryption. **Required in any real deployment**: with no key set the process refuses to boot unless `ALLOW_EPHEMERAL_VAULT_KEY=true`. |
| `ALLOW_EPHEMERAL_VAULT_KEY` | no | `false` | Dev-only escape hatch: boot with a generated ephemeral vault key when none is set (stored secrets become unreadable after restart). **Never set in production.** |
| `PI_SESSION_LOCAL_DIR` | no | `./data/sessions` | Host-side root for per-session local JSONL files. Deliberately not `/tmp` — the cold-wake restore depends on it surviving reboot. |
| `SESSION_WORKER_MODE` | no | `inproc` | `pool` shards sessions across bounded child processes (R7.1; see `docs/session-worker-pool.md`). |
| `BILLING_SINK` | no | `none` | `webhook` enables HMAC-signed metering POSTs (`BILLING_WEBHOOK_URL` + `BILLING_WEBHOOK_SECRET`, §29.6). Payloads are **aggregated, time-bucketed** (console spec §11.4), never per-turn. |
| `BILLING_ENABLED` | no | `false` | Prepaid ledger enforcement (fail-soft suspension of new work at balance ≤ 0) + the trial email-verification grant (console spec §11.1). **The saas switch** — distinct from `CONSOLE_MODE` (presentation only). Solo/team leave it off and are never suspended/balance-gated. Also enables the usage→ledger debit drain that fires the balance-threshold events. |
| `BILLING_METERING_BUCKET_MS` | no | `60000` | Metering aggregation bucket width (ms). Usage is summed per tenant per bucket into one export event + one ledger debit (console spec §11.4). Shorter ⇒ tighter enforcement latency, more events. |
| `BILLING_LOW_BALANCE_THRESHOLD_MICROS` | no | `2000000` | Low-balance threshold in µUSD ($2). A usage debit crossing DOWN through it fires the `tenant.balance_low` webhook once (console spec §11.6). `0` disables the low event (`tenant.balance_exhausted` still fires at ≤ 0). |
| `BILLING_PROVISION_TOKEN` | no | — | Shared secret for the machine channel between backend and billing adapter — BOTH directions: the adapter → backend credit-surface (`POST /internal/billing/credit`) AND the backend → adapter link-out surface (`BILLING_ADAPTER_URL` below). Host-agent bearer pattern, constant-time. **Unset ⇒ fail-closed** (rejects every request; the link-out proxy `404`s). NOT a tenant API key — never a provider credential. |
| `BILLING_ADAPTER_URL` | no | — | Base URL of the billing-adapter's internal surface (a SEPARATE process, console spec §11.7–11.8). Set it (with `BILLING_PROVISION_TOKEN`) to enable the SDK-free tenant link-out proxy `/v1/tenant/billing/{checkout,portal,auto-charge}`. **Unset ⇒ those four routes `404` and the console renders the no-adapter state** (money controls absent, everything else works, §11.8). The backend HTTP-calls the adapter here — the Stripe SDK never enters `packages/backend`. |
| `RATE_LIMIT_RPM` / `RATE_LIMIT_ANON_RPM` | no | `600` / `30` | Per-tenant / unauthenticated-path request ceilings in requests/minute (§27.3). |
| `DB_POOL_MAX` | no | `25` | Max Postgres pool connections (PERF-1). `pg`'s own default is 10. |
| `DB_CONNECTION_TIMEOUT_MS` | no | `10000` | Max time to acquire a pooled connection before failing (PERF-1). `pg`'s default is `0` = wait forever. |
| `DB_STATEMENT_TIMEOUT_MS` | no | `30000` | Server-side `statement_timeout` on every connection (PERF-1). `0` disables it. |
| `ONBOARDING_ENABLED` | no | `false` | Public self-service sign-up (`POST /v1/onboarding/signup`). **Off by default** (self-hosted secure default, SEC-13); the SaaS shape sets `true`. |
| `CONSOLE_MODE` | no | derived | Console presentation mode (`solo`/`team`/`saas`) returned by `GET /console/config` (console spec §3.2). Unset ⇒ derived: `ONBOARDING_ENABLED=true` → `saas`, else `solo`. Presentation only — no `/v1` behavior differs by mode. |
| `CONSOLE_SESSION_TTL` | no | by mode | Console-session sliding TTL in **seconds** (console spec §4.6). Unset ⇒ the per-mode default: `solo` 30 d, `team` 7 d, `saas` 24 h. |
| `RATE_LIMIT_STORE` | no | `memory` | Rate-limit bucket store (ROB-8). `postgres` = a shared, cross-replica ceiling (requires `DB_URL`); `memory` = per-process. |
| `INSTANCE_ID` | no | random/boot | Stable id for this instance's boot-recovery ownership (ROB-13). Unset ⇒ a random per-boot id. **Give each instance a distinct id** — two instances sharing one reclaim each other's live sessions. |
| `INSTANCE_LEASE_MS` | no | `300000` | Ownership lease (ROB-13): a `running` session untouched longer than this is reclaimable by boot recovery. |
| `SANDBOX_ALLOW_INSECURE_HOST_AGENT` | no | `false` | Dev/test only (SEC-4): permit `SANDBOX_MODE=multi` over plain http without mTLS. **Never set in production** — the pool bearer secret would travel in cleartext. |

Multi-host (`SANDBOX_MODE=multi`) additionally requires the host-agent channel to be
**https + mutual TLS**: set `SANDBOX_HOST_AGENT_TOKEN` (pool bearer secret) and
`HOST_AGENT_TLS_CERT` / `HOST_AGENT_TLS_KEY` / `HOST_AGENT_TLS_CA`, or the boot fails closed
(SEC-4). Per-VM resource requests are capped (`resources.cpus` ≤ 64, `memoryMiB` ≤ 262144,
`diskMiB` ≤ 1048576; ROB-17), and the placement router subtracts each host's live placements
from its capacity so a host is never oversubscribed.

A JSON config file may supplement env via `CONFIG_FILE=/path/to/config.json`.

**Trial verification email — NOT an env var.** There is no `EMAIL_SENDER` variable for
an operator to set (nothing in the backend reads one). The email sender is a
composition-time injection: the default `NoopEmailSender` records-but-does-not-deliver
(the dev/test default), and a production saas deployment injects a real sender via
`createApp({ emailSender })` (SES / Postmark / SMTP). That real sender's OWN provider
env vars ship with the adapter that provides it — never with the backend. See
`docs/internal-contracts.md` §`EmailSender` for the seam contract.

### Billing adapter (saas — a SEPARATE process, console spec §11.7)

`packages/billing-adapter` (`@pi-managed/billing-adapter`, WP-C5.3) is the payment
engine (Stripe reference). **It is not part of the backend request path and the
Stripe SDK is never imported into `packages/backend`** — deploy it as its own
process: a webhook receiver (verifies Stripe webhooks → credits the ledger via the
machine credit-surface), a `tenant.balance_low` subscriber (the auto-charge engine),
AND an internal HTTP surface the backend's link-out proxy calls for checkout / portal /
auto-charge (`src/internal-api.ts`, machine bearer — the reverse of the credit-surface).
It talks to the backend through `POST /internal/billing/credit` (adapter → backend) and
serves the backend's `BILLING_ADAPTER_URL` calls (backend → adapter); it reaches Stripe
through the SDK. Its config is read from env at runtime and **fails closed** when a secret
is missing — no credential ships in the package, and no real Stripe key belongs in any env
checked into source.

| Var | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | **yes** | Stripe secret key (`sk_…`). Held only by this process; never logged. |
| `STRIPE_WEBHOOK_SECRET` | **yes** | Webhook signing secret (`whsec_…`). Inbound webhooks that fail verification are rejected. |
| `PI_BACKEND_URL` | **yes** | Backend base URL the machine credit-surface lives on. |
| `BILLING_PROVISION_TOKEN` | **yes** | The machine bearer secret — MUST match the backend's `BILLING_PROVISION_TOKEN`. NOT a tenant key. |
| `BILLING_CHECKOUT_SUCCESS_URL` | **yes** | Console return URL after a successful hosted checkout. |
| `BILLING_CHECKOUT_CANCEL_URL` | **yes** | Console return URL after a cancelled checkout. |
| `BILLING_PORTAL_RETURN_URL` | **yes** | Console return URL from the hosted customer/billing portal. |
| `AUTO_CHARGE_MAX_FAILURES` | no (`3`) | Consecutive off-session charge failures that auto-disable a tenant's auto-charge (then notify — no silent retries). |

The adapter issues hosted **checkout** and **portal** URLs on request (the backend's
`/v1/tenant/billing/{checkout,portal}` proxy forwards to its internal surface); the
console (WP-C5.4) links out to them and never sees a card (§11.9). The reference engine
issues a fixed-amount checkout, so a top-up carries an explicit amount. Ledger credit
from a payment is idempotent under Stripe's at-least-once re-delivery — the idempotency
key derives from the payment id, so a replay credits exactly once (§13). Auto-charge is
opt-in/off by default, with hard per-day and per-month rolling-window caps that are never
exceeded; a redelivered `tenant.balance_low` for one crossing charges the card at most
once (idempotency keyed on the crossing's ledger `entryId`), and concurrent crossings for
a tenant are serialized so the cap is never raced past.

### Database role — row-level security (SEC-10)

Tenant isolation has two layers: the always-on app-layer `tenantScoped*` guard, and a
Postgres **row-level-security** backstop (migration 040). The `tenantScoped*` helpers set
`app.current_tenant` via `SET LOCAL` inside a transaction, so every tenant-scoped query is
pinned to its tenant at the database even if a hand-written query were mis-scoped; the
audited cross-tenant system queries (boot recovery, key rotation, scheduler/webhook/work-queue
sweeps, onboarding sign-up) deliberately leave the GUC unset and the policy is permissive when
it is unset, so those paths are unaffected.

**For the RLS backstop to take effect, the application's `DB_URL` role MUST be a
non-superuser, non-`BYPASSRLS` role.** Postgres superusers and `BYPASSRLS` roles bypass RLS
entirely by design — the migration `FORCE`s RLS (so the table owner is also subject), but a
superuser connection would still bypass every policy. Migrations may run as the owner; the
running app should connect as a restricted role that owns nothing and has only DML grants.

## 3. One-time microsandbox install

The `microsandbox` npm SDK (pinned `0.6.6`) needs a one-time runtime bootstrap
that downloads the kernel/init images into `~/.microsandbox/`:

```bash
node -e "import('microsandbox').then(m => m.install())"
```

This populates `~/.microsandbox/` with the libkrunfw kernel + agentd. The
platform native package `@superradcompany/microsandbox-linux-x64-gnu` (an
`optionalDependency`) supplies the `msb` binary; ensure it installed on the
target host (`pnpm install` skips optional deps silently on mismatched
platforms — verify with `ls node_modules/@superradcompany/`).

## 4. KVM requirement

microsandbox microVMs require hardware virtualization:

- `/dev/kvm` must exist and be accessible to the backend process.
- On a VM host, nested virtualization must be enabled.
- The `@kvm`-tagged E2E + provider tests gate on
  `existsSync("/dev/kvm") && isInstalled()` (one definition:
  `src/infra/sandbox/__tests__/kvm-gate.ts`) and **skip — loudly — but only when
  `PI_REQUIRE_INTEGRATION` is unset**, so `pnpm test` stays green on a dev machine
  without KVM. In CI the variable is set and the same missing capability is a hard
  failure. See §9.

A host without KVM can still boot the backend (DB + object store + API), but
`SANDBOX_RUNTIME=enabled` will fail at the first session `wake()` (provision).
Set `SANDBOX_RUNTIME=disabled` on non-KVM hosts.

## 5. Boot

```bash
# 1. Start the stateful deps (dev). Postgres only — the object store defaults to the
#    local filesystem at OBJECT_STORE_ROOT. (compose also defines a `minio` service,
#    used by the S3 adapter's contract test, not by the running backend.)
docker compose up -d postgres

# 2. Build:
pnpm --filter @pi-managed/backend build

# 3. Boot (runs migrations up, then binds PORT). VAULT_KEY (or
#    ALLOW_EPHEMERAL_VAULT_KEY=true, dev only) is required — boot refuses
#    without one (§2):
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
VAULT_KEY=<32-byte-hex-or-base64-key> \
SANDBOX_RUNTIME=enabled \
PORT=3000 \
node --enable-source-maps packages/backend/dist/main.js
```

On boot the process:

1. loads + validates config (fatal exit on invalid),
2. creates the Postgres pool from `DB_URL`,
3. runs migrations **up** (forward-only, §3.2),
4. constructs the object store, the `MicrosandboxProvider`, and the
   `SessionManager` registry,
5. mounts every route via `createApp`, and
6. binds `0.0.0.0:PORT`.

## 6. Health & readiness

- `GET /healthz` — liveness; always `200 {status:"ok"}` when the process serves.
- `GET /readyz` — readiness; aggregates `db`, `objectStore`, `sandbox` probes.
  Reports `200 {status:"ready"}` only when all wired deps are `up`; `503`
  otherwise. Each check (`db=SELECT 1`, `objectStore=probe`,
  `sandbox=provider-wired`) is independently visible in the response.

## 7. Graceful shutdown

`SIGINT` / `SIGTERM` trigger: dispose every active `ManagedSessionRuntime`
(stop timers, dispose the bound `AgentSession`), close the Fastify server, then
drain + close the Postgres pool. The process exits `0` once clean, `1` on error.

## 8. Deployment shape (§7.1)

Single-tenant self-hosted (v1): one implicit tenant, one Node process, one
Postgres, one object store, one `~/.microsandbox/` home. The tenant context
still flows through every request, so promoting to multi-tenant SaaS is a
config change (per-tenant keys + S3/GCS object store), not a rewrite.

## 9. CI: fail-closed gates (R1.2)

`.github/workflows/ci.yml` has four jobs: `typecheck`, `lint`, `test`, and `kvm`.
The last two run **real** infrastructure and must never pass by skipping.

### `PI_REQUIRE_INTEGRATION`

The single fail-closed switch. Read by
`src/infra/db/__tests__/test-runtime.ts` (`hasContainerRuntime` /
`requireCapability`) and `src/infra/sandbox/__tests__/kvm-gate.ts`
(`kvmRuntimeAvailable`).

| Value | Meaning |
|---|---|
| unset / `0` / `false` | **Local dev.** Auto-detect docker/podman + `/dev/kvm`; missing capability ⇒ the dependent suites skip, after printing a loud `[integration-gate] SKIPPING …` banner on stderr. |
| `containers` | A container runtime (docker or podman socket) is **required**; its absence throws, naming the suite. |
| `kvm` | `/dev/kvm` **and** an installed microsandbox runtime are required. |
| `1` / `true` / `all` | Both of the above. |
| `containers,kvm` | Same as `1` (comma list of capabilities). |

The scoped values exist because the two capabilities live on different runners: the
GitHub-hosted `test` job has docker but no `/dev/kvm`, so it sets `containers`; the
self-hosted `kvm` job has both and sets `1`.

### `test` job (GitHub-hosted)

Runs `pnpm test` with `PI_REQUIRE_INTEGRATION=containers` and
`DOCKER_HOST=unix:///var/run/docker.sock`. The Postgres integration suites start their
own `postgres:16-alpine` through **testcontainers** — hence no `services:` sidecar; a
`docker info` step asserts the daemon before the suite runs. If docker ever disappears
from the image, the run goes red instead of quietly skipping every DB-backed suite.

### `kvm` job (self-hosted)

`runs-on: [self-hosted, linux, kvm]` with `PI_REQUIRE_INTEGRATION=1`. It runs the
`@kvm` suites — real `MicrosandboxProvider` + contract parity, the remote-operations
adapter, the composed-app E2E, and the GATE-1 host-escape / credential-injection /
load / restart gates.

Runner prerequisites (infra work, outside this repo):

1. **Labels** `self-hosted`, `linux`, `kvm`. The `kvm` label selects the runner. With no
   such runner registered, the job **queues** — the check never turns green, which is the
   intended fail-closed behavior (a placeholder that echoes and exits 0 is not).
2. **Hardware virtualization**: bare metal, or a VM with nested virtualization enabled.
   `/dev/kvm` must exist and be writable by the runner user (add it to the `kvm` group).
3. **Node ≥ 22.19 + pnpm** on `PATH`, and a **container runtime** (docker or podman) for the
   Postgres-backed halves of the E2E and credential-injection gates.
4. **microsandbox bootstrap**: `node -e "import('microsandbox').then(m => m.install())"`
   (§3) populating `~/.microsandbox/`. The workflow re-runs this per job (idempotent), so
   a fresh runner self-heals; it needs egress to the msb release CDN.
5. The optional native package `@superradcompany/microsandbox-linux-x64-gnu` must actually
   install (pnpm skips optional deps silently on a platform mismatch) — the workflow
   verifies with `ls node_modules/@superradcompany/`.

Run the same thing locally on a KVM host:

```bash
PI_REQUIRE_INTEGRATION=1 pnpm --filter @pi-managed/backend exec vitest run \
  src/infra/sandbox/__tests__ \
  src/domain/session-manager/operations/__tests__ \
  test/e2e.test.ts \
  test/phase1-gate
```
