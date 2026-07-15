# Session-worker process pool (R7.1 — harness blast radius)

## The defect

Every tenant's Pi `AgentSession` runs in **one Node process** (the control plane). Isolation
exists at the VM layer — each session's tools execute inside its own microVM — but **not at
the harness layer**: one session's heap leak, event-loop block, or an uncaught throw inside
the Pi SDK degrades (or kills) *every* tenant's session in that process, and a harness crash
takes down the API with them.

## The fix, and its default

`SESSION_WORKER_MODE` selects where the harnesses run:

| value | behavior |
| --- | --- |
| `inproc` (**default**) | Every `ManagedSessionRuntime` lives in the control-plane process. The pre-R7.1 path, unchanged. |
| `pool` | The runtimes live in N bounded **child processes**, sharded deterministically by session id. A harness crash takes down only that child's sessions. |

The pool is **additive**: with `inproc` no child is forked, no pool object is constructed,
and `SessionManager` takes exactly the code path it took before (the full backend suite
runs in this mode).

## Architecture

```
 control plane (parent)                     session worker (child, xN)
 ─────────────────────────                  ─────────────────────────────────────
 Fastify routes                             ManagedSessionRuntime  (real, unchanged)
 SessionManager  (LRU / idle eviction)        ├─ SandboxProvider  → microVM
   └─ RemoteSessionRuntime  ── IPC ──┐        ├─ PiAgentSessionFactory → AgentSession
        (implements SessionRuntime)  │        ├─ SessionEventsStore  → Postgres (projection)
 SSE fan-out  ◀── outbound events ───┘        └─ DbSessionStore      → Postgres (handle/status)
 SessionEventsStore (read side)
```

- **Interface-preserving.** `SessionWorkerPool.wake()` returns a `RemoteSessionRuntime` that
  implements the `SessionRuntime` port (`wake` / `sendEvent` / `subscribe` / `interrupt` /
  `getEntries` / `status`). Routes, the Events API, the outcome runner, the scheduler's
  `triggerSession` and the self-hosted tool-result sink are unchanged.
- **Sharding.** `shardFor(sessionId) = FNV-1a(sessionId) % workers` — deterministic, so a
  session can never be woken in two processes at once (which would provision two VMs and
  fork the JSONL).
- **Bounds.** `workers = min(os.cpus().length, SESSION_WORKER_COUNT)` (default 4);
  `SESSION_WORKER_MAX_SESSIONS` (default 64) caps live sessions per child — past the cap the
  pool refuses the wake instead of over-subscribing one process.

### Events: the child persists, and *also* streams

A worker persists every outbound event to the `session_events` projection **itself** (it
holds its own pg pool and runs the same `ManagedSessionRuntime.persistEvent` path), and
*additionally* streams the event to the parent over IPC for the live SSE fan-out.

Why this way and not "stream to the parent, parent persists":

- The projection is the numbering + durability authority (R4.1/R4.2): the position stamped
  on the live SSE event *is* the position the append assigns. Keeping the write inside the
  runtime means `inproc` and `pool` persist through **identical code** — no second writer, no
  re-numbering at the process boundary, no ordering skew between the live and replayed
  streams.
- It makes the IPC link a pure *transport* for live subscribers. If a child dies with events
  in flight, nothing durable is lost: the SSE client reconnects and replays from the
  projection by position — the same recovery path a network blip already uses.

### Crash detection, recovery, respawn

1. A child exits (crash / OOM-kill / uncaught exception — the worker deliberately exits
   non-zero on `uncaughtException` and `unhandledRejection`, so a harness fault kills exactly
   one worker).
2. The parent's `exit` handler rejects that child's in-flight RPCs, marks its session proxies
   lost (their SSE iterators end), reports the lost session ids to the `SessionManager`, which
   **forgets** them, and schedules a respawn (250 ms).
3. Nothing is orphaned: the sandbox handle and status are persisted (R2.8) and the VM is
   detached (§10.1), so the next `getOrCreate` re-wakes the session on the respawned worker,
   whose `ensureSandboxRunning` finds the persisted handle, sees `status === "running"` and
   **re-attaches the same VM** (the boot-reattach path, R2.9) rather than provisioning a new
   one. Sessions on the *other* children never notice.

### `status()` is a cache

The `SessionRuntime` port's `status()` is synchronous, so it cannot round-trip over IPC. The
child pushes its state (status, sandbox handle, session context) on every transition and with
every event; the proxy answers `status()` from that cache. Staleness is bounded by IPC
latency, and nothing correctness-critical depends on it: the DB row written by the runtime's
`saveStatus` (R2.8) remains the source of truth the routes read.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `SESSION_WORKER_MODE` | `inproc` | `inproc` \| `pool` |
| `SESSION_WORKER_COUNT` | `4` | Requested workers; effective width is `min(cpus, this)` |
| `SESSION_WORKER_MAX_SESSIONS` | `64` | Live sessions per worker (hard cap) |
| `SESSION_WORKER_ENTRY` | *(dist sibling)* | Override the compiled child entry |
| `SESSION_WORKER_OVERRIDES_MODULE` | — | Module a worker imports to override its sandbox provider / agent-session factory |

The child runs the **compiled** entry (`dist/domain/session-worker/worker-entry.js`): Node
cannot execute the TypeScript sources (parameter properties are not erasable in strip-only
mode, and `.js` specifiers do not resolve to `.ts`). Any deployed artifact already contains
it; the pool test compiles the backend before forking.

`SESSION_WORKER_OVERRIDES_MODULE` exists because the two collaborators the in-process
composition root accepts as objects (`createManagedApp({ sandboxProvider, factory })`) cannot
cross a process boundary — a worker resolves them by module path instead. It mirrors the
plugin registry; unset, a worker builds the real `MicrosandboxProvider` +
`PiAgentSessionFactory`.

## Tests

`src/domain/session-worker/__tests__/pool.integration.test.ts` (real Postgres, real forked
children, real IPC, real runtimes; the pool itself is never faked):

- **(a)** sessions run in child processes — the sandbox for each session is provisioned by a
  *worker* PID (≠ ours), two sessions on different shards by *different* PIDs; their events
  reach both the live `subscribe()` fan-out and the `session_events` projection.
- **(b)** `SIGKILL` of one child leaves a session on another child fully functional (it keeps
  driving turns and appending to the projection).
- **(c)** the killed child's session recovers on the next `getOrCreate`: a new child, the
  **same** sandbox (provision count stays 1, persisted handle unchanged) — i.e. the re-attach
  path, not a silent re-provision.
- **(d)** `inproc` mode is unchanged: an in-process `ManagedSessionRuntime`, no pool.

## What is NOT covered (honest scope)

- **`SANDBOX_MODE=multi` + `SESSION_WORKER_MODE=pool` is refused at construction.** The
  multi-host provider's fail-closed boot (host registry + per-host token resolution) has not
  been re-verified inside a worker, so the pool throws rather than booting a path whose
  authentication invariants are unproven. Single-host (`MicrosandboxProvider`) pool mode is
  the supported combination.
- **The `@kvm` path in pool mode is untested here.** The pool test uses a cross-process fake
  sandbox so the crash/re-attach assertions are deterministic. The worker builds the real
  `MicrosandboxProvider` when `SANDBOX_RUNTIME=enabled` (identical construction to the
  composition root), but no test in this repo yet boots a real microVM *from inside a worker*.
- **No RPC timeout.** A turn legitimately runs for minutes; a wedged (but live) child
  therefore blocks its own sessions' RPCs indefinitely, exactly as an event-loop block does
  in `inproc` mode. Only *process death* is detected. A liveness ping + forced recycle is the
  obvious follow-up.
- **Capacity is a hard refusal, not a rebalance.** Because sharding is deterministic, a hot
  shard can hit `SESSION_WORKER_MAX_SESSIONS` while other workers idle; the pool refuses the
  wake. Consistent-hash rebalancing / migration is not implemented.
- **Not load-tested.** R7.3 (re-measure capacity with the real harness) has not been re-run
  for pool mode; per-worker RSS ceilings are unmeasured.
