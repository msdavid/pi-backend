# Pi Managed Backend

A self-deployable service that gives the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) managed-agent capabilities: remote agent sessions, scheduled jobs (crons), durable state, sandboxed execution via [microsandbox](https://github.com/superradcompany/microsandbox) microVMs, and a Pi client extension that makes it all feel native to a local Pi user.

The service is **tailored for Pi** — it adapts the *concepts* of managed agents (agents, sessions, environments, events, tools, memory, multi-agent orchestration, outcomes, scheduled deployments) to Pi-native idioms rather than mirroring any other API.

- **API reference:** [`docs/api-reference.md`](docs/api-reference.md) (wire contract)
- **Deployment:** [`docs/deploy.md`](docs/deploy.md) (full deploy guide)

---

## Quick start (dev)

### Prerequisites

- **Node.js ≥ 20**
- **pnpm** (`corepack enable` — the version is pinned via `packageManager` in `package.json`)
- **Docker** (for the dev Postgres + MinIO)
- **Linux with `/dev/kvm`** (for real microVM sandboxes — macOS works for everything *except* sandbox execution)

### 1. Install

```bash
git clone <repo> pi-backend && cd pi-backend
pnpm install
```

### 2. Start the stateful dependencies

```bash
docker compose up -d postgres minio
```

### 3. One-time microsandbox bootstrap (for real sandboxes)

```bash
node -e "import('microsandbox').then(m => m.install())"
```

This populates `~/.microsandbox/` with the libkrunfw kernel + agentd. Skip if you only need the API without sandbox execution (`SANDBOX_RUNTIME=disabled`).

### 4. Build

```bash
pnpm build
```

### 5. Boot the backend

```bash
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
SANDBOX_RUNTIME=enabled \
PORT=3000 \
node --enable-source-maps packages/backend/dist/main.js
```

On boot the backend runs migrations (forward-only), wires all subsystems, and binds `0.0.0.0:3000`.

### 6. Verify

```bash
# Liveness (always 200 if the process is up)
curl http://localhost:3000/healthz

# Readiness (200 when db + objectStore + sandbox are all up)
curl http://localhost:3000/readyz
```

### 7. Create your first tenant + API key

```bash
# Onboarding (creates a tenant + admin API key, returns install instructions)
curl -X POST http://localhost:3000/v1/onboarding/signup \
  -H 'content-type: application/json' \
  -d '{"tenantName":"my-org","adminEmail":"me@example.com"}'
```

Use the returned `apiKey` for all authenticated calls:

```bash
# Create an agent
curl -X POST http://localhost:3000/v1/agents \
  -H 'authorization: Bearer pmb_live_...' \
  -H 'idempotency-key: agent-1' \
  -H 'content-type: application/json' \
  -d '{"name":"coder","model":{"provider":"openai","id":"gpt-4o"}}'

# Create an environment
curl -X POST http://localhost:3000/v1/environments \
  -H 'authorization: Bearer pmb_live_...' \
  -H 'idempotency-key: env-1' \
  -H 'content-type: application/json' \
  -d '{"name":"python","type":"cloud","image":"ubuntu:22.04","resources":{"cpus":2,"memoryMiB":2048},"networking":{"mode":"unrestricted"}}'

# Create a session
curl -X POST http://localhost:3000/v1/sessions \
  -H 'authorization: Bearer pmb_live_...' \
  -H 'idempotency-key: sess-1' \
  -H 'content-type: application/json' \
  -d '{"agent":"agent_...","environmentId":"env_..."}'

# Send a message
curl -X POST http://localhost:3000/v1/sessions/sess_.../events \
  -H 'authorization: Bearer pmb_live_...' \
  -H 'idempotency-key: msg-1' \
  -H 'content-type: application/json' \
  -d '{"type":"user.message","content":"write hello world to /mnt/session/outputs/hello.txt"}'

# Stream events (SSE)
curl -N http://localhost:3000/v1/sessions/sess_.../stream \
  -H 'authorization: Bearer pmb_live_...'
```

### 8. Install the client extension in local Pi

```bash
pi install npm:@pi-managed/client
# or add to .pi/settings.json extensions array
```

Then in Pi:
```
/remote:config    # point at your backend + paste the API key
/remote:delegate "run the test suite and report failures"
```

---

## Repository layout

```
packages/
  backend            # the service (Fastify + Postgres + microsandbox)
  client-extension   # @pi-managed/client — the Pi extension (§24)
  contracts          # zod schemas + TS types mirroring api-reference.md
  testkit            # shared test fixtures (fakes, conformance kits)
  worker             # default self-hosted worker (§10.4)
  web-console        # read-only web UI (§26.6)
docs/
  api-reference.md   # the wire contract
  db-schema.md       # Postgres schema (generated — see `pnpm db:schema:gen`)
  deploy.md          # deployment guide
  session-worker-pool.md  # harness-isolation pool (`SESSION_WORKER_MODE=pool`)
  ...
```

## Development

```bash
pnpm install        # install deps
pnpm build          # build all packages
pnpm test           # run all tests
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit
```

Tests use [vitest](https://vitest.dev); integration tests use [testcontainers](https://node.testcontainers.org) (real Postgres, auto-detecting docker or a rootless podman socket). `@kvm`-tagged tests need `/dev/kvm` + an installed microsandbox runtime. Locally, a missing capability skips cleanly with a loud stderr banner; in CI, `PI_REQUIRE_INTEGRATION` makes the same gap a **hard failure** instead — see `docs/deploy.md` §9.

## Configuration

All config is via **environment variables** (env > config file > defaults). Boot is
**fail-closed**: an invalid or missing required value (e.g. no vault key) prints an error
and exits 1 rather than starting in a half-configured state. Key vars:

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `DB_URL` | **yes** | — | Postgres connection URL |
| `OBJECT_STORE_ROOT` | no | `./data/objectstore` | Filesystem root (v1 object store) |
| `PI_SESSION_LOCAL_DIR` | no | `./data/sessions` | Durable host-side root for per-session JSONL logs. Deliberately not `/tmp` — this is the file the object-store sync and cold-wake restore depend on surviving a host reboot |
| `SANDBOX_RUNTIME` | no | `disabled` | `enabled` to wire real microVMs |
| `SANDBOX_MODE` | no | `single` | `single` → one host-local `MicrosandboxProvider`; `multi` → routes across a `SANDBOX_HOSTS` pool via `MultiHostSandboxProvider`. Only meaningful with `SANDBOX_RUNTIME=enabled` |
| `SESSION_WORKER_MODE` | no | `inproc` | `inproc` → every session harness runs in the control-plane process (default). `pool` → harnesses run in bounded child processes sharded by session id, bounding the blast radius of one session's crash/leak. See [`docs/session-worker-pool.md`](docs/session-worker-pool.md) |
| `RATE_LIMIT_RPM` / `RATE_LIMIT_ANON_RPM` | no | `600` / `30` | Per-tenant and per-IP (unauthenticated paths, e.g. signup) request-per-minute ceilings |
| `RATE_LIMIT_STORE` | no | `memory` | `memory` (per-process — N replicas allow N× the ceiling) or `postgres` (shared, global ceiling) |
| `PORT` | no | `3000` | HTTP bind port |
| `VAULT_KEY` / `VAULT_KEY_FILE` | **yes** | — | 32-byte key (hex/base64) or key-file path for vault-secret encryption. Boot **refuses to start** without one (no `NODE_ENV=test` implicit opt-in — the explicit `ALLOW_EPHEMERAL_VAULT_KEY` flag is the only escape hatch). Deprecated aliases: `MSB_SECRET_ENCRYPTION_KEY` / `MSB_SECRET_ENCRYPTION_KEY_FILE` |
| `ALLOW_EPHEMERAL_VAULT_KEY` | no | `false` | Dev-only escape hatch: boot with a throwaway key when no `VAULT_KEY` is set. **Never set in production** — stored secrets become undecryptable after a restart |
| `PI_REQUIRE_INTEGRATION` | no | unset | Test-time only (not a server boot var). `containers` / `kvm` / `1` makes a missing container runtime or `/dev/kvm` a **hard test failure** instead of a silent skip — see `docs/deploy.md` §9 |

See [`docs/deploy.md`](docs/deploy.md) for the full list + deployment shapes.

### Model-provider keys

Per-agent model-provider API keys are **not** environment
variables and are never read from the backend process's own env for a tenant session.
Each key is stored as a `model_provider_key`-category credential in a tenant's vault
(AES-256-GCM at rest, decrypted host-side only), keyed by Pi provider id (`openai`,
etc.), and resolved fresh at every session wake. A session whose model has no resolved
key **fails closed** — session construction throws before any model call, so it can never
silently fall through to a provider API key in the host's environment and bill the host.

### API-key scopes

API keys carry a `scopes` array enforced on every route: `admin` (wildcard — satisfies
everything), `read` / `write` (checked per-method — `GET`/`HEAD` need `read`, everything
else needs `write`), and `self_hosted_worker:<envId>` (satisfies nothing but its own 3
work-queue routes — a worker key is deny-by-default everywhere else). New keys default to
least-privilege, not `admin`.

## Documentation

- [**Deploy guide**](docs/deploy.md) — prerequisites, config, boot, health, graceful shutdown, deployment shapes
- [**API reference**](docs/api-reference.md) — every endpoint, request/response schema, error taxonomy, event catalog, SSE wire format
- [**DB schema**](docs/db-schema.md) — every Postgres table, indexes, constraints, encrypted-column strategy
- [**Internal contracts**](docs/internal-contracts.md) — the port interfaces (SandboxProvider, SessionRuntime, SecretStore, …)
- [**Plugin authoring**](docs/plugins.md) — how to write custom sandbox/secret/scheduler providers
- [**Observability**](docs/observability.md) — OTEL span/metric conventions, msb-metrics pipeline, Grafana dashboards
- [**Session-worker pool**](docs/session-worker-pool.md) — `SESSION_WORKER_MODE=pool` harness isolation

## License

(See LICENSE — TBD)
