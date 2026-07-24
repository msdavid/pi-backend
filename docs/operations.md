# Operations — running the Pi Managed Backend in production

The operate-side companion to [`deploy.md`](deploy.md). `deploy.md` gets you *booted*
(requirements, env-var reference, boot sequence); this document is the **runbook** for
keeping it running: upgrades, backup and restore, key rotation, fronting, and incident
response. It consolidates operational guidance that was previously scattered across
[`user-journeys.md`](user-journeys.md) (the "Platform admin" journeys P1–P7),
[`observability.md`](observability.md), [`capacity.md`](capacity.md), and
[`session-worker-pool.md`](session-worker-pool.md), and links back to those for depth.

> **Audience:** the platform admin — whoever owns the process, the host, the database,
> and the env config. There is **no `/v1` platform-admin API**; operating power comes
> from owning the process, not from an endpoint.

---

## 1. What you are operating

A **single Node process** (`packages/backend/dist/main.js`) that composes every
subsystem at boot, plus its stateful dependencies:

- **Postgres** — the control plane (sessions, agents, environments, vaults, usage, …).
- **Object store** — the **local filesystem by default**, rooted at `OBJECT_STORE_ROOT`
  (`./data/objectstore`), or **Google Cloud Storage** with `OBJECT_STORE_KIND=gcs` +
  `GCS_BUCKET`. Holds file payloads, memory stores, snapshots, and the **JSONL
  conversation logs** (§28). On the default, **the object store is a directory on your
  host and must be on durable, backed-up storage** (§3). An S3-compatible adapter exists
  but is composition-time only.
- **Vault key** — the 32-byte key that decrypts every stored secret. Not a service, but
  operationally it is a *third piece of durable state*: without it the database is
  unreadable.
- **microsandbox runtime** (`SANDBOX_RUNTIME=enabled`) — provisions detached microVMs on
  a Linux/KVM host. In-flight sandbox filesystems are **expendable by design** (§5.3) —
  they are not part of backup/restore.
- **Billing adapter** (saas only) — a *separate* process; operate it per
  [`deploy.md` §"Billing adapter"](deploy.md).

See [`architecture.md`](architecture.md) for the full picture.

---

## 2. Upgrade / restart

The routine upgrade is **build, restart** — there is no separate migration step to run.

1. `git pull` (or deploy the new artifact) and `pnpm build`.
2. Restart the process. On boot it runs migrations **up** automatically, forward-only,
   before binding the port.
3. Watch `/readyz` come back green (§7).

**Migrations are forward-only — there is no down path in production.** Every migration is
a single numbered `.sql` file in `packages/backend/migrations/`; the `-- Down Migration`
half exists only for the local up/down round-trip test, not for production rollback
([`db-schema.md` §7](db-schema.md)). To undo a bad migration you **roll forward** with a
new migration, or restore from backup (§4). Migrations should run as the table **owner**;
the running app should connect as a **restricted, non-superuser, non-`BYPASSRLS` role** so
the row-level-security backstop takes effect ([`deploy.md` §"Database role"](deploy.md)).

**Detached VMs survive a restart.** microVMs run detached from the control-plane process.
On boot, **boot recovery** re-attaches them by label and resets only *this instance's*
stale `running` sessions — scoped by the ownership lease (`INSTANCE_ID` /
`INSTANCE_LEASE_MS`, [`deploy.md` §2](deploy.md)). Give **each instance a distinct
`INSTANCE_ID`**: two instances sharing one id will reclaim each other's live sessions.

**Graceful shutdown.** `SIGINT` / `SIGTERM` disposes every active session runtime, closes
the HTTP server, then drains and closes the Postgres pool; the process exits `0` when
clean. If OTEL is enabled, buffered spans/metrics are flushed on the way out
([`observability.md` §4](observability.md)). Send `SIGTERM` and let it drain rather than
`SIGKILL`.

**Rolling upgrades.** Nothing in the process coordinates a rolling restart across
replicas — sequence it yourself, and remember `RATE_LIMIT_STORE=memory` gives each
replica its *own* ceiling (use `postgres` for a shared, cross-replica ceiling).

---

## 3. Backup

**Back up three things, together, or the backup is useless:**

| Artifact | What it holds | If you lose it |
|---|---|---|
| **Postgres** | All control-plane state — sessions, agents, environments, usage, encrypted vault rows | No tenants, no session index — nothing works |
| **Object store** | File payloads, memory, snapshots, and the **JSONL conversation logs** | Postgres alone **cannot reconstruct a conversation** — the JSONL *is* the transcript |
| **Vault key** (`VAULT_KEY` / `VAULT_KEY_FILE`) | The AES-256-GCM key for every stored secret | Every stored credential is **permanently undecryptable** — a full DB restore is still unreadable |

The JSONL durability contract (§28): active sessions append to local disk
(`PI_SESSION_LOCAL_DIR` — deliberately **not** `/tmp`, it must survive a reboot), and the
backend syncs each file to the object store on every idle transition and periodically
while running. A host loss therefore loses at most the tail of one in-flight turn (which
is re-runnable), never an idle session — *provided the object store is durable.*
Self-hosted deployments using a plain filesystem as the "object store" must point
`OBJECT_STORE_ROOT` at durable storage.

> **On the default, the object store is a local directory, so *you* own its durability.**
> `OBJECT_STORE_KIND` defaults to `filesystem`, and nothing is replicating or versioning
> that directory for you: put `OBJECT_STORE_ROOT` on durable, snapshotted, backed-up
> storage — never on ephemeral or container-local disk. Switching to
> `OBJECT_STORE_KIND=gcs` + `GCS_BUCKET` hands durability to GCS instead (enable object
> versioning on the bucket). The S3 adapter remains composition-time only.

**Recommended mechanism** (self-hosted guidance, SaaS requirement — spec §28):

- **Postgres:** point-in-time recovery via WAL archiving (PITR). On GCP, Cloud SQL for
  Postgres gives you PITR and automated backups without operating WAL archiving yourself.
- **Object store (default, filesystem):** disk snapshots plus an offsite copy of
  `OBJECT_STORE_ROOT`.
- **Object store (GCS):** enable **object versioning** on the bucket — the adapter probes
  for it and purges every generation on delete, so versioning is what makes an accidental
  delete recoverable. Pair it with a lifecycle rule and, if you need region durability, a
  dual/multi-region bucket.
- **Vault key:** a secrets manager / KMS — on GCP, Secret Manager or a KMS-wrapped key —
  **backed up separately from the database**, in a different failure domain. Never keep
  the only copy of the key next to the only copy of the DB: a single compromise then
  yields both ciphertext and key.

---

## 4. Restore / disaster recovery

There is no one-button restore — reassemble the three artifacts **in order**. In-flight
sandbox filesystems are expendable (§5.3) and are *not* restored; affected sessions
cold-wake fresh VMs on next use.

1. **Provision the host** and deploy the **same backend version** the backup was taken
   under (forward-only migrations mean a newer binary is fine; an *older* one may not
   understand newer rows — match or go forward, never back).
2. **Restore the vault key first.** Put `VAULT_KEY` / `VAULT_KEY_FILE` in place before
   boot. Without it the process still boots, but every secret read fails closed and no
   session whose model needs a provider key can wake.
3. **Restore Postgres** (PITR to the target timestamp) and **the object store**
   (to the *same* point). Skewing these two is the main DR footgun: a Postgres row
   referencing a JSONL/object that the object-store restore predates leaves that session
   with a dangling reference. Restore both to the same moment.
4. **Point the backend at the restored dependencies** (`DB_URL`, `OBJECT_STORE_ROOT` /
   object-store creds) and boot. Migrations run up (no-op if already current). **Boot
   recovery** reconciles session ownership; it will not find the old detached VMs (they
   are gone), so their sessions become cold and re-provision on next wake.
5. **Verify:** `/readyz` green (§7); spot-check a tenant via `GET /v1/tenant` (tenant
   info + live quota); open a known session and confirm its transcript replays from the
   restored JSONL; if a secret was set, confirm a session that needs it wakes (proves the
   vault key matches the restored rows).

> **Test your restore before you need it.** A backup you have never restored is a
> hypothesis. Rehearse steps 2–5 into a scratch environment at least once.

---

## 5. Key & secret rotation

### API keys (tenant admin surface)

Revocable per key: `DELETE /v1/api-keys/:id`. New keys default to **least privilege**
(`read`/`write`, not `admin`) — see the README's "API-key scopes". Rotate by issuing a
new key, cutting clients over, then deleting the old one.

### Host-agent tokens (multi-host, `SANDBOX_MODE=multi`)

The pool bearer secret (`SANDBOX_HOST_AGENT_TOKEN`) and its mTLS material
(`HOST_AGENT_TLS_*`) are config. Rotate a host's token by updating the secret on both the
control plane and that host agent, then restarting the agent — per host, so the fleet
stays up. The channel **must** be https + mutual TLS in `multi` mode or boot fails closed
([`deploy.md` §2](deploy.md)); never set `SANDBOX_ALLOW_INSECURE_HOST_AGENT` in
production.

### Vault key (`VAULT_KEY`) — the master encryption key

Rotating the vault key means **re-encrypting every stored secret** from the old key to a
new one. The primitive exists — `rotateVaultKey(pool, oldKey, newKey, newKeyId)` in
`packages/backend/src/domain/vault/crypto.ts` re-encrypts every `vault_credentials` row in
a single transaction under `FOR UPDATE` locks, spanning all tenants — **but there is no
operator entrypoint for it today.** No CLI, script, or endpoint invokes it; only the unit
test does.

Consequences for the operator:

- **You cannot rotate the vault key with a shipped command.** Doing it today requires a
  small one-off Node script that imports `rotateVaultKey`, loads the old and new keys, and
  runs it against the production pool while the backend is quiesced (so no concurrent
  secret write races the rotation). Treat this as a bespoke, carefully-reviewed operation,
  not routine hygiene. *(A packaged rotation command is a known gap — file it before
  relying on scheduled key rotation.)*
- **Losing the key is not recoverable** — see §3/§4. Rotation is *not* a substitute for
  backing the key up; you can only rotate a key you still have.

Credentials that were encrypted under a superseded key and not re-encrypted decode as
undecryptable and are skipped by the model-key fail-closed guard rather than crashing a
session.

---

## 6. Fronting the service (TLS / reverse proxy)

**The backend binds plain HTTP on `0.0.0.0:PORT`.** It does **not** terminate TLS for its
public API — the only mutual-TLS in the system is the *internal* control-plane→host-agent
channel (`SANDBOX_MODE=multi`), which is unrelated to client traffic. For any real
deployment, put a **reverse proxy / load balancer in front** (nginx, Caddy, Envoy, or a
cloud LB) to:

- **Terminate TLS** and forward to the backend's `PORT`.
- **Health-check** against `GET /healthz` (liveness) and gate traffic on `GET /readyz`
  (readiness) so a not-ready instance is pulled from rotation.
- Optionally set request-size and connection limits at the edge; the app already enforces
  per-tenant / per-IP rate ceilings (`RATE_LIMIT_RPM` / `RATE_LIMIT_ANON_RPM`), and
  `RATE_LIMIT_STORE=postgres` makes that ceiling shared across replicas.

Bind the backend to loopback or a private interface and let only the proxy reach it.

---

## 7. Observability & health

- **Health endpoints:** `GET /healthz` (liveness, always `200` while serving) and
  `GET /readyz` (readiness — aggregates `db`, `objectStore`, `sandbox`; the body names
  each check so a `503` tells you *which* dependency is down).
- **Telemetry is off until you set an endpoint.** `OTEL_EXPORTER_OTLP_ENDPOINT` is the
  master switch — set it and spans + metrics flow with no code change. Import the Grafana
  dashboards from `docs/dashboards/`. Full conventions, the wired instrumentation points,
  and the honest gaps (the per-VM `pi.sandbox.*` gauges are **named but not emitted** —
  do not alert on them) are in [`observability.md`](observability.md).
- **Live per-VM numbers:** `GET /v1/sessions/:id/metrics` — a side-effect-free pull
  (never wakes a VM), `404` when there is no live sandbox.
- **Capacity budgeting:** ≈ 76 MiB per idle woken session, up to 512 MiB worst case per
  guest; the control plane is not the constraint. The numbers are a measured **floor**
  (no model turn was in the measurement) — [`capacity.md`](capacity.md).

---

## 8. Incident response

| Symptom | First look |
|---|---|
| **`/readyz` returns `503`** | The response body names which check is down — `db`, `objectStore`, or `sandbox`. Start there. |
| **`sandbox` check `down` on a KVM host** | `SANDBOX_RUNTIME` must be `enabled`; confirm `/dev/kvm` exists and the process can access it, and that the microsandbox bootstrap ran (`~/.microsandbox/`). On a non-KVM host, `down` is expected — set `SANDBOX_RUNTIME=disabled`. |
| **A host marked unhealthy (multi-host)** | The `sandbox.host_unhealthy` webhook fired; placements route around it; VMs on it re-provision on next wake. |
| **Work queue backing up** | `GET /v1/environments/:id/work-stats` — `depth`, `oldestQueuedAt`, `workersPolling` tell you whether workers are dead or just slow. |
| **One session misbehaving** | `GET /v1/sessions/:id` + `/metrics`; interrupt it with a `user.interrupt` event. `SESSION_WORKER_MODE=pool` bounds the blast radius of a crashing/leaking harness ([`session-worker-pool.md`](session-worker-pool.md)). |
| **Suspected stuck cron** | `job_runs` records every attempt, including skips; the scheduler re-fires claimed-but-untriggered runs each tick. |
| **Sessions can't wake after a restore / key change** | Vault key mismatch — the restored/new `VAULT_KEY` must be the one the stored secrets were encrypted under (§4, §5). |
| **Secrets undecryptable after a restart** | The process booted on an **ephemeral** vault key (`ALLOW_EPHEMERAL_VAULT_KEY=true` with no `VAULT_KEY`). Never use that flag in production (§3). |

Boot is **fail-closed**: a half-configured control plane exits `1` rather than starting in
a partial state — an invalid/missing required value (no `DB_URL`, no vault key in
production, `multi` mode without mTLS) prints the error and refuses to start.

---

## 9. Related docs

- [`getting-started.md`](getting-started.md) — local dev walkthrough (install → run).
- [`deploy.md`](deploy.md) — requirements, the full env-var reference, boot sequence,
  billing adapter, RLS database role, CI gates.
- [`user-journeys.md`](user-journeys.md) — the platform-admin journeys (P1–P7) this
  runbook is drawn from, plus tenant-admin and user journeys.
- [`observability.md`](observability.md) — OTEL conventions, dashboards, what does and
  does not emit.
- [`capacity.md`](capacity.md) — the measured capacity envelope.
- [`architecture.md`](architecture.md) — the layered system overview.
