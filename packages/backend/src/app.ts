/**
 * Composition root (WP-1.13 — wiring & E2E assembly).
 *
 * {@link createManagedApp} is the full deployment factory: it instantiates every
 * real subsystem from {@link Config} — Postgres pool (+ runs migrations on boot),
 * object store, microsandbox provider, the `SessionManager` registry of active
 * {@link ManagedSessionRuntime}s — and delegates to {@link createApp} (server.ts)
 * to mount all routes with the real impls. {@link startManagedServer} is the boot
 * entrypoint (`src/main.ts`); it owns graceful shutdown.
 *
 * This module is the only place that knows how to construct the whole graph; the
 * low-level `createApp` stays a pure wiring target so individual WP suites keep
 * testing against it with fakes.
 */

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { hostAgentTokenEnv, type Config } from "./infra/config/index.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "./infra/db/index.js";
import {
  objectStoreFromConfig,
  createObjectStore,
  type ObjectStoreConfig,
} from "./infra/objectstore/index.js";
import type { TelemetryHandle } from "./infra/telemetry/index.js";
import { MicrosandboxProvider } from "./infra/sandbox/provider.js";
import {
  HttpHostAgent,
  MultiHostSandboxProvider,
  createHostAgentTlsAgent,
  type HostAgent,
} from "./infra/sandbox/multi-host-provider.js";
import {
  HostRegistry,
  LivenessMonitor,
  createHostAgentTokenSource,
  type HostAgentTokenSource,
  type SandboxHost,
} from "./infra/sandbox-host-pool/index.js";
import { DbSessionStore } from "./domain/session/db-session-store.js";
import {
  listResumableSessions,
  listReapableSandboxSessions,
  clearReapedSandboxHandle,
} from "./domain/session/session-repo.js";
import { createUsageRecorder } from "./domain/usage/usage-recorder.js";
import {
  createBillingSink,
  createMeteringAggregator,
  NOOP_BILLING_SINK,
  type BillingSinkOverrides,
  type MeteringAggregator,
} from "./domain/billing/index.js";
import { createVaultSecretStore } from "./domain/vault/secret-store.js";
import { createProviderKeyResolver } from "./domain/vault/provider-keys.js";
import { createVaultSecretResolver } from "./domain/vault/secret-resolver.js";
import { createVaultMcpCredentialResolver } from "./domain/mcp/credential-resolver.js";
import {
  WebhookDispatcher,
  createWebhookEventSource,
  type DispatcherOptions,
  type WebhookEventSource,
} from "./domain/webhook/index.js";
import { createOutcomeRunner } from "./domain/outcome/runner.js";
import {
  SubagentGrader,
  SandboxOutputsResolver,
  PiGraderSessionFactory,
  defineOutcome,
  type Grader,
} from "./domain/outcome/index.js";
import type { TriggerSessionFn } from "./domain/scheduler/index.js";
import { inboundToPorts } from "./domain/event-stream/index.js";
import type { EventsReader } from "./domain/event-stream/index.js";
import type { Clock } from "./domain/ports.js";
import {
  ManagedSessionRuntime,
  PiAgentSessionFactory,
  SessionEventsStore,
} from "./domain/session-manager/index.js";
import type {
  AgentSessionFactory,
  MemoryMountService,
  SelfHostedChannelFactory,
  SessionStore,
  SkillMaterializer,
} from "./domain/session-manager/types.js";
import { SessionWorkerPool } from "./domain/session-worker/index.js";
import { createMemoryMountService } from "./domain/memory/mount.js";
import { createSkillMaterializer } from "./domain/skill/materialize.js";
import { seedPrebuiltSkills } from "./domain/skill/seed.js";
import {
  clearTenantSeedHook,
  setTenantSeedHook,
} from "./domain/tenant/tenant.js";
import {
  clearToolResultSink,
  createSelfHostedChannelFactory,
  setToolResultSink,
} from "./domain/self-hosted/work-queue.js";
import type {
  EntryRange,
  ObjectStore,
  ProviderKeyResolver,
  SandboxHandle,
  SandboxProvider,
  SessionContext,
  SessionEntry,
  SessionRuntime,
  TenantId,
  UsageRecorder,
  SecretStore,
  SessionId,
} from "./domain/ports.js";
import type { TenantCtx } from "./infra/db/pool.js";
import {
  defaultPluginRegistry,
  type PluginContext,
  type PluginRegistry,
} from "./plugins/index.js";
import { createApp, startServer } from "./server.js";

// ---------------------------------------------------------------------------
// SessionManager — registry of active ManagedSessionRuntimes
// ---------------------------------------------------------------------------

/**
 * A runtime held by the {@link SessionManager} registry: the {@link SessionRuntime} port
 * plus the two accessors the composition root reads off it (the bound sandbox handle for
 * the outputs routes, the re-resolution context for the vault revalidation loop) and
 * `dispose()`. Satisfied by BOTH the in-process {@link ManagedSessionRuntime} and the
 * pool-mode `RemoteSessionRuntime` proxy (R7.1) — which is what keeps every caller above
 * this seam unchanged between `SESSION_WORKER_MODE=inproc` and `=pool`.
 */
export type RegistrySessionRuntime = SessionRuntime & {
  dispose(): void;
  readonly sandboxHandle?: SandboxHandle | undefined;
  readonly sessionContext?: SessionContext | undefined;
};

/** Collaborators needed to construct a runtime per session. */
export interface SessionManagerDeps {
  sandbox: SandboxProvider | undefined;
  objects: ObjectStore;
  usage: UsageRecorder;
  secrets: SecretStore;
  sessions: SessionStore;
  factory: AgentSessionFactory;
  /**
   * Append-only event projection (R4.1, §9.3). Injected into every runtime so emitted
   * outbound events are persisted for history/replay. Omitted ⇒ persistence is skipped.
   */
  events?: SessionEventsStore;
  /** Resolves model-provider keys host-side at wake (§4.2 / R2.7). */
  providerKeyResolver?: ProviderKeyResolver;
  /** Vault-backed MCP credential resolver for the mcp-bridge extension (§25.3 / R2.5). */
  mcpCredentialResolver?: import("./domain/mcp/proxy.js").McpCredentialResolver;
  /** Memory-store mounts at session start (R6.5a, §13.1–13.3). */
  memory?: MemoryMountService;
  /** Skill materialization at session start (R6.5b, §20.3/§20.4). */
  skills?: SkillMaterializer;
  /** Self-hosted execution channel (R6.6, §10.4) — tools run on the subscriber's worker. */
  selfHosted?: SelfHostedChannelFactory;
  /**
   * Handler for an inbound `user.define_outcome` event (§16.3): define + run the outcome
   * loop for the calling session. Wired by the composition root when a grader is available;
   * omitted ⇒ `define_outcome` over the event stream is a no-op (the REST route is primary).
   */
  onDefineOutcome?: (
    ctx: { tenantId: string; sessionId: string },
    payload: unknown,
  ) => Promise<void>;
  /** Idle-eviction timeout (ms). A runtime idle this long is disposed from the
   * registry (its sandbox was already checkpointed by the IdlePolicy). */
  idleTimeoutMs: number;
  /**
   * Hard cap on the number of in-memory runtimes (R2.11). When exceeded, the
   * least-recently-used IDLE runtime is evicted (a running runtime is never evicted).
   * Defaults to {@link DEFAULT_MAX_RUNTIMES}.
   */
  maxRuntimes: number;
  /**
   * Session-worker process pool (R7.1, `SESSION_WORKER_MODE=pool`). When present, `wake()`
   * boots the runtime in a CHILD process (sharded by session id) and the registry holds a
   * `RemoteSessionRuntime` proxy instead of an in-process {@link ManagedSessionRuntime};
   * everything else about the registry (LRU, idle eviction, capacity) is identical. Absent
   * (the default, `inproc`) ⇒ the pre-R7.1 in-process path, unchanged.
   */
  workers?: SessionWorkerPool;
  logger: Logger;
}

/**
 * In-process registry of active {@link ManagedSessionRuntime}s (§4.2 — one
 * in-process instance per active session). `wake()` boots a runtime bound to the
 * existing JSONL; `getOrCreate()` returns the active runtime or wakes it;
 * `dispose()` stops + drops one; idle runtimes are evicted after
 * {@link SessionManagerDeps.idleTimeoutMs}.
 */
export class SessionManager implements EventsReader {
  /** Active runtimes. Insertion order is the LRU order (touch = delete + re-set). */
  private readonly runtimes = new Map<SessionId, RegistrySessionRuntime>();
  private readonly idleTimers = new Map<SessionId, NodeJS.Timeout>();
  /**
   * In-flight `wake()` promises keyed by session id (R2.11). Inserted SYNCHRONOUSLY
   * before the first await so two concurrent `getOrCreate`s on a cold session share one
   * wake — the fix for the check-then-act race that provisioned the VM twice.
   */
  private readonly inflight = new Map<SessionId, Promise<RegistrySessionRuntime>>();

  constructor(private readonly deps: SessionManagerDeps) {
    // R7.1: a worker child died. Its sessions' sandbox handles + statuses are persisted
    // (R2.8) and their detached VMs survive, so forget the dead proxies — the next
    // `getOrCreate` re-wakes each session on the respawned worker, which re-attaches the
    // SAME VM (the boot-reattach path, R2.9).
    this.deps.workers?.onSessionsLost((ids) => {
      for (const id of ids) this.forget(id);
    });
  }

  /** Boot a runtime for `sessionId` bound to its existing JSONL. */
  async wake(sessionId: SessionId): Promise<RegistrySessionRuntime> {
    if (this.runtimes.has(sessionId)) {
      return this.runtimes.get(sessionId)!;
    }
    // R7.1 pool mode: the runtime lives in a child process; the registry holds a proxy.
    // The sandbox provider is built INSIDE the worker, so the parent needs none.
    if (this.deps.workers) {
      const remote = await this.deps.workers.wake(sessionId);
      this.runtimes.set(sessionId, remote);
      this.scheduleEviction(sessionId);
      this.evictIfOverCapacity(sessionId);
      return remote;
    }
    if (!this.deps.sandbox) {
      throw new Error(
        "SessionManager.wake: sandbox runtime is disabled (SANDBOX_RUNTIME=disabled)",
      );
    }
    const rt = new ManagedSessionRuntime({
      sandbox: this.deps.sandbox,
      objects: this.deps.objects,
      usage: this.deps.usage,
      secrets: this.deps.secrets,
      sessions: this.deps.sessions,
      factory: this.deps.factory,
      ...(this.deps.events ? { events: this.deps.events } : {}),
      ...(this.deps.providerKeyResolver
        ? { providerKeyResolver: this.deps.providerKeyResolver }
        : {}),
      ...(this.deps.mcpCredentialResolver
        ? { mcpCredentialResolver: this.deps.mcpCredentialResolver }
        : {}),
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.skills ? { skills: this.deps.skills } : {}),
      ...(this.deps.selfHosted ? { selfHosted: this.deps.selfHosted } : {}),
      ...(this.deps.onDefineOutcome
        ? { onDefineOutcome: this.deps.onDefineOutcome }
        : {}),
    });
    await rt.wake(sessionId);
    this.runtimes.set(sessionId, rt);
    this.scheduleEviction(sessionId);
    this.evictIfOverCapacity(sessionId);
    return rt;
  }

  /**
   * Return the active runtime for `sessionId`, or wake it on demand. Atomic w.r.t.
   * concurrent callers (R2.11): the first cold caller records its `wake()` promise in
   * {@link inflight} synchronously; concurrent callers await the same promise instead of
   * starting a second wake (which would provision a second VM).
   */
  getOrCreate(sessionId: SessionId): Promise<RegistrySessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      // Cancel pending eviction — the session is active again — and mark it MRU.
      this.clearEviction(sessionId);
      this.scheduleEviction(sessionId);
      this.touchLru(sessionId);
      return Promise.resolve(existing);
    }
    const pending = this.inflight.get(sessionId);
    if (pending) return pending;
    const p = this.wake(sessionId).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, p);
    return p;
  }

  /** Stop + drop a single runtime. */
  async dispose(sessionId: SessionId): Promise<void> {
    this.clearEviction(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.runtimes.delete(sessionId);
    try {
      rt.dispose();
    } catch (err) {
      this.deps.logger.warn({ sessionId, err: (err as Error).message }, "runtime dispose failed");
    }
  }

  /**
   * Drop a runtime from the registry WITHOUT disposing it (R7.1). Used when its worker
   * child died: the remote runtime is already gone, so there is nothing to tear down — the
   * session simply re-wakes (and re-attaches its surviving VM) on the next `getOrCreate`.
   */
  forget(sessionId: SessionId): void {
    this.clearEviction(sessionId);
    this.runtimes.delete(sessionId);
  }

  /** Stop + drop every active runtime (graceful shutdown). */
  async disposeAll(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    await Promise.all(ids.map((id) => this.dispose(id)));
  }

  /** Number of active runtimes (test/observability). */
  get size(): number {
    return this.runtimes.size;
  }

  /**
   * The re-resolution contexts of every active session (§12.5). Feeds the vault
   * revalidation loop so rotation/archival + mcp_oauth refresh propagate to running
   * sessions without a restart.
   */
  runningSessionContexts(): SessionContext[] {
    const out: SessionContext[] = [];
    for (const rt of this.runtimes.values()) {
      const ctx = rt.sessionContext;
      if (ctx) out.push(ctx);
    }
    return out;
  }

  /**
   * The active IN-PROCESS runtime for `sessionId`, or `undefined`. Test/teardown accessor
   * (e.g. a mock agent brain that writes files via the live sandbox handle). In pool mode
   * (R7.1) the runtime lives in a child process and this returns `undefined` — use
   * {@link activeRuntime} for the port-level view that works in both modes.
   */
  getRuntime(sessionId: SessionId): ManagedSessionRuntime | undefined {
    const rt = this.runtimes.get(sessionId);
    return rt instanceof ManagedSessionRuntime ? rt : undefined;
  }

  // -- read path (R4.4): reads NEVER boot a VM ------------------------------

  /**
   * The active runtime for `sessionId`, or `undefined` — **never wakes one** (R4.4). The
   * Events API attaches a live SSE tail only when a runtime is already in memory; a
   * completed / archived session is served entirely from the projection below, so reading
   * a cold session's history provisions ZERO sandboxes.
   */
  activeRuntime(sessionId: SessionId): RegistrySessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /**
   * Read a positional slice of a session's persisted events straight from the
   * `session_events` projection (R4.1) — a plain Postgres query, no runtime, no sandbox
   * (R4.4). `tenantId` is the caller's tenant: tenancy is enforced upstream by the
   * tenant-scoped session lookup that resolves `sessionId` (the route 404s a cross-tenant
   * id before it ever reaches this seam).
   */
  async readEvents(
    tenantId: TenantId,
    sessionId: SessionId,
    range?: EntryRange,
  ): Promise<SessionEntry[]> {
    void tenantId;
    if (!this.deps.events) return [];
    return this.deps.events.read(sessionId, range);
  }

  /** The projection head (next position) for `sessionId` — no runtime, no sandbox (R4.4). */
  async readEventsHead(sessionId: SessionId): Promise<number> {
    if (!this.deps.events) return 0;
    return this.deps.events.head(sessionId);
  }

  /** Mark a session most-recently-used by moving it to the end of the LRU order. */
  private touchLru(sessionId: SessionId): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) return;
    this.runtimes.delete(sessionId);
    this.runtimes.set(sessionId, rt);
  }

  /**
   * Enforce {@link SessionManagerDeps.maxRuntimes} (R2.11): while over the cap, evict the
   * least-recently-used IDLE runtime (Map insertion order = LRU order). A running runtime
   * is NEVER evicted — dropping it mid-turn would abort live work — so if nothing idle is
   * evictable the registry is allowed to exceed the cap until a turn settles. `keepId`
   * (the just-woken session) is never chosen.
   */
  private evictIfOverCapacity(keepId: SessionId): void {
    while (this.runtimes.size > this.deps.maxRuntimes) {
      let victim: SessionId | undefined;
      for (const [id, rt] of this.runtimes) {
        if (id === keepId) continue;
        if (rt.status() === "idle") {
          victim = id;
          break; // first idle in LRU order = oldest idle
        }
      }
      if (victim === undefined) break; // nothing idle to evict — never evict a running one
      // dispose() removes the entry synchronously (no await before the delete), so the
      // loop's size check sees the reduced count on the next iteration.
      void this.dispose(victim);
    }
  }

  private scheduleEviction(sessionId: SessionId): void {
    this.clearEviction(sessionId);
    const timer = setTimeout(() => {
      // Status-aware idle eviction: a long turn that ran past `idleTimeoutMs` without a
      // further API touch must NOT be disposed mid-turn (it would abort live work — the
      // pool layer explicitly expects multi-minute turns). Only dispose an IDLE runtime;
      // otherwise reschedule and re-check after another interval. Mirrors the running-guard
      // that `evictIfOverCapacity` already applies to LRU eviction.
      const rt = this.runtimes.get(sessionId);
      if (rt && rt.status() !== "idle") {
        this.scheduleEviction(sessionId);
        return;
      }
      void this.dispose(sessionId).catch(() => {
        /* best-effort */
      });
    }, this.deps.idleTimeoutMs);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  private clearEviction(sessionId: SessionId): void {
    const t = this.idleTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

export interface CreateManagedAppOptions {
  config: Config;
  logger: Logger;
  /** Override the object-store config (tests). Defaults to config-derived. */
  objectStoreConfig?: ObjectStoreConfig;
  /** Override the sandbox provider (tests). Defaults to MicrosandboxProvider when enabled. */
  sandboxProvider?: SandboxProvider;
  /** Override the agent-session factory (tests). Defaults to PiAgentSessionFactory. */
  factory?: AgentSessionFactory;
  /** Skip running migrations on boot (tests that run them explicitly). */
  skipMigrations?: boolean;
  /** Idle-eviction timeout override (ms). Defaults to {@link DEFAULT_REGISTRY_IDLE_MS}. */
  idleTimeoutMs?: number;
  /**
   * Hard cap on in-memory runtimes (R2.11). Defaults to {@link DEFAULT_MAX_RUNTIMES},
   * overridable here or via the `PI_MAX_RUNTIMES` env var. Past the cap the LRU idle
   * runtime is evicted (running runtimes are never evicted).
   */
  maxRuntimes?: number;
  /**
   * Plugin registry consulted before the default impls. Defaults to
   * {@link defaultPluginRegistry}. Pass a fresh `PluginRegistry` for test isolation.
   */
  pluginRegistry?: PluginRegistry;
  /**
   * Injectable clock for the scheduler tick loop (§17.8). Defaults to wall-clock.
   * Tests pass a controllable clock to fire crons deterministically.
   */
  clock?: Clock;
  /**
   * Scheduler tick interval (ms). Default 60s (§17.8). Tests set a small value so the
   * wired loop fires quickly.
   */
  schedulerIntervalMs?: number;
  /**
   * Sandbox-reaper interval (ms, ROB-3). Default {@link DEFAULT_SANDBOX_REAPER_MS}. `0`
   * disables the loop. The reaper destroys detached VMs left behind by terminal/archived
   * sessions and clears their handles. Tests set a small value (or 0 + drive `reapOnce()`).
   */
  sandboxReaperIntervalMs?: number;
  /**
   * Event-projection retention loop (PERF-9). `eventsRetentionIntervalMs` is how often the
   * loop runs (default {@link DEFAULT_EVENTS_RETENTION_INTERVAL_MS}); `eventsRetentionMs` is
   * the age past which a `session_events` row is pruned (default
   * {@link DEFAULT_EVENTS_RETENTION_MS}). Either `0` disables the loop. Tests set small values.
   */
  eventsRetentionIntervalMs?: number;
  eventsRetentionMs?: number;
  /**
   * Webhook dispatcher retry-loop options (fetch/DNS/interval overrides). Merged with
   * the pool-backed defaults. Tests inject `fetchImpl` + `dnsResolver` + a small
   * `intervalMs` so a signed delivery can be observed without a real network egress.
   */
  webhookDispatcherOptions?: Omit<DispatcherOptions, "pool">;
  /**
   * Billing-sink overrides (W8.2, §29.6) — fetch/DNS/backoff injection for the
   * webhook billing sink, mirroring {@link webhookDispatcherOptions}. Ignored when
   * `config.billingSink === "none"` (the default). Tests inject `fetchImpl` +
   * `dnsResolver` so a signed metering delivery is observable without real egress.
   */
  billingSinkOptions?: BillingSinkOverrides;
  /**
   * Vault re-resolution loop interval (ms, §12.5). Default 60s. `0` disables the loop.
   */
  revalidationIntervalMs?: number;
  /**
   * The outcome grader (§16.4). When supplied, the produce→grade→feedback loop is wired
   * into the Outcomes route; omitted ⇒ the route only persists the outcome (the
   * production {@link SubagentGrader} materialization lands with R6.3). Tests inject a
   * fake grader to drive the loop without a live model.
   */
  outcomeGrader?: Grader;
}

/** Default vault re-resolution interval (60s, §12.5). */
export const DEFAULT_REVALIDATION_MS = 60_000;

/** Default idle-eviction for the registry (15 min). */
export const DEFAULT_REGISTRY_IDLE_MS = 15 * 60 * 1000;

/** Default hard cap on in-memory runtimes (R2.11). */
export const DEFAULT_MAX_RUNTIMES = 256;

/** Default sandbox-reaper interval (60s, ROB-3). */
export const DEFAULT_SANDBOX_REAPER_MS = 60_000;

/** Default event-projection retention sweep interval (1h, PERF-9). */
export const DEFAULT_EVENTS_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Default age past which a `session_events` row is pruned (30 days, PERF-9). Far beyond the
 * Last-Event-ID reconnect horizon, so pruning never drops an event a live client could still
 * request; it only bounds the append-only projection's unbounded growth.
 */
export const DEFAULT_EVENTS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default instance-ownership lease window (5 min, ROB-13). Mirrors the config schema default. */
export const DEFAULT_INSTANCE_LEASE_MS = 300_000;

/** Default per-pass batch size for the sandbox reaper (ROB-3). */
const DEFAULT_SANDBOX_REAPER_BATCH = 50;

export interface ManagedApp {
  app: FastifyInstance;
  pool: Pool;
  objectStore: ObjectStore;
  sandboxProvider: SandboxProvider | undefined;
  sessionManager: SessionManager;
  /** Append-only event projection (R4.1) — the read path for history/replay. */
  eventsStore: SessionEventsStore;
  /**
   * The session-worker process pool (R7.1) — present only under
   * `SESSION_WORKER_MODE=pool`. Exposes the worker PIDs / per-worker session counts.
   */
  sessionWorkers?: SessionWorkerPool;
  /**
   * The metering aggregator (§11.4/§11.6, WP-C5.2) — present only when billing is
   * enabled or an export sink is configured. Exposed so a test can deterministically
   * flush a closed bucket (`flushAll`) instead of waiting on the timer.
   */
  meteringAggregator?: MeteringAggregator;
  /** Graceful shutdown: stop runtimes, close the pool, close the app. */
  close: () => Promise<void>;
}

/**
 * Build the fully-wired application from {@link Config}. Instantiates the pool
 * (and runs migrations up on boot), the object store, the microsandbox provider
 * (when `config.sandboxRuntime === "enabled"`), the {@link SessionManager}
 * registry, and delegates to {@link createApp} to mount every route with the
 * real impls. Does not bind a port (use {@link startManagedServer}).
 */
export async function createManagedApp(
  opts: CreateManagedAppOptions,
): Promise<ManagedApp> {
  const { config, logger } = opts;
  if (!config.dbUrl) {
    throw new Error(
      "createManagedApp: config.dbUrl is required (set DB_URL)",
    );
  }

  // 0. Billing sink (W8.2, §29.6). Built from config BEFORE the pool so a
  //    misconfigured sink (`BILLING_SINK=webhook` with no URL/secret) fails the boot
  //    without leaking a connection pool. Default `none` ⇒ the no-op sink.
  const billingSink = createBillingSink(config, logger, opts.billingSinkOptions);

  // 1. Pool (caller owns lifecycle; closed via `close()`). PERF-1: bound the pool size and
  //    the acquire timeout (pg's default is 10 connections + wait-forever, which turns pool
  //    exhaustion into an unbounded hang), and cap every connection's server-side
  //    `statement_timeout` so a runaway query cannot pin a connection indefinitely.
  const pool = createPool({
    connectionString: config.dbUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
    ...(config.dbStatementTimeoutMs > 0
      ? { statement_timeout: config.dbStatementTimeoutMs }
      : {}),
  });

  // 2. Migrations up on boot (forward-only, §3.2).
  if (!opts.skipMigrations) {
    await runMigrations(config.dbUrl, "up");
  }

  const pluginRegistry = opts.pluginRegistry ?? defaultPluginRegistry;
  const pluginCtx: PluginContext = { config, logger, pool };

  // 3. Object store (filesystem v1 default, §7.3) — plugin override wins over default.
  const objectStore = opts.objectStoreConfig
    ? await createObjectStoreFromConfig(opts.objectStoreConfig)
    : (await pluginRegistry.resolveObjectStore(pluginCtx)) ??
      (await objectStoreFromConfig(config));

  // 4. Sandbox provider (only when the runtime is enabled) — plugin override wins.
  //    R6.7: `SANDBOX_MODE=multi` selects the routing {@link MultiHostSandboxProvider}
  //    over the host pool (registry + one authenticated HttpHostAgent per host, §6.1);
  //    `single` keeps the host-local {@link MicrosandboxProvider}. Everything downstream
  //    depends only on the {@link SandboxProvider} interface, so nothing else changes.
  const injectedSandbox =
    opts.sandboxProvider ??
    (await pluginRegistry.resolveSandboxProvider(pluginCtx));
  const hostPool =
    !injectedSandbox &&
    config.sandboxRuntime === "enabled" &&
    config.sandboxMode === "multi"
      ? // Fail-closed boot errors (no pool, missing host secret) must not leak the pool.
        await createHostPool(config, pool).catch(async (err: unknown) => {
          await closePool(pool);
          throw err;
        })
      : undefined;
  const sandboxProvider: SandboxProvider | undefined =
    injectedSandbox ??
    hostPool?.provider ??
    (config.sandboxRuntime === "enabled"
      ? new MicrosandboxProvider({ secretResolver: createVaultSecretResolver(pool) })
      : undefined);

  // 5. Session manager collaborators.
  const sessions = new DbSessionStore(pool, { localDir: config.sessionLocalDir });
  // Append-only event projection (R4.1): the write side is injected into every runtime;
  // the read side (history/replay) reads from it via the Events API.
  const events = new SessionEventsStore(pool);
  // W8.2 / §29.6 / §11.4: the usage→billing seam. Every successful `record()` hands
  // the request to the metering aggregator (constructed below, once the webhook event
  // source exists) via a forward reference — a synchronous accumulate that never
  // blocks recording. The aggregator flushes time-bucketed export events + drains the
  // ledger on its own loop. Undefined until wired ⇒ a no-op (billing fully disabled).
  let meteringAggregator: MeteringAggregator | undefined;
  const usage = createUsageRecorder({
    pool,
    onMetering: (rec) => meteringAggregator?.ingest(rec),
  });
  const secrets =
    (await pluginRegistry.resolveSecretStore(pluginCtx)) ??
    createVaultSecretStore(pool);
  const factory = opts.factory ?? new PiAgentSessionFactory();
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_REGISTRY_IDLE_MS;
  const maxRuntimes =
    opts.maxRuntimes ??
    (process.env.PI_MAX_RUNTIMES ? Number(process.env.PI_MAX_RUNTIMES) : undefined) ??
    DEFAULT_MAX_RUNTIMES;
  // Model-provider keys are decrypted host-side at wake (§4.2 / R2.7).
  const providerKeyResolver = createProviderKeyResolver(pool);
  // MCP tokens are decrypted host-side per call by the mcp-bridge proxy (§25.3 / R2.5).
  const mcpCredentialResolver = createVaultMcpCredentialResolver(pool);
  // R6.5: memory stores are mounted (and written back) at session start; the agent's
  // skills are staged into the session's `.pi/skills` for Pi's progressive disclosure.
  const memory = createMemoryMountService({ pool, objectStore });
  const skills = createSkillMaterializer({ pool, objectStore });
  // R6.6: a `self_hosted` session executes its tools on the subscriber's worker via the
  // work queue instead of a cloud microVM.
  const selfHosted = createSelfHostedChannelFactory(pool);

  // 5a. Session-worker process pool (R7.1). `SESSION_WORKER_MODE=pool` moves every
  //     `ManagedSessionRuntime` into a bounded set of child processes sharded by session
  //     id, so a harness crash (heap exhaustion, an uncaught throw in the Pi SDK) takes
  //     down only that child's sessions. The default `inproc` builds no pool and leaves the
  //     in-process path below untouched. The workers build their OWN collaborator graph
  //     (pool, object store, sandbox provider, projection) — see `session-worker/`.
  const workers =
    config.sessionWorkerMode === "pool"
      ? new SessionWorkerPool({ config, logger })
      : undefined;
  if (workers) {
    await workers.start().catch(async (err: unknown) => {
      await closePool(pool);
      throw err;
    });
  }

  // Late-bound so `user.define_outcome` over the event stream runs the SAME define+run the
  // REST route does. The runner (below) depends on `resolveRuntime` → `sessionManager`, so
  // it cannot exist yet; the stable wrapper in the deps delegates to this holder, assigned
  // once the runner is built.
  let defineOutcomeFromEvent:
    | ((
        ctx: { tenantId: string; sessionId: string },
        payload: unknown,
      ) => Promise<void>)
    | undefined;

  const sessionManager = new SessionManager({
    sandbox: sandboxProvider,
    objects: objectStore,
    usage,
    secrets,
    sessions,
    factory,
    events,
    providerKeyResolver,
    mcpCredentialResolver,
    memory,
    skills,
    selfHosted,
    onDefineOutcome: (ctx, payload) =>
      defineOutcomeFromEvent?.(ctx, payload) ?? Promise.resolve(),
    idleTimeoutMs,
    maxRuntimes,
    ...(workers ? { workers } : {}),
    logger,
  });

  // R6.6: close the worker→session round trip. `POST /v1/sessions/:id/work-result`
  // persists the result on the work item AND hands it to this sink, which resolves the
  // LIVE runtime and delivers a `user.tool_result` (§9.2) — that is what makes the
  // model's pending tool call resolve. `activeRuntime` never wakes a session (R4.4): a
  // result for an evicted session stays durable on the work item.
  setToolResultSink({
    deliver: async (sessionId, result) => {
      const rt = sessionManager.activeRuntime(sessionId);
      if (!rt) return;
      await rt.sendEvent({
        type: "user.tool_result",
        id: `evt_${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        payload: result,
      });
    },
  });

  // R6.5c: seed the pre-built skill set (`pptx`/`xlsx`/`docx`/`pdf`, §20.1) into every
  // newly created tenant. `seedPrebuiltSkills` existed but was never invoked; tenant
  // creation (onboarding sign-up) holds no object store, so the composition root supplies
  // one through this hook.
  setTenantSeedHook(async (seedPool, tenantId) => {
    await seedPrebuiltSkills(seedPool, { tenantId }, objectStore);
  });

  // 5b. Boot-time VM re-attach (R2.9). Rediscover detached VMs that survived a backend
  //     restart and reconcile their handles onto the resumable session rows, so the next
  //     lazy `getOrCreate` re-attaches the SAME VM instead of orphaning it + provisioning
  //     a fresh one. Non-fatal: a recovery failure must not block boot. Does NOT eagerly
  //     wake — `ensureSandboxRunning` picks up the reconciled handle on demand.
  // ROB-13: this instance's ownership id for boot-recovery scoping. A random per-boot id when
  // unset gives correct multi-instance behavior — a peer's live rows are never reset — while a
  // restarted instance reclaims its own abandoned rows via the expired-lease path. The lease
  // falls back to the schema default if a caller hands us a Config built outside `loadConfig`.
  const instanceId = config.instanceId ?? crypto.randomUUID();
  const instanceLeaseMs = Number.isFinite(config.instanceLeaseMs)
    ? config.instanceLeaseMs
    : DEFAULT_INSTANCE_LEASE_MS;
  if (sandboxProvider) {
    await reattachSurvivingSandboxes({
      pool,
      sandboxProvider,
      sessions,
      logger,
      instanceId,
      instanceLeaseMs,
    });
  }

  // 6. Resolve the live runtime for the Events API + outputs routes. `resolveRuntime` is
  //    the ADVANCE path (it wakes/provisions on demand); the Events API read path uses
  //    `sessionManager` as the projection reader + `activeRuntime` for the live tail, so a
  //    read never boots a VM (R4.4).
  const resolveRuntime = (sessionId: string): Promise<SessionRuntime> =>
    sessionManager.getOrCreate(sessionId);
  const getActiveRuntime = (sessionId: string): SessionRuntime | undefined =>
    sessionManager.activeRuntime(sessionId);
  const sandboxResolver = {
    // Works in both modes (R7.1): `RegistrySessionRuntime` exposes the bound handle
    // whether the runtime is in-process or a pool proxy reporting the child's handle.
    resolve: async (_ctx: TenantCtx, sessionId: string): Promise<SandboxHandle | null> => {
      const rt = await sessionManager.getOrCreate(sessionId);
      return rt.sandboxHandle ?? null;
    },
  };

  // 7. Background loops (R2.3). `createApp`/`server.ts` starts each loop + registers its
  //    `onClose` stop hook when the corresponding option is supplied; the composition
  //    root's job is to construct the real deps.

  // 7a. Webhook event source (§23.1). A dispatcher instance for enqueue (fan-out to the
  //     tenant's webhooks); server.ts starts a separate retry-loop instance sharing the
  //     pool. This source replaces NOOP_EVENT_SOURCE wherever job/run lifecycle events
  //     are emitted (threaded into the scheduler → executeJobRun path below).
  const webhookEnqueueDispatcher = new WebhookDispatcher({ pool, logger });
  const webhookEventSource: WebhookEventSource =
    createWebhookEventSource(webhookEnqueueDispatcher);

  // 7b. Scheduler tick loop (§17.8): a real clock + a triggerSession fn that wakes a
  //     session and dispatches its initialEvents. Fires `job.run_*` via the event source.
  const clock: Clock = opts.clock ?? { now: () => new Date() };
  const triggerSession: TriggerSessionFn = async (_ctx, sessionId, initialEvents) => {
    const rt = await sessionManager.getOrCreate(sessionId);
    for (const ev of initialEvents) {
      // Job `initialEvents` are wire-form (contracts) inbound events (§17.5); map each
      // to the ports shape the runtime consumes.
      await rt.sendEvent(inboundToPorts(ev as Parameters<typeof inboundToPorts>[0]));
    }
  };
  const scheduler = {
    pool,
    clock,
    triggerSession,
    eventSource: webhookEventSource,
    ...(opts.schedulerIntervalMs !== undefined
      ? { intervalMs: opts.schedulerIntervalMs }
      : {}),
  };

  // 7b'. Host-pool liveness monitor (R6.7, §7). Probes each host's authenticated
  //      `/healthz`; repeated failure marks the host unhealthy (out of placement
  //      rotation) and alerts through the webhook sink. Started below, stopped on
  //      the app's `onClose`.
  const livenessMonitor = hostPool
    ? new LivenessMonitor(hostPool.registry, {
        intervalMs: config.sandboxLivenessIntervalMs,
        logger,
        webhookSink: webhookEnqueueDispatcher,
        tokenSource: hostPool.tokenSource,
      })
    : undefined;

  // 7c. Webhook dispatcher retry loop (opt-in; server.ts starts it + adds pool).
  const webhookDispatcher: Omit<DispatcherOptions, "pool"> = {
    logger,
    ...opts.webhookDispatcherOptions,
  };

  // 7d. Vault re-resolution loop (§12.5): revalidate every running session's context.
  const revalidationIntervalMs =
    opts.revalidationIntervalMs ?? DEFAULT_REVALIDATION_MS;
  const revalidation =
    revalidationIntervalMs > 0
      ? {
          secretStore: secrets,
          sessionContextsProvider: () => sessionManager.runningSessionContexts(),
          intervalMs: revalidationIntervalMs,
        }
      : undefined;

  // 7e. Outcome runner (§16): produce→grade→feedback loop over the session runtime + a
  //     real grader. R6.3-wiring fix: the production grader is now constructed by DEFAULT
  //     (not only when a test injects one) — a `SubagentGrader` whose one-shot, tool-less
  //     grader `AgentSession` reuses the graded session's model + provider key
  //     (`PiGraderSessionFactory`) and reads `/mnt/session/outputs/` via the sandbox
  //     (`SandboxOutputsResolver`). Without a sandbox provider (a pure API-only test app)
  //     there is nothing to grade, so it stays unwired. A test may still override via
  //     `opts.outcomeGrader`.
  const grader: Grader | undefined =
    opts.outcomeGrader ??
    (sandboxProvider
      ? new SubagentGrader(
          new PiGraderSessionFactory({ sessions, providerKeyResolver }),
          new SandboxOutputsResolver(sandboxProvider, sandboxResolver),
        )
      : undefined);
  const outcomeRunner = grader
    ? createOutcomeRunner({
        pool,
        objectStore,
        resolveRuntime,
        grader,
      })
    : undefined;

  // Close the event-stream `user.define_outcome` path (§16.3): persist the outcome, then
  // fire the loop (not awaited — it is long-lived and records its own terminal status), the
  // same shape the REST route uses. No-op when no grader is wired.
  if (outcomeRunner) {
    const runner = outcomeRunner;
    defineOutcomeFromEvent = async (ctx, payload) => {
      const tenantCtx = { tenantId: ctx.tenantId };
      const outcome = await defineOutcome(pool, tenantCtx, ctx.sessionId, payload);
      void runner(tenantCtx, ctx.sessionId, outcome.id).catch(() => {
        /* the loop records failed/interrupted + emits the terminal event itself */
      });
    };
  }

  // 8. Delegate route mounting to createApp with the real impls.
  const app = await createApp({
    config,
    logger,
    pool,
    objectStore,
    readinessChecks: undefined, // createApp derives real probes from pool/objectStore/sandbox.
    resolveRuntime,
    getActiveRuntime,
    sessionEvents: sessionManager,
    scheduler,
    webhookDispatcher,
    ...(revalidation ? { revalidation } : {}),
    ...(outcomeRunner ? { outcomeRunner } : {}),
    ...(sandboxProvider ? { sandboxProvider } : {}),
    ...(sandboxProvider ? { sandboxResolver } : {}),
  });

  // 8b. Host-pool liveness lifecycle (R6.7): start the probe loop with the app and stop
  //     it on close (the `onClose` hook fires from `app.close()` in `close()` below).
  if (livenessMonitor) {
    livenessMonitor.start();
    app.addHook("onClose", async () => {
      livenessMonitor.stop();
    });
  }

  // 8b'. Metering aggregator loop (§11.4/§11.6, WP-C5.2). Assigns the `meteringAggregator`
  //      forward reference read by the `usage` recorder's `onMetering` hook, then starts its
  //      flush loop. Each closed bucket emits one time-bucketed export event to the billing
  //      sink AND (when billing is enabled) drains the ledger — the debits that drive
  //      suspension enforcement (§11.1) and the `tenant.balance_low` / `tenant.balance_exhausted`
  //      threshold events (§11.6). Skipped when billing is disabled AND no export sink is
  //      configured (solo/team): the recorder hook stays a no-op, no loop runs. `createApp`
  //      ran no turns before this, so no usage is dropped by the late assignment.
  if (config.billingEnabled || billingSink !== NOOP_BILLING_SINK) {
    const aggregator = createMeteringAggregator({
      pool,
      sink: billingSink,
      eventSource: webhookEventSource,
      billingEnabled: config.billingEnabled,
      lowBalanceThresholdMicros: config.billingLowBalanceThresholdMicros,
      bucketMs: config.billingMeteringBucketMs,
      ...(logger ? { logger } : {}),
    });
    meteringAggregator = aggregator;
    aggregator.start();
    app.addHook("onClose", async () => {
      // Flush the in-memory buffer on graceful shutdown, then stop the loop.
      await aggregator.flushAll().catch(() => {});
      aggregator.stop();
    });
  }

  // 8c. Sandbox reaper (ROB-3): destroy detached VMs orphaned by terminal/archived sessions
  //     and clear their handles, so a DELETE (soft-archive) or a `terminated` session never
  //     leaks its microVM + disk forever. Runs only when a sandbox provider is wired; stopped
  //     on the app's `onClose`.
  const sandboxReaperIntervalMs =
    opts.sandboxReaperIntervalMs ?? DEFAULT_SANDBOX_REAPER_MS;
  if (sandboxProvider && sandboxReaperIntervalMs > 0) {
    const reaper = startSandboxReaper({
      pool,
      sandboxProvider,
      logger,
      intervalMs: sandboxReaperIntervalMs,
    });
    app.addHook("onClose", async () => reaper.stop());
  }

  // 8d. Event-projection retention (PERF-9): prune `session_events` older than the retention
  //     window so the append-only projection can't grow without bound. Stopped on `onClose`.
  const eventsRetentionIntervalMs =
    opts.eventsRetentionIntervalMs ?? DEFAULT_EVENTS_RETENTION_INTERVAL_MS;
  const eventsRetentionMs = opts.eventsRetentionMs ?? DEFAULT_EVENTS_RETENTION_MS;
  if (eventsRetentionIntervalMs > 0 && eventsRetentionMs > 0) {
    const retention = startEventProjectionRetention({
      events,
      logger,
      intervalMs: eventsRetentionIntervalMs,
      retentionMs: eventsRetentionMs,
    });
    app.addHook("onClose", async () => retention.stop());
  }

  const close = async (): Promise<void> => {
    // Drop the process-level registrations first: they close over THIS app's session
    // registry + object store, and a second app in the same process (tests) must not
    // inherit them.
    clearToolResultSink();
    clearTenantSeedHook();
    await sessionManager.disposeAll();
    // R7.1: dispose sends each worker its per-session teardown; now stop the children.
    if (workers) await workers.shutdown();
    await app.close();
    await closePool(pool);
  };

  return {
    app,
    pool,
    objectStore,
    sandboxProvider,
    sessionManager,
    eventsStore: events,
    ...(workers ? { sessionWorkers: workers } : {}),
    ...(meteringAggregator ? { meteringAggregator } : {}),
    close,
  };
}

/** Resolve an object store from a config object (thin wrapper). */
function createObjectStoreFromConfig(cfg: ObjectStoreConfig): Promise<ObjectStore> {
  return createObjectStore(cfg);
}

// ---------------------------------------------------------------------------
// Multi-host sandbox pool (R6.7, §7.2)
// ---------------------------------------------------------------------------

/** The multi-host sandbox pool the composition root builds for `SANDBOX_MODE=multi`. */
export interface HostPool {
  /** Postgres-backed host registry (hosts + placements). */
  registry: HostRegistry;
  /** Routing provider — a drop-in {@link SandboxProvider}. */
  provider: MultiHostSandboxProvider;
  /** Per-host secret source (§6.1). Shared by the agents and the liveness probe. */
  tokenSource: HostAgentTokenSource;
}

/**
 * Build the multi-host sandbox pool from {@link Config} (R6.7, §7.2).
 *
 * Upserts every `config.sandboxHosts` entry into the `sandbox_hosts` registry (hosts may
 * also be registered out of band — the registry, not config, is the runtime source of
 * truth), then wires a {@link MultiHostSandboxProvider} whose agent factory returns an
 * authenticated {@link HttpHostAgent} per host (bearer token, plus mutual TLS when
 * `HOST_AGENT_TLS_CERT/KEY/CA` are configured, §6.1).
 *
 * **Fails closed at boot**: an empty pool, or any host with no configured secret, throws
 * (`HostAgentTokenMissingError`) rather than letting the backend come up and later talk
 * to the privileged host-agent channel unauthenticated.
 */
export async function createHostPool(config: Config, pool: Pool): Promise<HostPool> {
  const registry = new HostRegistry(pool);
  for (const host of config.sandboxHosts) {
    await registry.registerHost({
      id: host.id,
      endpoint: host.endpoint,
      cpus: host.cpus,
      memoryMiB: host.memoryMiB,
      labels: host.labels,
    });
  }

  const tokenSource = createHostAgentTokenSource(hostAgentTokenEnv(config));
  const tlsAgent = createHostAgentTlsAgent();

  const hosts = await registry.listHosts();
  if (hosts.length === 0) {
    throw new Error(
      "SANDBOX_MODE=multi but the host pool is empty: set SANDBOX_HOSTS " +
        "(JSON array of {id,endpoint,cpus,memoryMiB}) or register hosts in `sandbox_hosts`",
    );
  }
  // SEC-4: the host-agent channel is privileged (arbitrary exec, cross-tenant VM
  // enumeration) and every request carries the pool bearer secret. In multi mode it MUST be
  // https + mutual TLS, or that secret travels in cleartext. Fail the boot CLOSED unless an
  // operator has explicitly opted into the insecure transport (dev/test only) — mirroring the
  // fail-closed token posture below. Without this, an unset HOST_AGENT_TLS_* silently
  // degraded to plain `fetch` over `http://`.
  if (!config.allowInsecureHostAgent) {
    if (!tlsAgent) {
      throw new Error(
        "SANDBOX_MODE=multi requires a mutual-TLS client agent for the host-agent channel: " +
          "set HOST_AGENT_TLS_CERT / HOST_AGENT_TLS_KEY / HOST_AGENT_TLS_CA (or, for local " +
          "dev only, SANDBOX_ALLOW_INSECURE_HOST_AGENT=true). Refusing to send the pool " +
          "bearer secret over an unauthenticated transport.",
      );
    }
    const insecure = hosts.filter((h) => !h.endpoint.startsWith("https://"));
    if (insecure.length > 0) {
      throw new Error(
        "SANDBOX_MODE=multi requires https host-agent endpoints; refusing cleartext for " +
          `host(s): ${insecure.map((h) => h.id).join(", ")} ` +
          "(or set SANDBOX_ALLOW_INSECURE_HOST_AGENT=true for local dev).",
      );
    }
  }
  // Fail closed: resolve every host's secret NOW so a missing token is a boot failure,
  // not a first-provision failure. Throws HostAgentTokenMissingError (no secret in text).
  for (const host of hosts) tokenSource(host);

  const agentFactory = (host: SandboxHost): HostAgent =>
    new HttpHostAgent(host.id, host.endpoint, {
      token: tokenSource(host),
      ...(tlsAgent ? { tlsAgent } : {}),
    });

  return {
    registry,
    tokenSource,
    provider: new MultiHostSandboxProvider({ registry, agentFactory }),
  };
}

/** Collaborators for the boot-time VM re-attach step (R2.9). */
export interface ReattachSurvivingSandboxesDeps {
  pool: Pool;
  sandboxProvider: SandboxProvider;
  sessions: SessionStore;
  logger: Logger;
  /** This instance's ownership id for the boot status reset (ROB-13). */
  instanceId: string;
  /** Ownership lease window (ms): a row untouched longer than this is reclaimable (ROB-13). */
  instanceLeaseMs: number;
}

/**
 * Boot-time recovery (R2.9): for every resumable session, rediscover a surviving detached
 * VM (by tenant/session labels) and reconcile its handle onto the row when the stored
 * handle is missing or stale. Idempotent and non-fatal — every failure is logged and
 * swallowed so a recovery hiccup never blocks boot. Does NOT wake any session; the
 * reconciled handle is picked up lazily by the next `getOrCreate` → `ensureSandboxRunning`.
 */
export async function reattachSurvivingSandboxes(
  deps: ReattachSurvivingSandboxesDeps,
): Promise<void> {
  const { pool, sandboxProvider, sessions, logger, instanceId, instanceLeaseMs } = deps;

  let rows;
  try {
    rows = await listResumableSessions(pool);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "boot re-attach: failed to list resumable sessions",
    );
    return;
  }
  if (rows.length === 0) return;

  // Re-attach once per tenant (a tenant-scoped label query rediscovers all its VMs).
  const handlesByTenant = new Map<string, SandboxHandle[]>();
  for (const tenant of new Set(rows.map((r) => r.tenant_id))) {
    try {
      handlesByTenant.set(
        tenant,
        await sandboxProvider.reattachByLabels({ tenant }),
      );
    } catch (err) {
      logger.warn(
        { tenant, err: (err as Error).message },
        "boot re-attach: reattachByLabels failed for tenant",
      );
    }
  }

  let reconciled = 0;
  for (const row of rows) {
    const match = handlesByTenant
      .get(row.tenant_id)
      ?.find((h) => h.labels.session === row.id);
    if (!match) continue; // no surviving VM for this session
    if (row.sandbox_handle === match.name) continue; // stored handle already current
    try {
      await sessions.saveSandboxHandle(row.id, match);
      reconciled += 1;
    } catch (err) {
      logger.warn(
        { sessionId: row.id, err: (err as Error).message },
        "boot re-attach: failed to reconcile sandbox handle",
      );
    }
  }
  if (reconciled > 0) {
    logger.info({ reconciled }, "boot re-attach: reconciled surviving sandbox handles");
  }

  // R2.8 fix: reconcile stale runtime status AFTER the handle re-attach above (which needs
  // the `running`/`rescheduling` rows to still carry that status — `listResumableSessions`
  // keys on it). A `kill -9` mid-turn leaves the row at `running`; nothing is driving the
  // session after a restart, so `GET /v1/sessions/:id` would otherwise report "running" for
  // a session that is really awaiting input, and `session_not_idle` guards would spuriously
  // reject. No turn survives a process death, so any such row is truthfully `idle`.
  // (Archived / terminated rows are untouched; the re-attached handle is retained.)
  //
  // ROB-13: scope the reset to rows THIS instance may own — ones it previously claimed
  // (`owner_instance_id = $1`), ones with no owner, or ones whose ownership lease has expired
  // (untouched past `instanceLeaseMs`, i.e. abandoned by a dead instance). A peer instance's
  // freshly-updated `running` rows are left alone, so a second instance can never flip a live
  // instance's sessions to idle. SINGLE-WRITER ASSUMPTION: distinct `INSTANCE_ID` per instance
  // (see config). The reset also stamps `owner_instance_id`, claiming the reset rows.
  try {
    const { rowCount } = await pool.query(
      `UPDATE sessions
          SET status = 'idle', stop_reason = NULL, owner_instance_id = $1
        WHERE status IN ('running', 'rescheduling')
          AND (owner_instance_id IS NULL
               OR owner_instance_id = $1
               OR updated_at < now() - ($2::double precision * interval '1 millisecond'))`,
      [instanceId, instanceLeaseMs],
    );
    if (rowCount && rowCount > 0) {
      logger.info(
        { reconciled: rowCount, instanceId },
        "boot recovery: reset stale running sessions to idle",
      );
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "boot recovery: failed to reconcile stale session status",
    );
  }
}

// ---------------------------------------------------------------------------
// Sandbox reaper (ROB-3)
// ---------------------------------------------------------------------------

/** Collaborators for the background sandbox reaper (ROB-3). */
export interface SandboxReaperDeps {
  pool: Pool;
  sandboxProvider: SandboxProvider;
  logger: Logger;
  /** Poll interval (ms). */
  intervalMs: number;
  /** Max sessions reaped per pass. Defaults to {@link DEFAULT_SANDBOX_REAPER_BATCH}. */
  batchSize?: number;
}

/** Handle for the background sandbox reaper (ROB-3). */
export interface SandboxReaperHandle {
  /** Stop the interval. */
  stop(): void;
  /** Run one reap pass now (exposed for tests). Returns the number of VMs destroyed. */
  reapOnce(): Promise<number>;
}

/**
 * Start the sandbox reaper (ROB-3). Each pass lists a batch of terminal/archived sessions
 * that still own a sandbox handle, calls `SandboxProvider.destroy()` on each (which stops +
 * removes the microVM and prunes its checkpoints/snapshots), then clears the handle. Every
 * item is best-effort and isolated: one failed destroy is logged and does not abort the pass
 * (the row is retried next interval). The timer is `unref`'d so it never keeps the process
 * alive on its own.
 */
export function startSandboxReaper(deps: SandboxReaperDeps): SandboxReaperHandle {
  const { pool, sandboxProvider, logger, intervalMs } = deps;
  const batchSize = deps.batchSize ?? DEFAULT_SANDBOX_REAPER_BATCH;

  const reapOnce = async (): Promise<number> => {
    let rows;
    try {
      rows = await listReapableSandboxSessions(pool, batchSize);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "sandbox reaper: failed to list reapable sessions",
      );
      return 0;
    }
    let destroyed = 0;
    for (const row of rows) {
      const handle: SandboxHandle = {
        id: row.sandbox_handle,
        name: row.sandbox_handle,
        labels: { tenant: row.tenant_id, session: row.id },
      };
      try {
        await sandboxProvider.destroy(handle);
        await clearReapedSandboxHandle(pool, row.id);
        destroyed += 1;
      } catch (err) {
        logger.warn(
          { sessionId: row.id, err: (err as Error).message },
          "sandbox reaper: failed to destroy orphaned sandbox",
        );
      }
    }
    if (destroyed > 0) {
      logger.info({ destroyed }, "sandbox reaper: destroyed orphaned session sandboxes");
    }
    return destroyed;
  };

  const timer = setInterval(() => {
    void reapOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    reapOnce,
  };
}

// ---------------------------------------------------------------------------
// Event-projection retention (PERF-9)
// ---------------------------------------------------------------------------

/** Collaborators for the background event-projection retention loop (PERF-9). */
export interface EventProjectionRetentionDeps {
  events: SessionEventsStore;
  logger: Logger;
  /** Sweep interval (ms). */
  intervalMs: number;
  /** Age (ms) past which a `session_events` row is pruned. */
  retentionMs: number;
}

/** Handle for the background event-projection retention loop (PERF-9). */
export interface EventProjectionRetentionHandle {
  stop(): void;
  /** Run one prune pass now (exposed for tests). Returns the number of rows pruned. */
  pruneOnce(): Promise<number>;
}

/**
 * Start the event-projection retention loop (PERF-9). Each pass deletes `session_events` rows
 * older than `retentionMs`, bounding the otherwise unbounded append-only projection. Non-fatal:
 * a failed pass is logged and retried next interval. The timer is `unref`'d.
 */
export function startEventProjectionRetention(
  deps: EventProjectionRetentionDeps,
): EventProjectionRetentionHandle {
  const { events, logger, intervalMs, retentionMs } = deps;

  const pruneOnce = async (): Promise<number> => {
    try {
      const cutoff = new Date(Date.now() - retentionMs);
      const deleted = await events.deleteOlderThan(cutoff);
      if (deleted > 0) {
        logger.info({ deleted }, "event projection retention: pruned old session_events");
      }
      return deleted;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "event projection retention: prune pass failed",
      );
      return 0;
    }
  };

  const timer = setInterval(() => {
    void pruneOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    pruneOnce,
  };
}

// ---------------------------------------------------------------------------
// Boot entrypoint
// ---------------------------------------------------------------------------

/**
 * Load config, build the composed app, run migrations, and bind the port.
 * Registers SIGINT/SIGTERM handlers for graceful shutdown (stop runtimes,
 * close the pool, flush telemetry). Resolves with the bound URL.
 *
 * `telemetry` is the handle from `initTelemetry(config)`, which the caller must
 * initialize BEFORE composing the app (spans/metrics are no-ops until a provider
 * is registered). It is flushed on shutdown so buffered spans are not dropped.
 */
export async function startManagedServer(
  config: Config,
  logger: Logger,
  telemetry?: TelemetryHandle,
): Promise<{ url: string; close: () => Promise<void> }> {
  const managed = await createManagedApp({ config, logger });
  const { url } = await startServer(managed.app, config);
  logger.info({ port: config.port }, "pi-managed backend listening");

  const flushTelemetry = async (): Promise<void> => {
    if (!telemetry) return;
    try {
      await telemetry.shutdown();
    } catch (err) {
      // Best-effort: never fail shutdown on a telemetry flush.
      logger.warn({ err: (err as Error).message }, "telemetry flush failed");
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await managed.close();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "shutdown error");
      await flushTelemetry();
      process.exit(1);
    }
    await flushTelemetry();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return {
    url,
    close: async () => {
      await managed.close();
      await flushTelemetry();
    },
  };
}
