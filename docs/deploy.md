# Deployment — Pi Managed Backend (WP-1.13, §7)

The Pi Managed Backend is a **single Node.js process** that composes every
subsystem at boot (`createManagedApp` → `createApp`). It requires three external
dependencies — **Postgres**, an **object store**, and the **microsandbox
runtime** — plus a Linux host with **KVM** for microVM isolation.

## 1. Runtime requirements

| Requirement | Why | Notes |
|---|---|---|
| **Linux host with `/dev/kvm`** | microsandbox microVMs run via libkrunfw + KVM | The sandbox provider is inert without it. `@kvm`-gated tests skip cleanly when absent. |
| **Node.js ≥ 20** | ESM service, `dist/main.js` entrypoint | Build with `pnpm --filter backend build`. |
| **Postgres 16** | Control-plane DB (sessions, agents, environments, vaults, usage, …) | Migrations run **forward-only on boot** (`runMigrations(dbUrl, "up")`). |
| **Object store** | File payloads, memory stores, snapshots, JSONL sync (§28) | v1 default: local filesystem. SaaS: any S3-compatible store (e.g. MinIO). |
| **microsandbox runtime** | Provisiones/execs detached microVMs (§5.4, §10) | One-time `microsandbox` install bootstrap (§3 below). |

## 2. Configuration

All config is via **environment variables** (precedence: env > config file > defaults;
see `infra/config/index.ts`). The composed app requires:

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `DB_URL` | **yes** | — | Postgres connection URL. The app refuses to boot without it. |
| `OBJECT_STORE_ROOT` | no | `./data/objectstore` | Filesystem root for the v1 object store. |
| `SANDBOX_RUNTIME` | no | `disabled` | `enabled` to wire the `MicrosandboxProvider` (provisions real microVMs). `disabled` → the `sandbox` readiness check reports `down` and sessions cannot wake. |
| `PORT` | no | `3000` | HTTP bind port. |
| `LOG_LEVEL` | no | `info` | pino level. |
| `VAULT_KEY` / `VAULT_KEY_FILE` | **yes*** | — (boot refuses) | 32-byte key (hex/base64) for vault-secret encryption. **Required in any real deployment**: with no key set the process refuses to boot unless `ALLOW_EPHEMERAL_VAULT_KEY=true`. |
| `ALLOW_EPHEMERAL_VAULT_KEY` | no | `false` | Dev-only escape hatch: boot with a generated ephemeral vault key when none is set (stored secrets become unreadable after restart). **Never set in production.** |
| `PI_SESSION_LOCAL_DIR` | no | `./data/sessions` | Host-side root for per-session local JSONL files. Deliberately not `/tmp` — the cold-wake restore depends on it surviving reboot. |
| `SESSION_WORKER_MODE` | no | `inproc` | `pool` shards sessions across bounded child processes (R7.1; see `docs/session-worker-pool.md`). |
| `BILLING_SINK` | no | `none` | `webhook` enables HMAC-signed metering POSTs (`BILLING_WEBHOOK_URL` + `BILLING_WEBHOOK_SECRET`, §29.6). |
| `RATE_LIMIT_RPM` / `RATE_LIMIT_ANON_RPM` | no | `600` / `30` | Per-tenant / unauthenticated-path request ceilings in requests/minute (§27.3). |
| `DB_POOL_MAX` | no | `25` | Max Postgres pool connections (PERF-1). `pg`'s own default is 10. |
| `DB_CONNECTION_TIMEOUT_MS` | no | `10000` | Max time to acquire a pooled connection before failing (PERF-1). `pg`'s default is `0` = wait forever. |
| `DB_STATEMENT_TIMEOUT_MS` | no | `30000` | Server-side `statement_timeout` on every connection (PERF-1). `0` disables it. |
| `ONBOARDING_ENABLED` | no | `false` | Public self-service sign-up (`POST /v1/onboarding/signup`). **Off by default** (self-hosted secure default, SEC-13); the SaaS shape sets `true`. |
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
# 1. Start the stateful deps (dev):
docker compose up -d postgres minio

# 2. Build:
pnpm --filter backend build

# 3. Boot (runs migrations up, then binds PORT):
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
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
config change (per-tenant keys + S3 object store), not a rewrite.

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
3. **Node ≥ 20 + pnpm** on `PATH`, and a **container runtime** (docker or podman) for the
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
