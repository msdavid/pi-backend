# Getting Started — Pi Managed Backend

The fastest path from a fresh clone to a **running backend you can talk to**, on your
local machine. This is the *dev / local* walkthrough — it favours the shortest happy
path over production hardening. When you are ready to deploy for real, follow
[`deploy.md`](deploy.md) (full deploy guide) and [`operations.md`](operations.md)
(run it in production).

> **macOS note.** Everything here works on macOS **except real sandbox execution** —
> microVMs need a Linux host with `/dev/kvm`. On macOS, run with
> `SANDBOX_RUNTIME=disabled` (step 5): the API, DB, object store, and web console all
> work; only *waking a session into a live VM* does not.

---

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| **Node.js ≥ 20** | The service is an ESM Node process | `node --version` |
| **pnpm** | Workspace package manager (pinned via `packageManager`) | `corepack enable` then `pnpm --version` |
| **Docker** | Runs the dev Postgres | `docker info` |
| **Linux + `/dev/kvm`** | *Only* for real microVM sandboxes — optional to start | `ls -l /dev/kvm` |

---

## 1. Install

```bash
git clone <repo> pi-backend && cd pi-backend
pnpm install
```

`pnpm install` builds the whole workspace's dependency tree, including the web console.

## 2. Start Postgres

```bash
docker compose up -d postgres
```

That is the only stateful dependency you need to start. **The object store defaults to
your local filesystem** — `OBJECT_STORE_ROOT` (default `./data/objectstore`), created on
demand — so there is nothing else to run. Point `DB_URL` at your own Postgres later if
you prefer (step 5).

> The compose file also defines a **MinIO** service. You do *not* need it to run the
> backend — it exists only to give the object-store adapter contract tests a live
> endpoint. Start it with `docker compose up -d minio` when running those tests.

**Going beyond local storage — Google Cloud Storage.** When you outgrow a local
directory, the backend ships a **GCS** object store
(`packages/backend/src/infra/objectstore/gcs.ts`, on `@google-cloud/storage`). It takes a
`bucket` plus either **Application Default Credentials** (nothing to configure on GCE /
Cloud Run / GKE with a service account attached — the usual GCP path), a `keyFilename`,
or inline service-account credentials, and it probes the bucket for **object versioning**
at construction so deletes purge every generation. `ensureGCSBucket()` creates the bucket
if it does not exist.

Switching to it is two env vars — no code change:

```bash
OBJECT_STORE_KIND=gcs
GCS_BUCKET=my-pi-objects
```

Setting `OBJECT_STORE_KIND=gcs` without `GCS_BUCKET` **refuses to boot** rather than
quietly falling back to local disk. Local filesystem remains the default for this
walkthrough. See [`operations.md` §3](operations.md) for the durability implications and
[`deploy.md` §2](deploy.md) for the full variable reference.

## 3. (Optional) One-time microsandbox bootstrap

Skip this if you only want the API and are running with `SANDBOX_RUNTIME=disabled`.

For **real microVM sandboxes** (Linux + `/dev/kvm` only):

```bash
node -e "import('microsandbox').then(m => m.install())"
```

This downloads the libkrunfw kernel + agentd into `~/.microsandbox/`. See
[`deploy.md` §3–§4](deploy.md) for the KVM requirement and how to verify the native
`msb` binary actually installed.

## 4. Build

```bash
pnpm build
```

Builds every package (`pnpm -r build`), including the backend's `dist/main.js`
entrypoint and the web console's static assets served at `/console`.

## 5. Generate a vault key and boot

The backend **refuses to boot without a vault key** — the 32-byte key that encrypts
tenant secrets at rest. Generate a throwaway one for local dev:

```bash
export VAULT_KEY=$(openssl rand -hex 32)
```

Then boot. Pick the line that matches your machine:

```bash
# Linux with /dev/kvm — real sandboxes:
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
VAULT_KEY=$VAULT_KEY \
SANDBOX_RUNTIME=enabled \
PORT=3000 \
node --enable-source-maps packages/backend/dist/main.js

# macOS or a host without /dev/kvm — API only, no session wake:
DB_URL=postgres://pi:pi@localhost:5432/pi \
OBJECT_STORE_ROOT=./data/objectstore \
VAULT_KEY=$VAULT_KEY \
SANDBOX_RUNTIME=disabled \
PORT=3000 \
node --enable-source-maps packages/backend/dist/main.js
```

On boot the process runs migrations forward-only, wires every subsystem, and binds
`0.0.0.0:3000`.

> **Shortcut (dev only):** instead of generating a key you can set
> `ALLOW_EPHEMERAL_VAULT_KEY=true` and omit `VAULT_KEY`. The process boots with a
> throwaway key — but every stored secret becomes **undecryptable after a restart**, so
> never use this beyond local experimentation. See [`deploy.md` §2](deploy.md).

## 6. Verify it's up

```bash
# Liveness — always 200 while the process serves:
curl http://localhost:3000/healthz

# Readiness — 200 only when db + objectStore + sandbox are all up (the body names
# any check that is down, so a 503 tells you which dependency to look at):
curl http://localhost:3000/readyz
```

With `SANDBOX_RUNTIME=disabled`, `/readyz` reports the `sandbox` check as `down` (by
design) and returns `503` — that is expected on a no-KVM host, and the API still works.

## 7. Create your first tenant + API key

```bash
curl -X POST http://localhost:3000/v1/onboarding/signup \
  -H 'content-type: application/json' \
  -d '{"tenantName":"my-org","adminEmail":"me@example.com"}'
```

> `/v1/onboarding/signup` is only reachable when `ONBOARDING_ENABLED=true`. It is **off
> by default** (self-hosted secure default). Add `ONBOARDING_ENABLED=true` to the boot
> command in step 5 to use it, or create the tenant + key through your own admin path.

The response includes an admin **API key, shown exactly once** — save it. Use it as
`Authorization: Bearer <key>` for every authenticated `/v1/*` call. The full worked
example (create an agent → environment → session → send a message → stream events) is in
the README's [Quick start §7](../README.md#7-create-your-first-tenant--api-key).

## 8. Open the web console

The backend serves a read-only web console same-origin at `/console`:

```
http://localhost:3000/console
```

Paste your API key when prompted — it is exchanged for a server-side session cookie and
the browser never holds the key again. See [`console.md`](console.md).

## 9. (Optional) Wire up local Pi

Install the client extension so a local Pi user can delegate to your backend:

```bash
pi install npm:@pi-managed/client
```

Then in Pi:

```
/remote:config     # point at http://localhost:3000 + paste the API key
/remote:delegate "run the test suite and report failures"
```

---

## Where to next

| You want to… | Read |
|---|---|
| Understand the system | [`architecture.md`](architecture.md) |
| Deploy for real | [`deploy.md`](deploy.md) |
| Operate in production (backup, restore, upgrade, incidents) | [`operations.md`](operations.md) |
| Call the API | [`api-reference.md`](api-reference.md) |
| Turn on metrics + traces | [`observability.md`](observability.md) |
