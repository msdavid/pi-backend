/**
 * `ManagedSessionRuntime` — the Harness (WP-1.5, §5.2, §5.4).
 *
 * One in-process instance per active managed session. Wraps a Pi `AgentSession` (via the
 * injected {@link AgentSessionFactory}) bound to a durable JSONL log, plus the sandbox
 * lifecycle, usage/budget enforcement, idle policy, crash recovery, and JSONL sync.
 *
 * Implements {@link SessionRuntime} (ports.ts):
 * - `wake(sessionId)` — load the `SessionRecord`, ensure the sandbox is running
 *   (start/re-provision on crash), build the `AgentSession` bound to the existing JSONL,
 *   wire event mapping + usage/budget, seed the JSONL etag, start crash-recovery polling.
 * - `sendEvent(event)` — map `user.*` / `system.*` inbound events to `prompt()` / `steer()`.
 * - `subscribe()` — map Pi `AgentSessionEvent`s → `session.*` / `agent.*` / `span.*` outbound.
 * - `interrupt()` — `abort()` the current turn.
 * - `getEntries(range)` — positional slice of the JSONL tree.
 * - `status()` — the state machine.
 *
 * Crash recovery = destroy the runtime, then `wake()` again from the JSONL (§5.2).
 */

import { existsSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EntryRange,
  InboundEvent,
  ObjectStore,
  OutboundEvent,
  ProviderKeyResolver,
  SandboxHandle,
  SessionContext,
  SandboxProvider,
  SecretStore,
  SessionEntry,
  SessionId,
  SessionRuntime,
  SessionStatus,
  TokenCounts,
  UsageRecorder,
} from "../ports.js";
import type { MemoryStore, StopReason } from "@pi-managed/contracts";
import { enforceBudget } from "../usage/budget.js";
import { compileProvisionSpec, mergeVolumeMounts } from "../environment/compile-spec.js";
import { mountMemoryStores, systemPromptNotes } from "../memory/mount.js";
import { materializeToolset } from "../toolset/index.js";
import { CrashRecovery } from "./crash-recovery.js";
import { IdlePolicy, idleTimeoutMsFromEnv } from "./idle-policy.js";
import { JsonlSync } from "./jsonl-sync.js";
import {
  defaultRemoteToolFactories,
  disableUserBashExtension,
  guestCwd,
  toCustomToolDefinitions,
} from "./sandbox-toolset.js";
import { SessionStateMachine } from "./state-machine.js";
import type { RemoteToolFactories } from "./operations/tool-factory.js";
import type { WebToolsOptions } from "./operations/web-tools.js";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { ConfirmationCoordinator } from "../../pi-extensions/permission-gate/confirmation.js";
import { createPermissionGate } from "../../pi-extensions/permission-gate/index.js";
import { snapshotToolsetConfig } from "../../pi-extensions/permission-gate/policy.js";
import { CustomToolCoordinator } from "../../pi-extensions/custom-tools/relay.js";
import { createCustomToolsRelay } from "../../pi-extensions/custom-tools/index.js";
import tasksExtension from "../../pi-extensions/tasks/index.js";
import goalsExtension from "../../pi-extensions/goals/index.js";
import { createMcpBridge } from "../../pi-extensions/mcp-bridge/index.js";
import { McpFailureTracker } from "../mcp/failures.js";
import type { McpCredentialResolver } from "../mcp/proxy.js";
import type {
  AgentSessionLike,
  MemoryMountService,
  ResolvedAgentMaterial,
  SelfHostedChannelFactory,
  SessionRecord,
  SessionStore,
  SkillMaterializer,
} from "./types.js";
import type { AgentSessionFactory } from "./types.js";
import type { SessionEventsStore } from "./session-events-store.js";
import { OutboundEventStream } from "./outbound-stream.js";
import { SessionMemoryVolumes } from "./session-memory-volumes.js";
import {
  delay,
  isTransient,
  toSessionEntry,
  readAllBytes,
  customToolDeclarationsFor,
} from "./runtime-helpers.js";
import { TurnSpanTracker } from "./runtime-telemetry.js";
import { DurableUsageRecorder } from "./runtime-usage.js";
import {
  recordSessionActive,
  SpanAttrs,
  SpanNames,
  withSpan,
} from "../../infra/telemetry/conventions.js";

/**
 * Default per-subscriber outbound bound (R4.3). Overridable per runtime
 * ({@link ManagedSessionRuntimeOptions.maxOutboundEvents}) or globally via
 * `PI_MAX_OUTBOUND_EVENTS`. Past the bound the OLDEST events are dropped and the
 * subscriber is told exactly where its gap starts (see {@link STREAM_LAGGED}).
 */
export const MAX_OUTBOUND = 1000;

/** The per-subscriber outbound bound from the environment, or {@link MAX_OUTBOUND}. */
export function maxOutboundFromEnv(): number {
  const raw = process.env.PI_MAX_OUTBOUND_EVENTS;
  if (!raw) return MAX_OUTBOUND;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : MAX_OUTBOUND;
}


/** Options to construct a {@link ManagedSessionRuntime}. */
export interface ManagedSessionRuntimeOptions {
  sandbox: SandboxProvider;
  objects: ObjectStore;
  usage: UsageRecorder;
  secrets: SecretStore;
  sessions: SessionStore;
  factory: AgentSessionFactory;
  /**
   * Resolves the session's model-provider API keys host-side at wake (§4.2 / R2.7).
   * When omitted, the material's existing `providerKeys` are used as-is (test seam).
   */
  providerKeyResolver?: ProviderKeyResolver;
  /**
   * Pi `createXTool` factories bound to the sandbox at wake (§10.2). Defaults to the
   * real SDK factories ({@link defaultRemoteToolFactories}).
   */
  toolFactories?: RemoteToolFactories;
  /** Options for the backend-hosted web tools (search provider, DNS resolver). */
  webToolsOptions?: WebToolsOptions;
  /**
   * Host-side MCP credential resolver (§25.3). When present AND the agent declares
   * `mcpServers`, the mcp-bridge extension is loaded so the model can call MCP tools
   * with the token injected host-side (never in the guest). Omitted ⇒ no mcp-bridge.
   */
  mcpCredentialResolver?: McpCredentialResolver;
  /**
   * Handler for an inbound `user.define_outcome` event (§16.3). Invoked with the session's
   * identity + the event payload; the composition root wires it to define + run the outcome
   * loop. Omitted ⇒ `define_outcome` over the event stream is a no-op (the Outcomes API
   * route is the primary path).
   */
  onDefineOutcome?: (
    ctx: { tenantId: string; sessionId: string },
    payload: unknown,
  ) => Promise<void>;
  /**
   * Append-only event projection (R4.1, §9.3). When present, every outbound event emitted
   * during a turn is also persisted here so history/replay serve the SAME numbered stream
   * the live path streams, and the live SSE `id` IS the persisted position (R4.2).
   * Omitted ⇒ persistence is skipped (test seam / sandbox-disabled).
   */
  events?: SessionEventsStore;
  /**
   * Per-subscriber outbound bound (R4.3). Defaults to {@link maxOutboundFromEnv}
   * (`PI_MAX_OUTBOUND_EVENTS`, else {@link MAX_OUTBOUND}). A subscriber that overflows has
   * its oldest events dropped and receives a `session.stream_lagged` notice.
   */
  maxOutboundEvents?: number;
  /**
   * Memory mounts (R6.5a, §13.1–13.3). When present, the session's referenced memory
   * stores are resolved BEFORE provision, compiled into the `ProvisionSpec`'s volumes
   * (`read_only` ⇒ a read-only mount), staged after provision, and written back on every
   * idle transition. Omitted ⇒ no memory is mounted (test seam / self-hosted).
   */
  memory?: MemoryMountService;
  /**
   * Skill materialization (R6.5b, §20.3/§20.4). When present, the agent's `skills[]` are
   * staged under `<sessionDir>/.pi/skills` at wake and handed to Pi's resource loader, so
   * progressive disclosure works. Omitted ⇒ no managed skills.
   */
  skills?: SkillMaterializer;
  /**
   * Self-hosted execution (R6.6, §10.4). Required for a `self_hosted` environment: the
   * runtime provisions NO cloud microVM and binds its toolset to the returned channel,
   * which enqueues each tool execution onto the subscriber's work queue and awaits the
   * worker's posted `user.tool_result`.
   */
  selfHosted?: SelfHostedChannelFactory;
}

/** Flags accumulated during a turn (read after `prompt()` resolves). */
interface TurnFlags {
  budgetBreached: boolean;
  interrupted: boolean;
  requiresAction: boolean;
  blockingEventIds: string[];
}

/**
 * The session runtime. Construct per active session; `wake()` before `sendEvent`.
 */
export class ManagedSessionRuntime implements SessionRuntime {
  private readonly sandbox: SandboxProvider;
  private readonly objects: ObjectStore;
  private readonly usage: UsageRecorder;
  /**
   * Durable, dedup'd usage recording (ROB-7 / ROB-14). Wraps {@link usage} so each model
   * request is billed exactly once (keyed by its idempotency key) and a transient
   * `record()` failure is retried + awaited at settlement rather than silently dropped.
   */
  private readonly durableUsage: DurableUsageRecorder;
  private readonly secrets: SecretStore;
  private readonly sessions: SessionStore;
  private readonly factory: AgentSessionFactory;
  private readonly providerKeyResolver: ProviderKeyResolver | undefined;
  private readonly toolFactories: RemoteToolFactories;
  private readonly webToolsOptions: WebToolsOptions | undefined;
  private readonly mcpCredentialResolver: McpCredentialResolver | undefined;
  private readonly onDefineOutcome:
    | ((
        ctx: { tenantId: string; sessionId: string },
        payload: unknown,
      ) => Promise<void>)
    | undefined;
  private readonly events: SessionEventsStore | undefined;
  private readonly memory: MemoryMountService | undefined;
  private readonly skills: SkillMaterializer | undefined;
  private readonly selfHostedFactory: SelfHostedChannelFactory | undefined;
  /**
   * The outbound event stream (R4.1–R4.3): DB-authoritative positions, per-subscriber
   * fan-out, bounded backpressure. Bound to the session's projection + record at wake.
   */
  private readonly outbound: OutboundEventStream;

  /**
   * The provider every tool + lifecycle call is bound to (R6.6). The cloud
   * {@link sandbox} for a `cloud` environment; the {@link SelfHostedToolChannel} (which
   * executes on the subscriber's worker via the work queue) for a `self_hosted` one.
   * Chosen at wake, before provision.
   */
  private exec: SandboxProvider;
  /** The memory stores mounted into this session (R6.5a). Resolved at wake. */
  private memoryStores: MemoryStore[] = [];

  // -- Inbound round-trip coordinators (§9.4 / §9.5, R2.5 / R2.6) -------------
  /** Gates `always_ask` tool calls behind `user.tool_confirmation` (permission-gate). */
  private readonly confirmation: ConfirmationCoordinator;
  /** Relays client-executed custom tools behind `user.custom_tool_result`. */
  private readonly customToolRelay: CustomToolCoordinator;
  /** Per-session MCP failure tracker (idle→running retry, §19.6). */
  private readonly mcpFailureTracker = new McpFailureTracker();
  /**
   * Generic pending self-hosted tool results (§9.2 `user.tool_result`). Populated by a
   * self-hosted tool execution awaiting the worker's result; resolved by the inbound
   * `user.tool_result` router. (Self-hosted execution wiring is R6.6 — this is the seam.)
   */
  private readonly pendingToolResults = new Map<
    string,
    (result: { result: string; isError: boolean }) => void
  >();
  /**
   * Worker-posted `user.tool_result`s that arrived with NO pending resolver yet (ROB-10):
   * posted before the exec registered, re-delivered, or drained from the work item on wake.
   * Buffered (not dropped) so the awaiting tool call picks it up when it registers — keyed by
   * `toolUseId`.
   */
  private readonly bufferedToolResults = new Map<
    string,
    { result: string; isError: boolean }
  >();
  /**
   * The still-pending `prompt()` when a turn returned `requires_action` (a tool call is
   * blocked awaiting operator input). Resumed to settlement once every block clears.
   */
  private pendingPrompt: Promise<void> | undefined;
  /** Resolver that makes {@link driveTurn} return `requires_action` (set per drive). */
  private requiresActionWaiter: (() => void) | null = null;

  private readonly sm = new SessionStateMachine();
  private idle: IdlePolicy;
  private crash: CrashRecovery;
  private jsonl: JsonlSync;

  private session: AgentSessionLike | undefined;
  private record: SessionRecord | undefined;
  private handle: SandboxHandle | undefined;
  private provisionSpec: ReturnType<typeof compileProvisionSpec> | undefined;

  // -- Telemetry (WP-8.1) ----------------------------------------------------
  /**
   * Per-turn OTEL span tracker (model-request + tool spans nested under the turn span).
   * The runtime sets the turn span at the top of each turn and forwards Pi lifecycle
   * events; the tracker owns the span state (see runtime-telemetry.ts).
   */
  private readonly spans: TurnSpanTracker;
  /** Guards the `pi.sessions.active` UpDownCounter against an unbalanced ±1. */
  private sessionCounted = false;

  constructor(opts: ManagedSessionRuntimeOptions) {
    this.sandbox = opts.sandbox;
    this.objects = opts.objects;
    this.usage = opts.usage;
    this.durableUsage = new DurableUsageRecorder(opts.usage);
    this.secrets = opts.secrets;
    this.sessions = opts.sessions;
    this.factory = opts.factory;
    this.providerKeyResolver = opts.providerKeyResolver;
    this.toolFactories = opts.toolFactories ?? defaultRemoteToolFactories;
    this.webToolsOptions = opts.webToolsOptions;
    this.mcpCredentialResolver = opts.mcpCredentialResolver;
    this.onDefineOutcome = opts.onDefineOutcome;
    this.events = opts.events;
    this.memory = opts.memory;
    this.skills = opts.skills;
    this.selfHostedFactory = opts.selfHosted;
    this.exec = opts.sandbox;
    this.outbound = new OutboundEventStream(
      opts.maxOutboundEvents ?? maxOutboundFromEnv(),
    );
    this.spans = new TurnSpanTracker(() => this.sessionAttrs());

    // The confirmation + custom-tool coordinators bridge the Pi extension hooks to the
    // runtime's outbound queue + turn driver. When either blocks a tool call awaiting
    // operator input, `onCoordinatorBlock` flips the turn to `requires_action` (R2.6).
    const onBlock = (ids: readonly string[]): void => this.onCoordinatorBlock(ids);
    this.confirmation = new ConfirmationCoordinator({
      emitStatusIdleRequiresAction: onBlock,
    });
    this.customToolRelay = new CustomToolCoordinator({
      emitCustomToolUse: (use) =>
        this.outbound.emit("agent.custom_tool_use", {
          customToolUseId: use.customToolUseId,
          toolName: use.toolName,
          input: use.input,
        }),
      emitStatusIdleRequiresAction: onBlock,
    });

    this.idle = new IdlePolicy(this.sandbox);
    this.crash = new CrashRecovery(this.sandbox);
    this.jsonl = new JsonlSync(this.objects, this.sessions);
  }

  // -- SessionRuntime -------------------------------------------------------

  /**
   * `pi.session.wake` (WP-8.1). A thin observational wrapper: {@link wakeInner} is the
   * unchanged wake path, and `withSpan` re-throws whatever it throws, so a failed wake
   * fails exactly as before (with an error span recorded).
   */
  async wake(sessionId: SessionId): Promise<void> {
    return withSpan(SpanNames.SESSION_WAKE, async (span) => {
      span.setAttribute(SpanAttrs.SESSION_ID, sessionId);
      await this.wakeInner(sessionId);
      if (this.record) {
        span.setAttribute(SpanAttrs.TENANT_ID, this.record.tenantId);
      }
      if (this.handle) {
        span.setAttribute(SpanAttrs.SANDBOX_ID, this.handle.id);
      }
      // Only a wake that got all the way here counts as an active session; the -1 is
      // in `dispose()`, and `sessionCounted` keeps the pair balanced.
      if (!this.sessionCounted) {
        this.sessionCounted = true;
        recordSessionActive(1, this.sessionAttrs());
      }
    });
  }

  private async wakeInner(sessionId: SessionId): Promise<void> {
    const record = await this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`ManagedSessionRuntime.wake: session not found: ${sessionId}`);
    }
    this.record = record;

    // 0. Bind the outbound stream to this session's projection + record. Every emitted
    //    event takes the position its projection append returns, so the live SSE `id` and
    //    the replayed history `id` are the same number by construction (R4.1/R4.2, §9.3) —
    //    no seeded counter to diverge from the persisted positions on a re-wake.
    this.outbound.bind(this.events, record);

    // 0b. Choose the execution provider BEFORE anything binds to it (R6.6, §10.4). A
    //     `self_hosted` environment provisions NO cloud microVM: tools run on the
    //     subscriber's worker, reached through the work queue. Everything above this seam
    //     (toolset, wake lifecycle, idle policy, crash recovery) is unchanged.
    this.exec = this.selectExecutionProvider(record);

    // 1. Compile the provision spec, then merge the session's memory volumes into it
    //    (R6.5a, §13.2/§13.3) — memory MUST be resolved before provision, because a
    //    `read_only` store has to become a read-only bind mount (an agent then cannot
    //    write to it regardless of its tools).
    this.provisionSpec = compileProvisionSpec(record.environment, {
      tenantId: record.tenantId,
      sessionId: record.sessionId,
    });
    this.memoryStores = await this.resolveMemoryStores(record);
    if (this.memoryStores.length > 0) {
      const volumes = mergeVolumeMounts(
        this.provisionSpec.volumes,
        mountMemoryStores({ tenantId: record.tenantId }, this.memoryStores),
      );
      this.provisionSpec = { ...this.provisionSpec, volumes };
    }

    // ROB-2: bake the session's secret bindings into `this.provisionSpec` BEFORE any
    // provision, so EVERY provision path — first wake, the crashed-status re-provision in
    // `ensureSandboxRunning`, AND crash-recovery (which provisions from this exact spec) —
    // creates the VM with its `$MSB_*` secrets. Previously bindings were merged into a LOCAL
    // spec only on first wake, so both re-provision paths dropped them. Re-resolving on each
    // wake also revalidates the vault (§12.5).
    const secretBindings = await this.resolveSecretBindings(record);
    this.provisionSpec = { ...this.provisionSpec, secretBindings };

    const ensured = await this.ensureSandboxRunning(record);
    this.handle = ensured.handle;
    // R2.8: persist the handle whenever a NEW VM was provisioned (first-wake or
    // crash-reprovision) so a restart re-attaches the detached VM instead of orphaning
    // it. Re-attaching the SAME surviving VM writes nothing.
    if (ensured.isNew) await this.persistSandboxHandle(ensured.handle);

    // 1a. Stage each mounted memory store's live memories into its volume (R6.5a, §13.1)
    //     — the agent must see the store's CURRENT contents at `/mnt/memory/<slug>/`.
    //     Read-only stores are staged identically (the enforcement is at the mount).
    await this.stageMemoryVolumes();

    // 1b. Augment the material now that the LIVE sandbox handle + cwd exist (R2.1). The
    // sandbox tools bind THIS provider+handle+cwd (they cannot be built at db-session-store
    // .get() time — the handle doesn't exist yet). Provider keys are resolved host-side
    // from the vault (§4.2 / R2.7); the `user_bash` host-shell lockout is loaded here.
    record.material = await this.augmentMaterial(record);

    // 1c. Download-on-cold-wake (R2.10c): if the local JSONL is absent (cold start on a
    // fresh host), restore it from the object store BEFORE the factory opens it — else Pi
    // creates an EMPTY session and the next sync overwrites the good object-store copy.
    await this.restoreLocalJsonlIfAbsent(record);

    // 2. Build the AgentSession bound to the existing JSONL.
    this.session = await this.factory.create({
      material: record.material,
      localJsonlPath: record.localJsonlPath,
    });

    // 3. Wire event mapping + usage/budget enforcement.
    this.session.subscribe((event) => this.onPiEvent(event));

    // 4. JSONL sync: seed etag + start the periodic sync (30s while running, R2.10a).
    this.jsonl.seedEtag(record.lastSyncedEtag);
    this.jsonl.startPeriodic(
      record.sessionId,
      record.localJsonlPath,
      record.objectStoreKey,
    );

    // 5. Crash-recovery polling.
    this.crash.start(
      {
        handle: this.handle,
        provisionSpec: this.provisionSpec,
      },
      (newHandle) => {
        // A crash mid-run re-provisioned a fresh VM — persist the new handle (R2.8).
        this.handle = newHandle;
        void this.persistSandboxHandle(newHandle);
      },
    );

    // ROB-10: replay any worker-posted tool results that landed while this session had no
    // live runtime here (evicted, or delivered to another node). They are buffered until the
    // (re-)awaiting tool call registers its resolver, so the round trip is not stranded in
    // the work item's `results` column.
    await this.drainSelfHostedResults();

    this.sm.complete("completed"); // idle, ready for input
    await this.persistStatus();
  }

  /**
   * Drain the self-hosted work item's posted `user.tool_result`s into this runtime (ROB-10).
   * A no-op for a cloud session (the exec provider exposes no `drainPostedResults`). Best-
   * effort: a read failure must not fail the wake.
   */
  private async drainSelfHostedResults(): Promise<void> {
    const channel = this.exec as {
      drainPostedResults?: () => Promise<
        Array<{ toolUseId: string; result: string; isError: boolean }>
      >;
    };
    if (typeof channel.drainPostedResults !== "function") return;
    try {
      const posted = await channel.drainPostedResults();
      for (const r of posted) {
        await this.handleToolResult({
          type: "user.tool_result",
          payload: { toolUseId: r.toolUseId, result: r.result, isError: r.isError },
        } as unknown as InboundEvent);
      }
    } catch {
      /* best-effort: a work-queue read failure must not crash the wake */
    }
  }

  async sendEvent(event: InboundEvent): Promise<void> {
    if (!this.session || !this.record || !this.handle) {
      throw new Error("ManagedSessionRuntime.sendEvent: session not awake");
    }
    switch (event.type) {
      case "user.message":
        return this.handleUserMessage(event);
      case "user.interrupt":
        return this.handleUserInterrupt();
      case "system.message":
        return this.handleSystemMessage(event);
      case "user.tool_confirmation":
        return this.handleToolConfirmation(event);
      case "user.custom_tool_result":
        return this.handleCustomToolResult(event);
      case "user.tool_result":
        return this.handleToolResult(event);
      case "user.define_outcome":
        return this.handleDefineOutcome(event);
      default:
        return;
    }
  }

  /**
   * Subscribe to this session's outbound events (R4.2 — broadcast, not a shared queue).
   * Delegated to the {@link OutboundEventStream}: every call gets its own subscriber, so N
   * concurrent SSE clients each receive EVERY event.
   */
  subscribe(): AsyncIterable<OutboundEvent> {
    return this.outbound.subscribe();
  }

  async interrupt(): Promise<void> {
    if (this.session) await this.session.abort();
    // Resolve any blocked tool calls as denied so a paused turn does not leak (§9.5).
    this.confirmation.abortAll("Session interrupted");
    this.customToolRelay.abortAll("Session interrupted");
    this.pendingPrompt = undefined;
    this.sm.interrupt();
    await this.onTurnSettled("user_interrupt");
  }

  async getEntries(range?: EntryRange): Promise<SessionEntry[]> {
    if (!this.session) return [];
    const all = this.session.getEntries();
    let start = range?.start ?? 0;
    let end = range?.end ?? all.length;
    if (start < 0) start = 0;
    if (end > all.length) end = all.length;
    let slice = all.slice(start, end);
    if (range?.limit !== undefined) slice = slice.slice(0, range.limit);
    return slice.map((e, i) => toSessionEntry(e, start + i));
  }

  status(): SessionStatus {
    return this.sm.status;
  }

  /** Test/teardown accessor: the bound sandbox handle. */
  get sandboxHandle(): SandboxHandle | undefined {
    return this.handle;
  }

  /** @internal test seam: the idle-policy loop. */
  get idlePolicy(): IdlePolicy {
    return this.idle;
  }

  /** @internal test seam: the crash-recovery poller. */
  get crashRecovery(): CrashRecovery {
    return this.crash;
  }

  /** @internal test seam: the JSONL sync coordinator. */
  get jsonlSync(): JsonlSync {
    return this.jsonl;
  }

  /** @internal test seam: the compiled sandbox provision spec. */
  get currentProvisionSpec(): ReturnType<typeof compileProvisionSpec> | undefined {
    return this.provisionSpec;
  }

  /**
   * @internal test seam: the provider every tool executes against (R6.6) — the cloud
   * sandbox, or the self-hosted work-queue channel. This is the exact object the
   * materialized toolset is bound to.
   */
  get executionProvider(): SandboxProvider {
    return this.exec;
  }

  /** @internal test seam: the memory stores mounted into this session (R6.5a). */
  get mountedMemoryStores(): readonly MemoryStore[] {
    return this.memoryStores;
  }

  /** @internal test seam: the permission-gate confirmation coordinator (§9.5). */
  get confirmationCoordinator(): ConfirmationCoordinator {
    return this.confirmation;
  }

  /** @internal test seam: the custom-tool relay coordinator (§9.4). */
  get customToolCoordinator(): CustomToolCoordinator {
    return this.customToolRelay;
  }

  /**
   * The running session's re-resolution context (tenant + session + vault ids), or
   * `undefined` before `wake()`. Consumed by the vault revalidation loop (§12.5).
   */
  get sessionContext(): SessionContext | undefined {
    if (!this.record) return undefined;
    return {
      tenantId: this.record.tenantId,
      sessionId: this.record.sessionId,
      vaultIds: this.record.vaultIds,
    };
  }

  /** The `session.id` / `tenant.id` attribute pair for this runtime's telemetry. */
  private sessionAttrs(): Record<string, string> {
    if (!this.record) return {};
    return {
      [SpanAttrs.SESSION_ID]: this.record.sessionId,
      [SpanAttrs.TENANT_ID]: this.record.tenantId,
    };
  }

  /** Dispose all collaborators (timers, listeners). Call on runtime teardown. */
  dispose(): void {
    if (this.sessionCounted) {
      this.sessionCounted = false;
      recordSessionActive(-1, this.sessionAttrs());
    }
    this.spans.endAll();
    this.confirmation.abortAll("Session disposed");
    this.customToolRelay.abortAll("Session disposed");
    this.pendingPrompt = undefined;
    this.idle.dispose();
    this.crash.stop();
    this.jsonl.stopPeriodic();
    // End every live subscriber (R4.2): each drains what it already has, then its iterator
    // returns.
    this.outbound.disposeSubscribers();
    const agentDir = this.session?.agentDir;
    this.session?.dispose();
    // Remove the per-session temp agent dir the factory created (`mkdtemp`) so a wake does
    // not leak a directory per session over the process lifetime.
    if (agentDir) {
      try {
        rmSync(agentDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // -- inbound handlers -----------------------------------------------------

  /**
   * `pi.session.turn` (WP-8.1) — the full inbound turn (user.message → settled idle).
   * The model-request and tool spans emitted from the Pi event callbacks nest under it
   * via {@link turnCtx}. Observational only: {@link handleUserMessageInner} is the
   * unchanged turn path.
   */
  private async handleUserMessage(event: InboundEvent): Promise<void> {
    return withSpan(SpanNames.SESSION_TURN, async (span) => {
      span.setAttributes(this.sessionAttrs());
      this.spans.setTurnSpan(span);
      try {
        await this.handleUserMessageInner(event);
        // The state machine holds the settled stop reason by now (`onTurnSettled`).
        const stopReason = this.sm.stopReason;
        if (stopReason) span.setAttribute(SpanAttrs.STOP_REASON, stopReason);
      } finally {
        // A turn that ended without its `turn_end` / `tool_execution_end` (interrupt,
        // terminal error, requires_action) must not leak open spans into the next turn.
        this.spans.endAll();
      }
    });
  }

  private async handleUserMessageInner(event: InboundEvent): Promise<void> {
    const content = String((event.payload as { content?: unknown }).content ?? "");
    const session = this.session!;
    const record = this.record!;
    const handle = this.handle!;

    // ROB-18: an idle-stop checkpoint may be IN FLIGHT (the timer fired and `provider.stop`
    // is mid-await). Wait for it to settle before reading the sandbox status — otherwise we
    // read "running", skip `start()`, and the completing stop leaves this turn's execs
    // hitting a stopped VM. Then cancel any still-pending idle-stop timer.
    await this.idle.settleStop();
    this.idle.cancel(record.sessionId);

    // Resume from a stopped checkpoint (cold reboot, §10.3): start the sandbox and
    // surface "processes not preserved" to the model before the new turn.
    const wasStopped = (await this.exec.status(handle)) === "stopped";
    if (wasStopped) {
      await this.exec.start(handle);
      await session.steer(
        "[resume] The sandbox was cold-rebooted from a checkpoint; filesystem is " +
          "preserved but running processes were NOT (§10.3).",
      );
    }

    this.sm.start();
    this.outbound.emit("session.status_run_started");
    await this.persistStatus(); // R2.8: idle → running

    const flags: TurnFlags = {
      budgetBreached: false,
      interrupted: false,
      requiresAction: false,
      blockingEventIds: [],
    };
    this.turnFlags = flags;

    // Drive the turn, with backend-level rescheduling on transient failure.
    const stopReason = await this.runTurnWithRetries(content, flags);

    // Settle: idle transition, JSONL sync, idle policy schedule.
    await this.onTurnSettled(stopReason);
  }

  private async runTurnWithRetries(
    content: string,
    flags: TurnFlags,
  ): Promise<StopReason> {
    const session = this.session!;
    for (;;) {
      try {
        const promptP = session.prompt(content);
        // Race the in-flight prompt against a `requires_action` block (a tool call
        // awaiting operator input via the permission gate / custom-tool relay). If a
        // block wins, the prompt stays pending (its tool is blocked) and the turn
        // settles as `requires_action`; the pending prompt resumes on the round-trip.
        const outcome = await this.driveTurn(promptP, flags);
        if (outcome === "requires_action") {
          this.pendingPrompt = promptP;
          return "requires_action";
        }
        // Drain usage + budget enforcement before deciding the stop reason so a mid-turn
        // budget breach is observed as `budget_exhausted` (ROB-14: recording is now awaited).
        await this.drainUsage();
        if (flags.budgetBreached) return "budget_exhausted";
        if (flags.interrupted) return "user_interrupt";
        return "completed";
      } catch (err) {
        if (isTransient(err)) {
          const schedule = this.sm.scheduleRetry();
          if (schedule) {
            this.outbound.emit("session.status_rescheduled");
            await this.persistStatus(); // R2.8: running → rescheduling
            await delay(schedule.delayMs);
            this.sm.start();
            await this.persistStatus(); // R2.8: rescheduling → running
            continue;
          }
          this.sm.terminate("error");
          this.outbound.emit("session.status_terminated");
          await this.persistStatus(); // R2.8: → terminated
          return "error";
        }
        this.sm.terminate("error");
        this.outbound.emit("session.status_terminated");
        await this.persistStatus(); // R2.8: → terminated
        return "error";
      }
    }
  }

  private async handleUserInterrupt(): Promise<void> {
    // §9.2 `user.interrupt`: abort the in-flight turn (the documented `interrupt()`).
    await this.interrupt();
  }

  private async handleSystemMessage(event: InboundEvent): Promise<void> {
    // §9.6: mid-conversation system-prompt update. The real mechanism — mutate the resource
    // loader's live override holder and reload, so Pi rebuilds the system prompt with the
    // new content on the next turn (the cost is prompt-cache invalidation, not model
    // support). Falls back to a steering note only for a session (test fake) that does not
    // expose `setSystemPrompt`.
    const content = String((event.payload as { content?: unknown }).content ?? "");
    if (!this.session) return;
    if (this.session.setSystemPrompt) {
      await this.session.setSystemPrompt(content);
    } else {
      await this.session.steer(`[system] ${content}`);
    }
  }

  // -- inbound round-trips (§9.4 / §9.5, R2.6) -------------------------------

  /**
   * `user.tool_confirmation` (§9.5): resolve the pending permission-gate promise for the
   * blocking `eventId` (allow → run the tool; deny → surface the rejection). If it was the
   * last outstanding block, the paused turn resumes to settlement.
   */
  private async handleToolConfirmation(event: InboundEvent): Promise<void> {
    const p = event.payload as {
      eventId?: string;
      decision?: "allow" | "deny";
      denyMessage?: string;
    };
    const decision = p.decision === "deny" ? "deny" : "allow";
    const matched = this.confirmation.applyConfirmation(
      String(p.eventId ?? ""),
      decision,
      p.denyMessage,
    );
    if (matched) await this.resumeIfUnblocked();
  }

  /**
   * `user.custom_tool_result` (§9.4): deliver the client's output to the pending
   * custom-tool relay call keyed by `customToolUseId`, then resume if unblocked.
   */
  private async handleCustomToolResult(event: InboundEvent): Promise<void> {
    const p = event.payload as { customToolUseId?: string; result?: string };
    const matched = this.customToolRelay.applyCustomToolResult(
      String(p.customToolUseId ?? ""),
      String(p.result ?? ""),
    );
    if (matched) await this.resumeIfUnblocked();
  }

  /**
   * `user.tool_result` (§9.2, self-hosted): deliver a worker-provided result to the
   * generic relay keyed by `toolUseId`. Nothing populates {@link pendingToolResults} yet
   * (self-hosted tool execution is R6.6) — this is the wired seam so the round-trip
   * completes once that lands.
   */
  private async handleToolResult(event: InboundEvent): Promise<void> {
    const p = event.payload as { toolUseId?: string; result?: string; isError?: boolean };
    const id = String(p.toolUseId ?? "");
    if (!id) return;
    const resolve = this.pendingToolResults.get(id);
    if (!resolve) {
      // No exec is awaiting this result yet — it was posted early, re-delivered, or drained
      // from the work item on wake (ROB-10). Buffer it so the exec picks it up when it
      // registers its resolver, rather than dropping it (delivery was process-local before).
      this.bufferedToolResults.set(id, {
        result: String(p.result ?? ""),
        isError: Boolean(p.isError),
      });
      return;
    }
    this.pendingToolResults.delete(id);
    resolve({ result: String(p.result ?? ""), isError: Boolean(p.isError) });
    await this.resumeIfUnblocked();
  }

  /**
   * `user.define_outcome` (§16.3): hand the outcome definition to the injected runner
   * (which defines + drives the produce→grade→feedback loop). Omitted ⇒ no-op (the
   * Outcomes API route is the primary path; see the R2.3 seam note).
   */
  private async handleDefineOutcome(event: InboundEvent): Promise<void> {
    if (this.onDefineOutcome && this.record) {
      await this.onDefineOutcome(
        { tenantId: this.record.tenantId, sessionId: this.record.sessionId },
        event.payload,
      );
    }
  }

  /** Every blocking event id currently awaiting a client round-trip. */
  private blockingEventIds(): string[] {
    return [
      ...this.confirmation.pendingEventIds,
      ...this.customToolRelay.pendingEventIds,
      ...this.pendingToolResults.keys(),
    ];
  }

  /**
   * A coordinator blocked a tool call awaiting operator input. Flip the in-flight turn to
   * `requires_action` (record the full blocking set) and release the {@link driveTurn}
   * race so the turn settles without waiting for `prompt()` (which is blocked on the tool).
   */
  private onCoordinatorBlock(ids: readonly string[]): void {
    if (this.turnFlags) {
      this.turnFlags.requiresAction = true;
      this.turnFlags.blockingEventIds = [...ids];
    }
    if (this.requiresActionWaiter) {
      const w = this.requiresActionWaiter;
      this.requiresActionWaiter = null;
      w();
    }
  }

  /**
   * Drive an in-flight `prompt()` to one of two outcomes: `"done"` (it resolved) or
   * `"requires_action"` (a tool call blocked). Rejections propagate to the caller's
   * transient-retry handler. Exactly one drive is active per turn, so the single
   * {@link requiresActionWaiter} slot is safe.
   */
  private driveTurn(
    promptP: Promise<void>,
    flags: TurnFlags,
  ): Promise<"done" | "requires_action"> {
    return new Promise((resolve, reject) => {
      let done = false;
      this.requiresActionWaiter = (): void => {
        if (done) return;
        done = true;
        this.requiresActionWaiter = null;
        resolve("requires_action");
      };
      promptP.then(
        () => {
          if (done) return;
          done = true;
          this.requiresActionWaiter = null;
          resolve("done");
        },
        (err) => {
          if (done) return;
          done = true;
          this.requiresActionWaiter = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
      // A tool-call block can fire SYNCHRONOUSLY inside `prompt()` (Pi runs the
      // `tool_call` hook before the promise is awaited), i.e. before the waiter above
      // was installed. If `onCoordinatorBlock` already set the flag, honor it now.
      if (flags.requiresAction && !done) {
        done = true;
        this.requiresActionWaiter = null;
        resolve("requires_action");
      }
    });
  }

  /**
   * After a client round-trip, resume the paused turn IF no blocks remain. If other
   * tool calls are still pending, re-advertise the remaining blocking ids and stay in
   * `requires_action`. Otherwise transition idle→running and drive the pending prompt to
   * settlement (it may block again on a later tool call — handled recursively).
   */
  private async resumeIfUnblocked(): Promise<void> {
    if (!this.pendingPrompt) return;
    const remaining = this.blockingEventIds();
    if (remaining.length > 0) {
      this.sm.requiresAction(remaining);
      this.outbound.emit("session.status_idle", {
        stopReason: "requires_action",
        blockingEventIds: remaining,
      });
      await this.persistStatus(); // R2.8: idle (requires_action)
      return;
    }

    const promptP = this.pendingPrompt;
    this.pendingPrompt = undefined;
    this.sm.start();
    this.outbound.emit("session.status_run_started");
    await this.persistStatus(); // R2.8: idle → running (resumed)
    const flags: TurnFlags = {
      budgetBreached: false,
      interrupted: false,
      requiresAction: false,
      blockingEventIds: [],
    };
    this.turnFlags = flags;

    let stopReason: StopReason;
    try {
      const outcome = await this.driveTurn(promptP, flags);
      if (outcome === "requires_action") {
        this.pendingPrompt = promptP;
        stopReason = "requires_action";
      } else if (flags.budgetBreached) {
        stopReason = "budget_exhausted";
      } else if (flags.interrupted) {
        stopReason = "user_interrupt";
      } else {
        stopReason = "completed";
      }
    } catch (err) {
      // A rejection after resume cannot be re-prompted mid-turn; terminate honestly
      // rather than silently drop the turn (transient retry only covers the first drive).
      this.sm.terminate("error");
      this.outbound.emit("session.status_terminated", {
        error: err instanceof Error ? err.message : String(err),
      });
      await this.persistStatus(); // R2.8: → terminated
      this.turnFlags = undefined;
      return;
    }
    await this.onTurnSettled(stopReason);
  }

  // -- turn settlement -------------------------------------------------------

  private async onTurnSettled(stopReason: StopReason): Promise<void> {
    // Ensure usage is durable before the session settles (ROB-14). Idempotent — the
    // completed path already drained in `runTurnWithRetries`; this covers the
    // requires_action / interrupt / terminate paths.
    await this.drainUsage();
    if (this.sm.status === "terminated") {
      this.idle.dispose();
      await this.persistStatus(); // R2.8: durable terminated
      return;
    }
    if (this.sm.status === "running" || this.sm.status === "rescheduling") {
      // State machine already advanced (interrupt/terminate); only settle side effects.
      if (stopReason === "user_interrupt") {
        // sm already idle via interrupt()
      } else if (stopReason === "budget_exhausted") {
        this.sm.budgetExhausted();
      } else if (stopReason === "requires_action") {
        this.sm.requiresAction(this.turnFlags?.blockingEventIds);
      } else {
        this.sm.complete(stopReason);
      }
    }
    // R2.8: persist the settled status + stop reason (idle/terminated w/ reason).
    await this.persistStatus();
    this.outbound.emit(
      "session.status_idle",
      {
        ...(this.sm.stopReason ? { stopReason: this.sm.stopReason } : {}),
        ...(this.turnFlags?.blockingEventIds.length
          ? { blockingEventIds: this.turnFlags!.blockingEventIds }
          : {}),
      },
    );

    // §28: sync JSONL on every idle transition.
    if (this.record) {
      await this.jsonl.syncToJsonl(
        this.record.sessionId,
        this.record.localJsonlPath,
        this.record.objectStoreKey,
      );
    }

    // §13.1 (R6.5a): flush read-write memory volumes back into new memory versions on the
    // same idle transition — while the sandbox is still running (the idle-stop checkpoint
    // below would make the volume unreadable).
    await this.syncMemoryVolumes();

    // Schedule the idle-stop checkpoint (§10.3).
    if (this.record && this.handle) {
      this.idle.schedule(
        {
          sessionId: this.record.sessionId,
          handle: this.handle,
          idleTimeoutMs: idleTimeoutMsFromEnv(
            this.record.environment.idleTimeout,
          ),
        },
        () => {
          // After the sandbox checkpoints, sync the JSONL once more.
          if (this.record) {
            void this.jsonl.syncToJsonl(
              this.record.sessionId,
              this.record.localJsonlPath,
              this.record.objectStoreKey,
            );
          }
        },
      );
    }
    this.turnFlags = undefined;
  }

  // -- material augmentation (R2.1) -----------------------------------------

  /**
   * Build the session material's live-bound fields at wake: the sandbox toolset
   * (§10.2), the resolved model-provider keys (§4.2 / R2.7), the guest cwd, and the
   * `user_bash` lockout extension. Requires {@link handle} to be set.
   */
  private async augmentMaterial(
    record: SessionRecord,
  ): Promise<ResolvedAgentMaterial> {
    const cwd = guestCwd();
    const toolset = materializeToolset(
      {
        provider: this.exec,
        handle: this.handle!,
        cwd,
        factories: this.toolFactories,
        web: this.webToolsOptions,
      },
      record.material.agentConfig.tools,
    );
    const customTools = toCustomToolDefinitions(toolset.tools);
    const providerKeys = this.providerKeyResolver
      ? await this.providerKeyResolver.resolveProviderKeys({
          tenantId: record.tenantId,
          sessionId: record.sessionId,
          vaultIds: record.vaultIds,
        })
      : record.material.providerKeys;
    const managedExtensions = await this.buildManagedExtensions(record);
    // R6.5: the mounted memory stores are announced in the system prompt (§13.1 — the
    // model learns each store's mount path, access mode, and instructions), and the
    // agent's skills are staged on disk for Pi's progressive disclosure (§20.4).
    const appendSystemPrompt = [
      ...(record.material.appendSystemPrompt ?? []),
      ...systemPromptNotes(this.memoryStores),
    ];
    const skills = await this.materializeSkills(record);
    return {
      ...record.material,
      cwd,
      customTools,
      providerKeys,
      ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      extensionFactories: [
        ...(record.material.extensionFactories ?? []),
        ...managedExtensions,
        disableUserBashExtension,
      ],
    };
  }

  // -- session-start subsystems (R6.5 memory + skills, R6.6 self-hosted) ------

  /**
   * The provider tools execute against (R6.6, §10.4). `self_hosted` ⇒ the work-queue
   * channel (no cloud VM; the subscriber's worker runs every tool); `cloud` ⇒ the
   * injected microVM provider. The idle/crash loops are re-bound to the channel so they
   * never checkpoint or re-provision a VM the control plane does not own.
   *
   * A `self_hosted` environment with no channel factory wired is a hard failure — silently
   * falling back to the cloud provider would run the subscriber's tools on OUR host.
   */
  private selectExecutionProvider(record: SessionRecord): SandboxProvider {
    if (record.environment.type !== "self_hosted") return this.sandbox;
    if (!this.selfHostedFactory) {
      throw new Error(
        "ManagedSessionRuntime.wake: environment is self_hosted but no " +
          "SelfHostedChannelFactory is wired — refusing to execute the subscriber's " +
          "tools on the control-plane host (§10.4).",
      );
    }
    const channel = this.selfHostedFactory.create({
      tenantId: record.tenantId,
      sessionId: record.sessionId,
      environmentId: record.environment.id,
      // The pending resolver lives in the SAME map the inbound `user.tool_result` router
      // resolves (§9.2), so an unanswered worker call is a `requires_action` block, not a
      // silent hang.
      awaitToolResult: (toolUseId) =>
        new Promise<{ result: string; isError: boolean }>((resolve) => {
          // A result may already have landed (worker posted before this exec registered, or
          // it was drained from the work item on wake, ROB-10) — resolve immediately.
          const buffered = this.bufferedToolResults.get(toolUseId);
          if (buffered) {
            this.bufferedToolResults.delete(toolUseId);
            resolve(buffered);
            return;
          }
          this.pendingToolResults.set(toolUseId, resolve);
          this.onCoordinatorBlock(this.blockingEventIds());
        }),
    });
    this.idle = new IdlePolicy(channel);
    this.crash = new CrashRecovery(channel);
    return channel;
  }

  /**
   * The memory stores this session mounts (R6.5a, §13.2): the `memory_store` mounts on
   * its environment, resolved through the tenant-scoped memory service. Self-hosted
   * environments mount none (§13.7 — the documented unsupported feature, rejected at
   * environment creation; this is the belt-and-braces at wake).
   */
  private async resolveMemoryStores(record: SessionRecord): Promise<MemoryStore[]> {
    if (!this.memory) return [];
    if (record.environment.type === "self_hosted") return [];
    const ids = (record.environment.mounts ?? [])
      .filter((m): m is { type: "memory_store"; id: string } => m.type === "memory_store")
      .map((m) => m.id);
    if (ids.length === 0) return [];
    return this.memory.resolveStores(record.tenantId, ids);
  }

  /**
   * The memory-volume lifecycle handler, once the live handle exists (R6.5a). Undefined when
   * no memory service is wired or the sandbox is not yet provisioned.
   */
  private memoryVolumes(): SessionMemoryVolumes | undefined {
    if (!this.memory || !this.record || !this.handle) return undefined;
    return new SessionMemoryVolumes(
      this.memory,
      this.exec,
      this.handle,
      this.record.tenantId,
    );
  }

  /** Stage every mounted store's live memories into its volume (post-provision, §13.1). */
  private async stageMemoryVolumes(): Promise<void> {
    await this.memoryVolumes()?.stage(this.memoryStores);
  }

  /**
   * Write-back on idle (R6.5a, §13.1): drain each READ-WRITE volume back into new memory
   * versions. Driven from the idle transition ({@link onTurnSettled}) — NOT the IdlePolicy's
   * post-checkpoint hook, which fires after the VM is stopped and could no longer read the
   * volume.
   */
  private async syncMemoryVolumes(): Promise<void> {
    await this.memoryVolumes()?.syncBack(this.memoryStores);
  }

  /**
   * Stage the agent's skills for this session (R6.5b, §20.3/§20.4) under
   * `<sessionDir>/.pi/skills/<name>/`, and return them for the resource loader's
   * `skillsOverride`. The ≤20-per-session cap is enforced by the materializer (`422`).
   */
  private async materializeSkills(
    record: SessionRecord,
  ): Promise<NonNullable<ResolvedAgentMaterial["skills"]>> {
    const refs = record.material.agentConfig.skills ?? [];
    if (!this.skills || refs.length === 0) return [];
    const root = join(dirname(record.localJsonlPath), ".pi", "skills");
    return this.skills.materialize(record.tenantId, refs, root);
  }

  /**
   * Load the six managed Pi extensions into the session material (R2.5). This is the
   * *loading* seam — per-subsystem functional tests are R6. Each factory is constructed
   * with its exact options from its `pi-extensions/<name>/index.ts` signature:
   *
   * - permission-gate — §22 policy snapshot (creation-time toolset config) + the
   *   confirmation coordinator (round-trips `user.tool_confirmation`, §9.5).
   * - tasks (§14) / goals (§15) — per-session managed-feature extensions (no options).
   * - custom-tools relay (§11.2) — the custom-tool coordinator (round-trips
   *   `user.custom_tool_result`). Declarations come from the agent's custom-tool set
   *   (no wire field on `AgentConfig` yet — the declaration source is a seam; the
   *   coordinator is loaded regardless so the inbound round-trip is live).
   * - mcp-bridge (§19) — vault-backed credential proxy; loaded only when the agent
   *   declares `mcpServers` AND an {@link McpCredentialResolver} is wired.
   *
   * **Depth rule (§18.2):** `createSubagentExtension` is loaded ONLY for depth-0 sessions.
   * Every session `ManagedSessionRuntime` wakes IS depth-0 — child/subagent threads are
   * spawned inside the `SubagentCoordinator` with their own materials that carry no
   * subagent factory — so the rule is satisfied structurally. Wiring the coordinator
   * itself (roster resolution + sandbox allocator + child material builder) is the R6.4
   * multi-agent integration and is deferred; see the seam note in the WP report.
   */
  private async buildManagedExtensions(
    record: SessionRecord,
  ): Promise<InlineExtension[]> {
    const factories: InlineExtension[] = [
      createPermissionGate({
        snapshot: snapshotToolsetConfig(record.material.agentConfig.tools),
        coordinator: this.confirmation,
      }),
      tasksExtension,
      goalsExtension,
      createCustomToolsRelay({
        declarations: customToolDeclarationsFor(record.material),
        relay: this.customToolRelay,
      }),
    ];

    const servers = record.material.agentConfig.mcpServers ?? [];
    if (servers.length > 0 && this.mcpCredentialResolver) {
      const bindings = await this.resolveSecretBindings(record);
      factories.push(
        createMcpBridge({
          servers,
          bindings,
          resolver: this.mcpCredentialResolver,
          failureSink: {
            emitMcpFailure: async (mcpServerName, retryStatus) => {
              this.outbound.emit("session.error", { mcpServerName, retryStatus });
            },
          },
          tracker: this.mcpFailureTracker,
          sandbox: { provider: this.exec, handle: this.handle! },
        }),
      );
    }

    return factories;
  }

  // -- durable runtime-state persistence (R2.8 / R2.10) ---------------------

  /**
   * Persist the provisioned sandbox handle (R2.8). Best-effort: a DB blip must never
   * crash a turn — the worst case is a restart that provisions a fresh VM (the pre-R2.8
   * behavior), not a lost session.
   */
  private async persistSandboxHandle(handle: SandboxHandle): Promise<void> {
    if (!this.record) return;
    try {
      await this.sessions.saveSandboxHandle(this.record.sessionId, handle);
    } catch {
      /* best-effort: persistence failure must not crash the wake/turn */
    }
  }

  /**
   * Persist the current wire status + stop reason (R2.8) from the state machine. The
   * internal {@link SessionStatus} is already the wire status (idle|running|rescheduling|
   * terminated); the stop reason is passed through (undefined → null). Best-effort.
   */
  private async persistStatus(): Promise<void> {
    if (!this.record) return;
    try {
      await this.sessions.saveStatus(
        this.record.sessionId,
        this.sm.status,
        this.sm.stopReason ?? null,
      );
    } catch {
      /* best-effort: persistence failure must not crash the turn */
    }
  }

  /**
   * Restore the local JSONL from the object store when it is absent (R2.10c). A cold
   * wake on a fresh host has no local file; without this, Pi would create an EMPTY
   * session and the next sync would overwrite the durable object-store copy. A
   * not-found (a genuine first-wake session with no object yet) is swallowed.
   */
  private async restoreLocalJsonlIfAbsent(record: SessionRecord): Promise<void> {
    if (existsSync(record.localJsonlPath)) return;
    try {
      const stream = await this.objects.get(record.objectStoreKey);
      const bytes = await readAllBytes(stream);
      if (bytes.byteLength === 0) return; // empty object → nothing to restore
      await mkdir(dirname(record.localJsonlPath), { recursive: true });
      await writeFile(record.localJsonlPath, bytes);
    } catch {
      // Not found (first wake — no durable copy yet) or a transient store error: fall
      // through to a fresh session. The next idle sync establishes the object.
    }
  }

  // -- sandbox lifecycle ----------------------------------------------------

  private async ensureSandboxRunning(
    record: SessionRecord,
  ): Promise<{ handle: SandboxHandle; isNew: boolean }> {
    if (record.sandboxHandle) {
      const handle = record.sandboxHandle;
      const status = await this.exec.status(handle);
      if (status === "crashed") {
        // Re-provision from the spec (secret bindings already baked in, ROB-2), then
        // cold-reboot (§10.3). A NEW handle — the old detached VM is gone, so the persisted
        // handle must be replaced (R2.8).
        const fresh = await this.exec.provision(this.provisionSpec!);
        await this.exec.start(fresh);
        return { handle: fresh, isNew: true };
      }
      if (status === "stopped") {
        await this.exec.start(handle);
      }
      // Re-attached the SAME surviving VM — no new handle to persist.
      return { handle, isNew: false };
    }
    // First wake: provision ONCE with all secret bindings already baked into the
    // ProvisionSpec (R2.4 / ROB-2). Applying bindings at provision-time means a multi-secret
    // session creates the VM a single time — the provider registers every
    // environment_variable secret on the create() builder, so there is no per-secret
    // `modify({policy:'restart'})` reboot (the loop-of-restarts anti-pattern).
    const handle = await this.exec.provision(this.provisionSpec!);
    return { handle, isNew: true };
  }

  /**
   * Resolve the session's secret bindings from its vaults (§28) inside the
   * `pi.vault.resolve` span (WP-8.1). The span carries only the tenant/session ids and
   * the COUNT of bindings — never a placeholder name and never a value (§25.5).
   */
  private async resolveSecretBindings(
    record: SessionRecord,
  ): Promise<Awaited<ReturnType<SecretStore["resolveBindingsForSession"]>>> {
    return withSpan(SpanNames.VAULT_RESOLVE, async (span) => {
      span.setAttributes({
        [SpanAttrs.SESSION_ID]: record.sessionId,
        [SpanAttrs.TENANT_ID]: record.tenantId,
      });
      span.setAttribute("pi.vault.count", record.vaultIds.length);
      const bindings = await this.secrets.resolveBindingsForSession({
        tenantId: record.tenantId,
        sessionId: record.sessionId,
        vaultIds: record.vaultIds,
      });
      span.setAttribute("pi.vault.bindings", bindings.length);
      return bindings;
    });
  }

  // -- Pi event mapping ------------------------------------------------------

  private turnFlags: TurnFlags | undefined;

  private onPiEvent(event: { type: string; [k: string]: unknown }): void {
    switch (event.type) {
      case "agent_start":
        // run_started emitted by sendEvent on start; no-op here to avoid duplicates.
        break;
      case "turn_start":
        this.outbound.emit("span.model_request_start");
        this.spans.startModel();
        break;
      case "turn_end":
        this.outbound.emit("span.model_request_end");
        this.spans.endModel(event);
        this.recordTurnUsage(event);
        break;
      case "message_update": {
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (ame?.type === "text_delta" && ame.delta) {
          this.messageBuffer += ame.delta;
        }
        break;
      }
      case "message_end":
        if (this.messageBuffer) {
          this.outbound.emit("agent.message", { content: this.messageBuffer });
          this.messageBuffer = "";
        }
        break;
      case "tool_execution_start": {
        const tool = String(event.toolName ?? "unknown");
        this.outbound.emit("agent.tool_use", {
          tool,
          input: (event.input ?? {}) as Record<string, unknown>,
        });
        this.spans.startTool(tool, event);
        break;
      }
      case "tool_execution_end": {
        const tool = String(event.toolName ?? "unknown");
        this.outbound.emit("agent.tool_result", {
          tool,
          output: String(event.output ?? ""),
        });
        this.spans.endTool(event);
        break;
      }
      case "agent_end":
        // Usage is recorded ONCE per model request from `turn_end` (the natural
        // per-request source, §9.7). `agent_end` re-carries the same assistant messages,
        // so recording here as well double-billed every request (ROB-7) — it does not.
        break;
      case "queue_update":
        break;
      default:
        break;
    }
  }

  private messageBuffer = "";

  // -- usage / budget accounting (from Pi turn_end events) --------------------

  /** Per-runtime fallback sequence for the usage idempotency key (no `responseId`). */
  private usageSeq = 0;
  /** In-flight usage records (durable-record + budget enforcement), awaited at settlement. */
  private usageTasks: Promise<void>[] = [];

  /**
   * Record ONE model request's usage (ROB-7: `turn_end` is the single billing source).
   * Recording is durable + dedup'd (ROB-14) and kicked eagerly; the resulting task also
   * enforces the budget once the row is persisted, and is awaited at turn settlement.
   */
  private recordTurnUsage(event: { [k: string]: unknown }): void {
    const message = event.message as
      | {
          model?: string;
          responseId?: string;
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        }
      | undefined;
    if (!message?.usage || !this.record) return;
    const tokens: TokenCounts = {
      inputTokens: message.usage.input ?? 0,
      outputTokens: message.usage.output ?? 0,
      cacheCreationInputTokens: message.usage.cacheWrite ?? 0,
      cacheReadInputTokens: message.usage.cacheRead ?? 0,
    };
    // Idempotency key: the provider `responseId` when present (stable across a retry of the
    // SAME request), else a per-runtime sequence so distinct requests never collide.
    const key = `${this.record.sessionId}:${message.responseId ?? `seq-${this.usageSeq++}`}`;
    const model = message.model ?? "unknown";
    const task = this.durableUsage
      .record(this.record.sessionId, { key, model, tokens })
      .then(() => this.enforceBudgetAfterUsage());
    this.usageTasks.push(task);
  }

  /**
   * After a usage row is durable, enforce the session budget (§6.3). A breach flips the
   * turn flag + aborts the in-flight turn. A budget-READ failure fails SAFE (ROB-6): it must
   * never kill the turn — the worst case is a slightly delayed cap, not a crashed session.
   */
  private async enforceBudgetAfterUsage(): Promise<void> {
    if (!this.record?.budget || !this.turnFlags) return;
    try {
      const enf = await enforceBudget(
        this.record.sessionId,
        this.record.budget,
        this.usage,
      );
      if (enf.exceeded) {
        this.turnFlags.budgetBreached = true;
        // ROB-6: abort() may reject (already-settled turn); never let it become an
        // unhandled rejection (worker-entry turns those into process.exit(1)).
        void this.session?.abort().catch(() => {
          /* abort is best-effort — the turn is already ending */
        });
      }
    } catch {
      /* ROB-6: budget-read failure fails safe — do not breach, do not abort the turn */
    }
  }

  /**
   * Await every in-flight usage record + budget enforcement (ROB-14). Called before the
   * turn's stop reason is decided (so a mid-turn budget breach is observed) and again at
   * settlement (so usage is durable before the session goes idle). Idempotent.
   */
  private async drainUsage(): Promise<void> {
    const tasks = this.usageTasks;
    this.usageTasks = [];
    await Promise.allSettled(tasks);
    await this.durableUsage.drain();
  }

}

// Pure helpers now live in `runtime-helpers.ts`; `readJsonlText` is re-exported here to
// preserve its public import path.
export { readJsonlText } from "./runtime-helpers.js";
