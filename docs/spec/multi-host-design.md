# Multi-Host Sandbox Scheduling — Design Note (WP-4.3)

> **Scope.** Spec §7.2 (multi-host KVM pool) and §4.2 (work-queue + worker-pool for
> sandbox operations). The v1 single-host sandbox (§7.2 "single-node") shipped in
> WP-1.3 as `MicrosandboxProvider` (`infra/sandbox/provider.ts`). This WP is the
> **later-phase** multi-host implementation: the backend owns microVM placement
> routing — microsandbox itself has no multi-host scheduler.

This note was written before code; the implementation described below now exists under
`infra/sandbox-host-pool/` (registry, placement, liveness, re-attach) and
`infra/sandbox/multi-host-provider.ts` (the routing `SandboxProvider`).

## 1. Goals & non-goals

**Goals**
- A pool of KVM-capable hosts, registered in Postgres, each with capacity + labels.
- The backend chooses which host runs each microVM (placement routing).
- Each host runs the existing single-host `MicrosandboxProvider` unchanged — the
  multi-host provider delegates to the chosen host's local provider over the network.
- Boot-time re-attach across hosts: a VM is labeled with its owning host; on restart
  the backend re-attaches by label across the whole pool.
- Host liveness probing: health-check each host; remove from rotation on failure; alert.
- A work-queue + worker-pool for sandbox operations (§4.2) so stop/start/snapshot run
  on the owning host without blocking session turns.

**Non-goals (v1 of multi-host)**
- Live migration of running VMs between hosts (out of scope; crash-recovery
  re-provisions instead, §10.3).
- Cross-host volume replication (volumes are host-local; the object store is the
  durable sync target, §28).
- A full control-plane agent binary shipped here. Each host exposes a small HTTP
  "host agent" API that maps to `SandboxProvider` operations; the agent process itself
  wraps the local `MicrosandboxProvider`. This note defines the wire contract so the
  backend's `HttpHostAgent` client and a test mock host agree. The standalone agent
  binary is a separate deployment artifact (§7.2).
- Real-time streaming exec over HTTP. `execStream` over the network is buffered into
  chunks in v1 (see §6 limitation). True streaming awaits an SSE/WebSocket transport.

## 2. Architecture

```
                       ┌─────────────────────────────────────────────┐
   SessionRuntime ───▶ │ MultiHostSandboxProvider (SandboxProvider)   │
  (ports.ts; knows      │  - placement router (chooseHost)             │
   nothing of hosts)    │  - owner map (sandbox_name → host_id)        │
                       │  - delegates via HostAgent                   │
                       └──────────┬───────────────┬───────────────────┘
                                  │               │  (HTTPS, per-host)
                    ┌─────────────▼──┐      ┌────▼──────────────┐
                    │ Host A agent    │      │ Host B agent       │
                    │ Microsandbox    │      │ Microsandbox       │
                    │ Provider (KVM)  │      │ Provider (KVM)     │
                    └─────────────────┘      └────────────────────┘

   Postgres:  sandbox_hosts (registry)         sandbox_host_placements (owner map)
              └─ LivenessMonitor probes each host's /healthz on a timer
```

The `SessionRuntime` (`domain/session-manager/runtime.ts`) calls the injected
`SandboxProvider`. It is unchanged: it still calls `provision`/`status`/`start`/…
and never learns that a host pool exists. Composition swaps the single
`MicrosandboxProvider` for a `MultiHostSandboxProvider` wrapping many.

## 3. Host registry (Postgres)

Migration `024_sandbox_hosts.sql` adds two tables (see `docs/db-schema.md` §2 for
conventions; these are infra-scoped, **not tenant-scoped** — the host pool is shared
control-plane state, §7.2):

- `sandbox_hosts` — `id` (host-prefixed), `endpoint` (https://host:port), `cpus`,
  `memory_mib`, `status` (`healthy` | `unhealthy` | `drained`), `labels` (jsonb for
  placement constraints, e.g. `{"gpu":"true"}`), `last_heartbeat`, timestamps.
- `sandbox_host_placements` — `sandbox_name` (PK, the msb VM name) → `host_id`
  (FK). Records which host owns each VM for routing + re-attach.

`HostRegistry` (`registry.ts`) exposes `registerHost`, `listHosts`, `getHost(id)`,
`markUnhealthy(id, reason)`, `markHealthy(id)`, `updateHeartbeat(id)`. All persist
through the existing `query(pool, sql, params)` helper (`infra/db`).

## 4. Placement router

`chooseHost(spec: ProvisionSpec, hosts: SandboxHost[]): SandboxHost` in `placement.ts`:

1. Filter to `status === 'healthy'`.
2. Filter by label match (host `labels` must include every label constraint the spec
   carries — `spec.labels` are tenant/session, not host constraints; host constraints
   come from an optional `hostSelector` on the spec's env, but v1 treats all healthy
   hosts as eligible and only filters on capacity fit).
3. Filter by capacity fit: `host.cpus >= spec.cpus && host.memory_mib >= spec.memoryMiB`.
4. Pick **least-loaded**: the host with the fewest current placements (a count query
   over `sandbox_host_placements`), breaking ties by most free capacity
   (`host.cpus - usedCpus`). If no host fits, throw a typed error.

Least-loaded-by-count is simple, correct, and avoids needing per-host live load
metrics in v1 (those are an alerting input later, §7).

## 5. Re-attach across hosts

`reattachByLabels({tenant, session?})` is a **pool-level** operation (a single host
cannot satisfy it — the VM may live on any host). The multi-host provider:

1. Lists all healthy hosts.
2. For each host, calls `hostAgent.listByLabels(labels)` (the host agent's local
   equivalent of `MicrosandboxProvider.reattachByLabels`, which uses the msb SDK's
   `Sandbox.listWith({labels})`).
3. Merges handles, dedupes by `id`.
4. **Reconciles** the placement table: any discovered VM whose recorded owner differs
   from the host it was found on is updated (the VM may have been re-provisioned on a
   different host after a crash). Any placement row whose VM is found on no host is
   left (it will be re-provisioned on next `wake` per §10.3 crash recovery).

This satisfies §4.2: detached VMs are re-attached by label on boot, across hosts.

## 6. Host agent + delegation

`HostAgent` is the abstraction over a single host's local `SandboxProvider`. It mirrors
`SandboxProvider` minus the pool-level `reattachByLabels` (replaced by `listByLabels`)
plus a `healthz()` probe. Two implementations:

- **`HttpHostAgent`** (`multi-host-provider.ts`): the backend-side client. Talks to the
  host-agent server over HTTPS. Every request carries
  `Authorization: Bearer <per-host-secret>` (see §6.1); an unauthenticated or
  wrong-token request is rejected `401`. Wire contract (JSON over HTTP):
  - `GET  /healthz` → `200 {ok:true}` (still authenticated — §6.1)
  - `POST /provision` (ProvisionSpec) → `SandboxHandle`
  - `POST /exec` ({handle, opts}) → `ExecResult`
  - `POST /stop` | `/start` | `/destroy` ({handle}) → `204`
  - `POST /snapshot` ({handle}) → `{id}`
  - `POST /status` ({handle}) → `SandboxStatus`
  - `POST /register-secret-binding` ({handle, binding}) → `204`
  - `POST /list-by-labels` ({tenant, session?}) → `SandboxHandle[]`
  - `execStream`: v1 calls `/exec` (buffered) and yields stdout/stderr as chunks.
    Real-time streaming over the network is deferred (see §1 non-goal).

  Transport: with no client-TLS configured it uses Node's global `fetch` (no new deps,
  the plain-HTTP single-host bootstrap and the in-repo mock host). When mTLS is configured
  (`createHostAgentTlsAgent(env)` returns an agent from `HOST_AGENT_TLS_CERT/KEY/CA`), it
  uses `node:https` with that agent so the backend's client cert is presented and the host
  CA pinned — Node's global `fetch` (undici) does not accept a Node TLS agent, so the mTLS
  path bypasses it. Still no new dependency.
- **Host-agent server** (`sandbox-host-pool/server.ts`, `createHostAgentServer`): the
  deployed listener that runs *on each host*, wrapping that host's local `SandboxProvider`
  (a `MicrosandboxProvider` in production) and serving the wire contract above. Every
  handler — `/healthz` included — authenticates the bearer token *before any work* via
  `isValidHostAgentToken(header, expected)`, where `expected` is resolved from the process
  environment through `createHostAgentTokenSource` (§6.1); the listener also terminates
  mutual TLS (`requestCert`, `rejectUnauthorized`, `ca:[backendCA]`). `/list-by-labels`
  maps to the provider's `reattachByLabels` label scan (§5).
- **In-process / local**: a host whose endpoint is the backend itself can be served by
  an in-process `LocalHostAgent` wrapping a `MicrosandboxProvider` directly (no HTTP).
  Used for single-host deployments that later grow into a pool.

`MultiHostSandboxProvider` holds a `HostAgentFactory: (host) => HostAgent`. In
production this returns an `HttpHostAgent`. In tests it returns a client talking to a
mock host (Node `http` server implementing the contract, backed by an in-memory fake).

### 6.1 Trust model (auth on the host-agent channel)

The host-agent API is a **privileged control channel**: `/exec` runs arbitrary commands
inside any VM on that host, `/list-by-labels` enumerates VMs across tenants, and
`/register-secret-binding` wires credentials into a VM. Anyone who can reach a host
agent's port and speak the §6 wire contract owns every tenant's sandbox on that host.
That directly violates the §25.1 invariant ("untrusted agent code cannot touch the
backend host and cannot read credentials"), so the channel is **authenticated on every
request** — there are no unauthenticated endpoints, `/healthz` included (an open
`/healthz` is a free host-liveness oracle for an attacker probing the fleet).

- **Wire**: every request carries `Authorization: Bearer <token>` — a **per-host shared
  secret**. The backend sends it on every call, including `GET /healthz` (the liveness
  probe, §7).
- **Config**: the secret is sourced from config, never hardcoded and never logged.
  `createHostAgentTokenSource(env)` (`sandbox-host-pool/auth.ts`) resolves a host's token
  from `SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>` (per-host; host id upper-cased, non-alnum →
  `_`), falling back to the pool-wide `SANDBOX_HOST_AGENT_TOKEN`. It **fails closed**: a
  host with no configured secret throws `HostAgentTokenMissingError` rather than sending
  an unauthenticated request. `HttpHostAgent` takes the token as a required constructor
  option, so a caller cannot forget it. The token is never included in log lines or in
  the error text of a failed request.
- **Receiving side**: the host-agent server (`sandbox-host-pool/server.ts`) compares the
  presented token against its own with `isValidHostAgentToken()` — a **constant-time**
  comparison (SHA-256 digest of each side then `crypto.timingSafeEqual`, so neither the
  value nor its length leaks through timing) — as the *first* thing every handler does,
  `/healthz` included. A missing, malformed, or wrong token → **`401`** with no body. The
  expected secret is resolved once at construction via `createHostAgentTokenSource(env)`
  over the process environment. This helper is shared by the deployed server and the
  in-repo mock host so both enforce the same rule.
- **Production posture: mTLS (implemented).** The bearer token is the floor, not the
  ceiling. The host-agent listener terminates **mutual TLS**: `createHostAgentServer`
  creates the `node:https` server with `requestCert: true`, `rejectUnauthorized: true`,
  and `ca: [backendCA]`, so a caller that cannot present a client cert signed by the
  backend's internal CA never completes the handshake — the bearer token is never even
  read, and the channel is confidential in transit. The backend client presents its cert
  via `createHostAgentTlsAgent(env)` (key+cert+CA from `HOST_AGENT_TLS_CERT/KEY/CA`); the
  server loads its own material with `loadHostAgentTlsFromEnv`. Hosts additionally sit on a
  private network and firewall the agent port to the backend's addresses. The bearer token
  remains as defence in depth above the transport (it authenticates the *backend identity*,
  and it is what the in-repo mock host and the single-host bootstrap path verify). Tested
  in `sandbox-host-pool/__tests__/host-agent-server.test.ts`: no/wrong bearer → `401`;
  correct bearer + valid client cert → `200`; missing client cert → handshake rejected.
- **Rotation**: tokens are per-host, so one may be rotated by updating config for that
  host and restarting its agent; the backend re-reads its token source at agent-factory
  construction time.

### Routing rules
- `provision(spec)` → `chooseHost` → `agent.provision` → record placement
  (`sandbox_name → host_id`) → return handle.
- `exec`/`execStream`/`stop`/`start`/`snapshot`/`destroy`/`status`/`registerSecretBinding`
  → look up the owner host for `handle.name` → route to that host's agent. If the
  owner row is missing, fall back to a label-scan to locate the VM (reconcile), then
  route. If the host is unhealthy, the op fails fast (the caller's crash-recovery
  re-provisions on a healthy host, §10.3).
- `reattachByLabels` → scan all healthy hosts (§5).

## 7. Liveness

`LivenessMonitor` (`liveness.ts`):
- On a configurable interval (default 10s), for each host in the registry, call
  `agent.healthz()` (`GET /healthz`, short timeout).
- On success: `updateHeartbeat(id)`; if it was `unhealthy`, `markHealthy`.
- On failure: increment a fail counter. After a threshold (default 3 consecutive
  failures): `markUnhealthy(id, reason)` (removes from rotation — `chooseHost` filters
  by `healthy`), **log** the transition, and **alert** via `WebhookSink.dispatch` with
  a `sandbox.host_unhealthy` event (`{type, id, createdAt}` per §23.2).
- `start()`/`stop()` manage the timer; `probeOnce()` is exposed for tests.

## 8. Work queue + worker pool (§4.2)

Background sandbox operations (stop / start / snapshot / destroy) are dispatched to the
**owning host** rather than the session turn's critical path. The multi-host provider
submits these as work items; a small worker pool drains them concurrently with a
configurable concurrency cap (default 8). Provision and exec stay synchronous (exec is
the turn; provision blocks `wake`). This decouples long snapshot/checkpoint ops from
turn latency and bounds per-host fan-out. (The existing `self_hosted_work_queue`
table, §10.4, is a *different* concern — self-hosted tool execution. The sandbox-op
queue here is in-memory in v1, persisted to the placement table's status on
completion; a durable Postgres queue is a future hardening if a host loss must not lose
pending snapshots.)

## 9. Failure modes

- **Host down mid-turn**: `exec` routes to the owner; it's unhealthy → throws; the
  runtime's crash recovery (`crash-recovery.ts`) re-provisions on a healthy host.
- **Host down at boot re-attach**: `reattachByLabels` only scans healthy hosts; a VM
  on a dead host is not re-attached and will be re-provisioned on `wake` (§10.3).
- **No healthy host fits the spec**: `provision` throws a typed `NoHostAvailableError`;
  the session enters `rescheduling` then `terminated` (§6.3, decisions.md item 7).
- **Placement table drift**: re-attach reconciliation (§5) repairs owner rows.

## 10. Testing

Tests (`__tests__/multi-host.test.ts`) use a mock host: a Node `http` server
implementing the §6 wire contract, backed by a tiny in-memory fake provider. Covers:
placement (least-loaded picks the emptiest host); host unhealthy → removed from
rotation (placement skips it); re-attach across hosts (a VM on host A is found by a
label scan across the pool); liveness probe (failed `/healthz` → `markUnhealthy` +
webhook fired).
