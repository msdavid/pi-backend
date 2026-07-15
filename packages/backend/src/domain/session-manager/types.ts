/**
 * Internal types for the session manager (WP-1.5 — the "Harness").
 *
 * The runtime orchestrates a Pi `AgentSession` (created via {@link AgentSessionFactory})
 * bound to a durable JSONL log, plus the sandbox lifecycle, usage/budget enforcement,
 * idle policy, crash recovery, and object-store JSONL sync. These types are the seams
 * between those collaborators; they are NOT exported from the package surface except
 * where WP-1.6 (the session API/DB layer) needs them to construct a runtime.
 *
 * **§4.2 isolation:** provider API keys flow in via {@link ResolvedAgentMaterial.providerKeys}
 * and are handed to `AuthStorage.inMemory(...)` per session — the harness NEVER reads
 * process-global Pi config (host-level provider API key env vars). An integration test
 * asserts this.
 *
 * **§25.5 trust boundary:** these types never carry a raw *sandbox* secret value. Sandbox
 * credentials flow as opaque `SecretBinding` refs (ports.ts) the provider resolves
 * host-side. Provider *model* API keys are a distinct category the `AgentSession` needs
 * to call the model API; they live only in {@link providerKeys} and the in-memory
 * `AuthStorage` — never logged, never persisted by this layer.
 */

import type {
  AgentConfig,
  Budget,
  Environment,
  MemoryStore,
  SkillRef,
  StopReason,
} from "@pi-managed/contracts";
import type {
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  SandboxHandle,
  SandboxProvider,
  SecretBinding,
  SessionId,
  SessionStatus,
  TenantId,
} from "../ports.js";

// ---------------------------------------------------------------------------
// Provider keys & material
// ---------------------------------------------------------------------------

/**
 * Map of model-provider → API key, resolved per session (§4.2). Sourced from the
 * tenant vault by the session-creation layer (WP-1.6), NOT from process env. Injected
 * into `AuthStorage.inMemory(...)` so each `AgentSession` is fully isolated.
 */
export type ProviderKeys = Record<string, string>;

/**
 * The resolved, per-session configuration the runtime + materializer consume. Built by
 * the session-creation layer (WP-1.6) from the agent resource (config), the tenant's
 * provider-key vault entries, and the environment (cwd/sandbox).
 *
 * NOTE on the spec's "provider keys from agent config" (§4.2): the `AgentConfig` wire
 * schema (contracts/agent.ts) has no provider-keys field — keys are vault-managed, not
 * agent-configured. So `providerKeys` is a separate injection here. This honors the
 * §4.2 invariant (never process env, per-session `AuthStorage.inMemory`) without
 * forcing a contracts change. See "open questions" in the WP-1.5 report.
 */
export interface ResolvedAgentMaterial {
  /** The versioned agent config (model, systemPrompt, tools, skills, extensions, mcp). */
  agentConfig: AgentConfig;
  /** Per-session model-provider API keys (§4.2). Never read from process env. */
  providerKeys: ProviderKeys;
  /** Explicit working directory for the agent + DefaultResourceLoader discovery. */
  cwd: string;
  /** Optional system-prompt override (from agent config or session overrides). */
  systemPromptOverride?: string;
  /**
   * The sandbox-bound tools handed to the Pi `AgentSession` as `customTools` (§10.2).
   * Augmented at {@link SessionRuntime} `wake()` — AFTER the live sandbox handle + cwd
   * exist — via `materializeToolset` + the SDK tool factories, so every effect lands in
   * the microVM. The real SDK {@link ToolDefinition} type (not a structural shim): a
   * `^0.80.6` bump that changes the tool shape breaks the build (see `sdk-parity.ts`).
   * Empty ⇒ the factory REFUSES to construct a session (a host-executing session would
   * be a sandbox escape, §10.2).
   */
  customTools?: ToolDefinition[];
  /** Inline extensions loaded into the per-session `DefaultResourceLoader` (real SDK type). */
  extensionFactories?: InlineExtension[];
  /**
   * Extra paragraphs appended to the session's system prompt (R6.5, §13.1). The Pi
   * `DefaultResourceLoader` takes these as `appendSystemPrompt`, so they survive the
   * per-turn prompt rebuild. Populated at wake with the mounted memory stores' notes
   * ({@link systemPromptNotes}); the model therefore learns each store's mount path,
   * access mode, and instructions.
   */
  appendSystemPrompt?: string[];
  /**
   * Skills materialized for this session (R6.5, §20.3/§20.4). Staged on disk at wake
   * (`<sessionDir>/.pi/skills/<name>/SKILL.md`) and handed to the loader as a
   * `skillsOverride`, so Pi's native progressive disclosure applies unchanged: the
   * name + description are always in context; the full `SKILL.md` is read on demand.
   */
  skills?: SessionSkill[];
}

/**
 * A staged skill (R6.5). Structurally Pi's `Skill` minus `sourceInfo`, which
 * `materialize.ts` fills in with `createSyntheticSourceInfo` (the only place that
 * imports Pi's skill types).
 */
export interface SessionSkill {
  name: string;
  description: string;
  /** Absolute host path of the staged `SKILL.md`. */
  filePath: string;
  /** Absolute host path of the staged skill directory. */
  baseDir: string;
  disableModelInvocation?: boolean;
}

// ---------------------------------------------------------------------------
// Session-start seams (R6.5 memory + skills, R6.6 self-hosted execution)
// ---------------------------------------------------------------------------

/**
 * A read/write view over one mounted memory volume (the staged directory the agent
 * sees at `/mnt/memory/<slug>/`). Structurally identical to `memory/mount.ts`'s
 * `VolumeStore`; declared here so the session manager does not import the memory
 * domain (and the memory domain does not import this one).
 */
export interface SessionVolumeStore {
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
}

/**
 * The memory-mount seam (R6.5a, §13.1–13.3). Injected into the runtime by the
 * composition root; the default impl (`memory/mount.ts` → `createMemoryMountService`)
 * is pool + object-store backed. The runtime:
 *
 *  1. resolves the session's referenced stores BEFORE provision ({@link resolveStores}),
 *     compiles them to `VolumeMount`s (`mountMemoryStores`) and merges them into the
 *     `ProvisionSpec` — a `read_only` store therefore becomes a read-only bind mount;
 *  2. stages each store's live memories into its volume AFTER provision ({@link stage});
 *  3. drains read-write volumes back into new memory versions on every idle transition
 *     ({@link syncBack}).
 */
export interface MemoryMountService {
  /** Resolve the memory stores referenced by the session's environment mounts. */
  resolveStores(tenantId: TenantId, storeIds: string[]): Promise<MemoryStore[]>;
  /** A read/write view over a store's mounted volume in the live sandbox. */
  volumeFor(
    store: MemoryStore,
    sandbox: { provider: SandboxProvider; handle: SandboxHandle; guestPath: string },
  ): SessionVolumeStore;
  /** Stage the store's live memories into the mounted volume (provision-time). */
  stage(
    tenantId: TenantId,
    store: MemoryStore,
    volume: SessionVolumeStore,
  ): Promise<void>;
  /** Drain the mounted volume back into new memory versions (idle write-back). */
  syncBack(
    tenantId: TenantId,
    store: MemoryStore,
    volume: SessionVolumeStore,
  ): Promise<void>;
}

/**
 * The skill-materialization seam (R6.5b, §20.3/§20.4). Resolves the agent's
 * `SkillRef[]` (≤20 per session), downloads each bundle, and stages it under
 * `targetRoot` (`<sessionDir>/.pi/skills`). Default impl:
 * `skill/materialize.ts` → `createSkillMaterializer`.
 */
export interface SkillMaterializer {
  materialize(
    tenantId: TenantId,
    refs: SkillRef[],
    targetRoot: string,
  ): Promise<SessionSkill[]>;
}

/**
 * The self-hosted execution seam (R6.6, §10.4). A `self_hosted` environment provisions
 * NO cloud microVM: the runtime instead binds its toolset to a channel that enqueues
 * each tool execution onto the subscriber's work queue and awaits the `user.tool_result`
 * the worker POSTs back. The channel is a full {@link SandboxProvider} so every tool
 * (and the whole `wake` lifecycle) is unchanged above the seam.
 *
 * `awaitToolResult` is supplied BY the runtime: it registers the pending resolver in the
 * same map the inbound `user.tool_result` router resolves (§9.2), so a blocked tool call
 * shows up in `blockingEventIds` and the turn settles as `requires_action` until the
 * worker answers.
 */
export interface SelfHostedChannelFactory {
  create(opts: {
    tenantId: TenantId;
    sessionId: SessionId;
    environmentId: string;
    awaitToolResult(
      toolUseId: string,
    ): Promise<{ result: string; isError: boolean }>;
  }): SandboxProvider;
}

/**
 * Minimal custom-tool shape, retained ONLY as a compile-time parity reference for
 * `sdk-parity.ts` (asserted assignable to the SDK's {@link ToolDefinition}). The
 * material carries the real SDK type; this shim is not on any runtime path.
 */
export interface CustomToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>;
}

/**
 * Minimal inline-extension factory shape, retained as a parity reference for
 * `sdk-parity.ts` (asserted assignable to the SDK's `ExtensionFactory`).
 */
export type InlineExtensionFactory = (pi: unknown) => void;

// ---------------------------------------------------------------------------
// Session record (the DB row; SessionStore is a stub until WP-1.6)
// ---------------------------------------------------------------------------

/**
 * The durable per-session record. WP-1.6 provides a real Postgres-backed
 * `SessionStore`; until then a minimal interface is injected so the runtime is testable.
 */
export interface SessionRecord {
  sessionId: SessionId;
  tenantId: TenantId;
  /** Local disk JSONL path Pi's `SessionManager` writes to. */
  localJsonlPath: string;
  /** Object-store key the backend syncs the JSONL to (§28). */
  objectStoreKey: string;
  /** Existing sandbox handle to re-attach (absent on first wake → provision). */
  sandboxHandle?: SandboxHandle;
  /** Opaque secret-binding refs (§25.5 — refs only, never values). */
  secretBindings?: SecretBinding[];
  /** Resolved agent material (config + provider keys + cwd + tools). */
  material: ResolvedAgentMaterial;
  /** The environment (sandbox image/resources/networking + idleTimeout). */
  environment: Environment;
  /** Hard spend caps (§6.3). Undefined = no enforcement. */
  budget?: Budget;
  /** Vault ids the session references (for SecretStore revalidation, §12.5). */
  vaultIds: string[];
  /** Last object-store etag observed for `objectStoreKey` (conditional-put basis). */
  lastSyncedEtag?: string;
}

/**
 * Minimal DB seam for the session manager. WP-1.6 supplies a Postgres-backed impl.
 * The runtime reads the record, persists the synced etag, and — since R2.8 — persists
 * the durable runtime state (the provisioned sandbox handle + the wire status/stop
 * reason) so a restart re-attaches the surviving VM and `GET /sessions` reports the
 * truth. All conversation state still lives in the JSONL tree (Pi) and the sandbox.
 */
export interface SessionStore {
  get(sessionId: SessionId): Promise<SessionRecord | undefined>;
  saveSyncedEtag(sessionId: SessionId, etag: string): Promise<void>;
  /**
   * Persist the provisioned sandbox handle (R2.8) after {@link SessionRuntime} wakes a
   * NEW VM (first-wake or crash-reprovision). `null` clears it. Written best-effort by
   * the runtime — a DB blip must not crash a turn — but durable so a restart re-attaches
   * the detached VM instead of orphaning it and provisioning a fresh one.
   */
  saveSandboxHandle(
    sessionId: SessionId,
    handle: SandboxHandle | null,
  ): Promise<void>;
  /**
   * Persist the session's wire status + stop reason (R2.8) on state-machine
   * transitions. The in-memory {@link SessionStateMachine} becomes a cache; the DB row
   * is the source of truth `GET /sessions` and the `session_not_idle` / `requires_action`
   * guards read. Written best-effort by the runtime.
   */
  saveStatus(
    sessionId: SessionId,
    status: SessionStatus,
    stopReason: StopReason | null,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentSession seam (so the runtime is SDK-agnostic + testable with a fake)
// ---------------------------------------------------------------------------

/** Structural slice of a Pi session JSONL entry (session-format.md). */
export interface SessionEntryLike {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** Present on `message` entries; carries the `AgentMessage` (with `usage` on assistant). */
  message?: SessionMessageLike;
  [key: string]: unknown;
}

/** Structural slice of an `AgentMessage` inside a message entry. */
export interface SessionMessageLike {
  role: "user" | "assistant" | "toolResult" | string;
  content: unknown;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

/**
 * A permissive structural view of the `AgentSessionEvent` union (sdk.md). The real
 * SDK union is far richer; this captures only the fields the runtime maps to outbound
 * wire events. The trailing index signature makes the real union assignable to it.
 */
export type AgentSessionEventLike = {
  type: string;
  [key: string]: unknown;
};

/**
 * The minimal `AgentSession` surface the runtime depends on. The real Pi
 * `AgentSession` (sdk.md) satisfies this structurally; tests supply a fake.
 */
export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  prompt(
    text: string,
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEventLike) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  /** Positional slice of the JSONL tree (Pi `SessionManager.getEntries()`). */
  getEntries(): SessionEntryLike[];
  /**
   * Per-session temp agent dir the factory created (`mkdtemp`), for teardown cleanup so a
   * wake does not leak a directory per session. Absent on fakes.
   */
  readonly agentDir?: string;
  /**
   * Replace the system-prompt override mid-session (§9.6). Updates the resource loader's
   * override holder and reloads so Pi rebuilds the system prompt with the new content on
   * the next turn — the real mechanism the spec describes, in place of injecting a
   * `[system]` steering note. Absent on fakes (the runtime falls back to `steer`).
   */
  setSystemPrompt?(content: string): Promise<void>;
}

/** Options handed to {@link AgentSessionFactory.create}. */
export interface CreateAgentSessionOptions {
  /** Resolved material (model, keys, cwd, tools, prompt). */
  material: ResolvedAgentMaterial;
  /**
   * Local JSONL path to bind the session to. If the file exists, the factory opens it
   * (resume / `wake`); otherwise it creates a new session file at that path.
   */
  localJsonlPath: string;
}

/**
 * Factory seam around Pi's `createAgentSession()` (sdk.md). The real impl
 * (`materialize.ts`) builds `AuthStorage.inMemory(providerKeys)`,
 * `SettingsManager.inMemory()`, a per-session `DefaultResourceLoader`, and a
 * `SessionManager` bound to `localJsonlPath`, then calls `createAgentSession()`.
 * Tests inject a fake that records calls + emits scripted events.
 */
export interface AgentSessionFactory {
  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike>;
}
