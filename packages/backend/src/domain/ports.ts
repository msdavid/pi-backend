/**
 * Internal seam interfaces (ports) for the Pi Managed Backend.
 *
 * These interfaces decouple the backend's subsystems so Phase-1 work packages can build
 * against fakes (in `@pi-managed/testkit`) in parallel before the real implementations
 * land. Spec §5.4 (named contracts), §10 (sandbox), §12 (vaults), §9.7 (usage),
 * §28 (object store), §25.5 (trust boundaries), §17.8 (scheduler), §23 (webhooks).
 *
 * **§25.5 invariant — the harness cannot see credentials.** No interface in this file
 * accepts or returns a raw secret value. Credentials flow only as opaque
 * {@link SecretBinding} refs (placeholder name + credential reference) that the
 * `SandboxProvider` resolves host-side. Callers MUST NOT log `SecretBinding` contents.
 * See `docs/internal-contracts.md`.
 *
 * Wire contracts (event payloads, request/response bodies) live in `@pi-managed/contracts`
 * (WP-0.9). The supporting types here are minimal — only what the ports need to type
 * their method signatures; they do NOT duplicate the full wire catalog.
 */

// ---------------------------------------------------------------------------
// Shared supporting types
// ---------------------------------------------------------------------------

/** Identifier of a managed session (prefixed `sess_…`, §6.6). */
export type SessionId = string;

/** Identifier of a tenant (§27). */
export type TenantId = string;

/**
 * Tenant + session context passed to secrets/usage subsystems. Carries only resource
 * references — never credential values.
 */
export interface SessionContext {
  tenantId: TenantId;
  sessionId: SessionId;
  /** Vaults the session references (§6.3). Resolved by the SecretStore, not here. */
  vaultIds: string[];
}

/** Inclusive-start / exclusive-end positional range over the session log (§5.4). */
export interface EntryRange {
  /** Inclusive sequence position (SSE `id`, §9.3). Omit for "from the start". */
  start?: number;
  /** Exclusive upper bound. Omit for "to the end". */
  end?: number;
  /** Cap on the number of entries returned. */
  limit?: number;
}

/** A half-open time range used for tenant usage rollups (§8.12). */
export interface TimeRange {
  from?: Date;
  to?: Date;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Categories of vault credentials (§12.1). Drives how the provider resolves and
 * substitutes the binding host-side. `mcp_oauth` / `static_bearer` are MCP-scoped;
 * `environment_variable` becomes an `$MSB_<VAR>` placeholder substituted at egress.
 */
export type SecretCategory =
  | "environment_variable"
  | "static_bearer"
  | "mcp_oauth"
  /**
   * A git access token for a `repo` mount (§25.2). Registered host-side exactly like an
   * `environment_variable` secret, but the binding is scoped to the git host
   * (`allowedHosts`) and the guest's clone URL / `.git/config` carry only the
   * `$MSB_GIT_TOKEN_<slug>` placeholder. Substituted at egress (§25.4).
   */
  | "git_token";

/**
 * Opaque reference to a vault credential. Carries NO secret value — only the locator
 * the `SandboxProvider` implementation uses to resolve the real value host-side (§25.5).
 * The harness code that constructs this never sees the value.
 */
export interface SecretCredentialRef {
  tenantId: TenantId;
  vaultId: string;
  /** The vault-unique key: `secretName` for env-var creds, `mcpServerUrl` for MCP creds. */
  credentialKey: string;
}

/**
 * An opaque secret binding: a placeholder name the guest sees + a reference the provider
 * resolves host-side. **Never contains the secret value** (§25.1, §25.4, §25.5).
 *
 * - For `environment_variable`: `placeholderName` is the `$MSB_<VAR>` the guest env
 *   carries; substitution happens at the egress boundary (§25.4). Not supported in
 *   self-hosted sandboxes (§10.4).
 * - For `static_bearer` / `mcp_oauth`: `mcpServerUrl` scopes the credential to an MCP
 *   server; the token is injected by the backend MCP proxy, not visible to the harness
 *   or sandbox (§25.3).
 *
 * Callers MUST NOT log the contents of a `SecretBinding`.
 */
export interface SecretBinding {
  /** The placeholder visible inside the guest, e.g. `$MSB_GIT_TOKEN` (§12, §25.1). */
  placeholderName: string;
  category: SecretCategory;
  credentialRef: SecretCredentialRef;
  /** For MCP creds: the server URL (exact match incl. scheme/trailing slash, §19.5). */
  mcpServerUrl?: string;
  /**
   * Egress hosts the value may be substituted toward (§25.2/§25.4). The provider passes
   * these to microsandbox as `allowHost()` rules, so the secret can only ever be sent to
   * those hosts. Set for `git_token` bindings (the git host); empty/absent means the
   * provider registers no host allowance (and microsandbox therefore never substitutes).
   */
  allowedHosts?: string[];
}

// ---------------------------------------------------------------------------
// SandboxProvider
// ---------------------------------------------------------------------------

/**
 * Sandbox egress network policy (§6.2, §10.5, Appendix A.1 #3).
 *
 * - `unrestricted` compiles to microsandbox's `publicOnly()` preset — public internet
 *   allowed; private/loopback/link-local/cloud-metadata/**host** denied. This is NOT
 *   `allowAll()`.
 * - `limited` compiles to a default-deny `NetworkPolicy.builder()` plus explicit
 *   `allowHost()` rules for each entry in `allowedHosts`.
 */
export type NetworkPolicy =
  | { mode: "unrestricted" }
  | { mode: "limited"; allowedHosts: string[] };

/** A bind/named volume mounted into the microVM (§6.2 `mounts`, §13.3). */
export interface VolumeMount {
  /** Absolute path inside the guest (e.g. `/mnt/memory/<slug>/`). */
  guestPath: string;
  /** Object-store key or host path the provider stages into the VM. */
  source: string;
  readOnly?: boolean;
}

/** Per-exec resource limits (§10.2 `rlimit` passthrough). */
export interface ResourceLimits {
  memoryMiB?: number;
  /** CPU quota in fractional cores (e.g. 1.5 = 150% of one core). */
  cpuQuota?: number;
  fileDescriptors?: number;
}

/** Execution options for `SandboxProvider.exec` / `execStream` (§10.2). */
export interface ExecOptions {
  /** Command line; a string is run via the shell, an array is exec'd directly. */
  cmd: string | string[];
  cwd?: string;
  /** Non-secret execution env. Credentials go through `SecretBinding`, never here. */
  env?: Record<string, string>;
  /** Seconds. Default 120. */
  timeout?: number;
  rlimit?: ResourceLimits;
}

/** Result of a sandbox exec (§5.4 `execute`, §10.2). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when output exceeded the large-output policy and was truncated (§11.3). */
  truncated?: boolean;
}

/** One chunk of a streaming exec (§10.2 `execStream`). */
export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/**
 * Sandbox lifecycle status (Appendix A.1 #9, §10.3).
 * - `running` — VM is up.
 * - `stopped` — checkpointed to disk (config + fs persisted); cold reboot to resume.
 * - `crashed` — the VM died unexpectedly; re-provision from image/snapshot (§10.3).
 * - `draining` — shutting down (e.g. session ended, bindings being purged).
 */
export type SandboxStatus = "running" | "stopped" | "crashed" | "draining";

/** Opaque filesystem-snapshot identifier (§10.3; filesystem-only, no RAM). */
export type SnapshotId = string;

/**
 * A point-in-time resource sample for ONE microVM (§26.4).
 *
 * This is a **pull** sample: the provider asks the sandbox runtime for its current
 * counters when called. It is not a stream and nothing is exported to OTLP by taking it
 * (see `docs/observability.md` §3). The field set is the honest intersection of what the
 * pinned microsandbox SDK reports (`SandboxMetrics` in `microsandbox@0.6.6`) and what the
 * managed API needs — CPU, memory, disk I/O, network I/O, uptime.
 *
 * Byte counters (`diskRead/WriteBytes`, `netRx/TxBytes`) are cumulative since VM boot;
 * take a difference between two samples for a rate.
 */
export interface SandboxMetrics {
  /** CPU usage as a percentage of one core (100 = one core saturated). */
  cpuPercent: number;
  /** Resident memory used by the guest, in bytes. */
  memoryBytes: number;
  /** Memory ceiling the VM was provisioned with, in bytes. */
  memoryLimitBytes: number;
  /** Cumulative bytes read from disk since boot. */
  diskReadBytes: number;
  /** Cumulative bytes written to disk since boot. */
  diskWriteBytes: number;
  /** Cumulative bytes received on the VM's network interface since boot. */
  netRxBytes: number;
  /** Cumulative bytes transmitted on the VM's network interface since boot. */
  netTxBytes: number;
  /** Time since the VM booted, in milliseconds. */
  uptimeMs: number;
  /** When the sample was taken (ISO-8601). */
  sampledAt: string;
}

/**
 * A reference to a provisioned microVM. Stable across `stop`/`start` within a session.
 * Status is queried via `SandboxProvider.status`, not cached here.
 */
export interface SandboxHandle {
  id: string;
  /** Tenant-namespaced name, e.g. `t<tenant>-s<session>` (§27.2). */
  name: string;
  labels: { tenant: string; session: string };
}

/**
 * A repo to materialize into the sandbox (§25.2). Compiled from a `repo` mount by
 * `compileRepoClones`; carries NO token — only the guest-visible `$MSB_` placeholder
 * and/or an opaque {@link SecretCredentialRef} the provider resolves host-side.
 *
 * - `mode: "egress"` — the provider clones INSIDE the guest with
 *   `https://x-access-token:$MSB_GIT_TOKEN_<slug>@host/…`. The placeholder is what lands
 *   in `.git/config`; the real token is substituted at the egress boundary (§25.4).
 * - `mode: "staged"` — FALLBACK for non-TLS-interceptable hosts: the provider clones
 *   HOST-side into `volumeSource` (using the token host-side only) and the repo is
 *   bind-mounted **read-only**. No push support; the guest holds no credential at all.
 */
export interface RepoCloneSpec {
  /** Repo URL as configured (never contains credentials). */
  url: string;
  /** Absolute guest path the repo appears at. */
  guestPath: string;
  mode: "egress" | "staged";
  /** `egress`: the `$MSB_GIT_TOKEN_<slug>` placeholder used in the clone URL. */
  tokenPlaceholder?: string;
  /** `staged`: opaque ref the provider resolves host-side for the host clone. */
  credentialRef?: SecretCredentialRef;
  /** `staged`: tenant-scoped managed repo key the clone is staged into + bound from. */
  volumeSource?: string;
}

/**
 * Spec for provisioning (or re-creating) a microsandbox microVM (§5.4 `provision`,
 * §10.1, §27.2).
 *
 * **§25.5 invariant:** `secretBindings` carry ONLY placeholder names + credential
 * references — never raw secret values. `env` is for NON-SECRET literal env vars only;
 * credentials MUST go through `secretBindings`. The provider resolves refs host-side.
 */
export interface ProvisionSpec {
  /** Tenant-namespaced sandbox name (§10.1, §27.2). */
  name: string;
  /** OCI image ref, e.g. `ubuntu:22.04` (§6.2). */
  image: string;
  cpus: number;
  memoryMiB: number;
  diskMiB?: number;
  volumes?: VolumeMount[];
  /**
   * Secret bindings as `$MSB_` placeholders + credential refs. The provider writes the
   * real values into microsandbox's host-side store; the guest sees only placeholders.
   * NEVER place a secret value here (§25.1, §25.5).
   */
  secretBindings?: SecretBinding[];
  /**
   * Non-secret literal env vars for the guest. MUST NOT contain credentials — use
   * `secretBindings` for any secret (§25.5).
   */
  env?: Record<string, string>;
  /** Git repos to clone into the guest / stage host-side (§25.2). Never carries a token. */
  repos?: RepoCloneSpec[];
  networkPolicy: NetworkPolicy;
  labels: { tenant: string; session: string };
  /** Create detached so the VM survives backend restarts (§4.2, §10.1). */
  detached: boolean;
}

/**
 * Provider of microsandbox microVMs — the "Sandbox" abstraction (§5.3, §5.4, §10).
 *
 * Implementations: real (WP-1.3, NAPI SDK) and the testkit fake. The brain
 * (`AgentSession`) never calls this directly — tool calls route through the Sandbox
 * Operations adapter (§10.2) — but the session manager drives lifecycle methods.
 *
 * §25.5: this interface never accepts or returns a raw secret value. Secret material is
 * registered via {@link registerSecretBinding} / {@link ProvisionSpec.secretBindings}
 * as opaque {@link SecretBinding} refs the provider resolves host-side.
 */
export interface SandboxProvider {
  /** Create or re-create a microVM (§10.1). Detached VMs survive restarts. */
  provision(spec: ProvisionSpec): Promise<SandboxHandle>;

  /** Run a command in the VM, returning when complete (§10.2). */
  exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult>;

  /** Stream stdout/stderr chunks as the command runs (§10.2 `execStream`). */
  execStream(handle: SandboxHandle, opts: ExecOptions): AsyncIterable<ExecChunk>;

  /** Checkpoint: config + filesystem persisted to disk; VM stops (§10.3). */
  stop(handle: SandboxHandle): Promise<void>;

  /**
   * Cold reboot from a stopped checkpoint. Filesystem is preserved; processes are NOT
   * (§10.3) — the harness must surface this to the model on resume.
   */
  start(handle: SandboxHandle): Promise<void>;

  /** Filesystem-only snapshot of a stopped sandbox (§10.3). */
  snapshot(handle: SandboxHandle): Promise<SnapshotId>;

  /** Destroy the VM and purge its secret bindings (§10.3, §12.1). */
  destroy(handle: SandboxHandle): Promise<void>;

  /** Boot-time recovery: re-attach VMs by tenant/session labels (§4.2). */
  reattachByLabels(
    labels: { tenant: string; session?: string },
  ): Promise<SandboxHandle[]>;

  /** Current lifecycle status, incl. `crashed` (§10.3, Appendix A.1 #9). */
  status(handle: SandboxHandle): Promise<SandboxStatus>;

  /**
   * Point-in-time resource sample for a RUNNING VM (§26.4). Backs
   * `GET /v1/sessions/:id/metrics`.
   *
   * Returns `null` — never throws — when there is nothing to sample: the VM is stopped /
   * crashed / already destroyed, or this provider has no per-VM metrics to report at all.
   * A caller turns `null` into `404`.
   *
   * **Optional on purpose.** Not every `SandboxProvider` fronts a VM: the self-hosted
   * tool channel (§10.4) executes on the subscriber's own machine and the control plane
   * owns no VM to measure, so it implements no `metrics` rather than fabricating zeros.
   * Callers MUST feature-detect (`provider.metrics?.(handle)`); an absent method and a
   * `null` result mean the same thing to the API — no metrics for this session.
   */
  metrics?(handle: SandboxHandle): Promise<SandboxMetrics | null>;

  /**
   * Register a secret binding host-side after provisioning (§12.5 re-resolution /
   * rotation propagation). The guest never sees the value — only the placeholder.
   */
  registerSecretBinding(
    handle: SandboxHandle,
    binding: SecretBinding,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// SessionRuntime
// ---------------------------------------------------------------------------

/**
 * Session log entry — the durable JSONL record (§5.1, §5.4 `getEntries`/`emitEntry`).
 *
 * The full union of entry types lives in `@pi-managed/contracts` (WP-0.9); this is the
 * minimal positional shape the port needs. `payload` is opaque at the seam.
 */
export interface SessionEntry {
  /** Sequence position in the session log; the SSE `id` (§9.3). */
  position: number;
  /** Persisted event type (`{domain}.{action}`, §9.1). */
  type: string;
  id: string;
  createdAt: string;
  /** Typed fully in `@pi-managed/contracts`. */
  payload: unknown;
}

/**
 * Inbound event from the client (§9.2): `user.*` / `system.*`.
 * Full payload shapes live in `@pi-managed/contracts` (WP-0.9).
 */
export interface InboundEvent {
  type: string;
  id: string;
  createdAt: string;
  payload: unknown;
}

/**
 * Outbound event to the client (§9.2): `session.*` / `agent.*` / `span.*`.
 * Full payload shapes live in `@pi-managed/contracts` (WP-0.9).
 */
export interface OutboundEvent {
  type: string;
  id: string;
  createdAt: string;
  payload: unknown;
}

/**
 * Managed session state machine (§6.3). Starts in `idle`.
 * - `idle` — awaiting input; sandbox checkpointed.
 * - `running` — executing a turn.
 * - `rescheduling` — transient retry (3 retries, backoff 1s→4s→16s).
 * - `terminated` — unrecoverable error.
 */
export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

/**
 * The "Harness" abstraction — a Pi `AgentSession` bound to a durable JSONL log (§5.2,
 * §5.4). One in-process instance per active managed session (§4.2). Crash recovery =
 * `wake(sessionId)` boots a fresh `AgentSession` bound to the existing JSONL and resumes.
 *
 * This interface wraps Pi's `createAgentSession` / `AgentSession` / `SessionManager`
 * (read Pi `docs/sdk.md`): `wake` ≈ `createAgentSession({ sessionManager: open(jsonl) })`,
 * `sendEvent` ≈ `prompt` / `steer` / `followUp` + custom-tool/confirmation flows (§9.4/9.5),
 * `subscribe` ≈ `session.subscribe()`, `interrupt` ≈ `abort()`,
 * `getEntries` ≈ `SessionManager.getEntries()` (positional slice, §5.4).
 * It does NOT reimplement Pi internals.
 */
export interface SessionRuntime {
  /** Boot a fresh `AgentSession` bound to the existing JSONL for `sessionId` (§5.2). */
  wake(sessionId: SessionId): Promise<void>;

  /** Send a `user.*` / `system.*` inbound event (§9.2). */
  sendEvent(event: InboundEvent): Promise<void>;

  /** Subscribe to `session.*` / `agent.*` / `span.*` outbound events (§9). */
  subscribe(): AsyncIterable<OutboundEvent>;

  /** Interrupt the current turn (§9.2 `user.interrupt`); follow with `sendEvent`. */
  interrupt(): Promise<void>;

  /** Positional slice of the session log (§5.4 `getEntries`). */
  getEntries(range?: EntryRange): Promise<SessionEntry[]>;

  /** Current state-machine status (§6.3). */
  status(): SessionStatus;
}

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

/**
 * Resolves vault credentials into opaque {@link SecretBinding} refs for a session
 * (§12, §25.1, §25.4).
 *
 * §25.5 invariant: this interface NEVER exposes raw secret values to the caller
 * (harness). It returns only opaque `SecretBinding` refs (placeholder name + credential
 * reference) that the `SandboxProvider` registers host-side. Callers MUST NOT log
 * binding contents.
 *
 * MCP credentials (`static_bearer` / `mcp_oauth`) are resolved by the backend MCP proxy
 * at request time (§25.3), not by this store; this store only produces the binding ref
 * the proxy consumes. `environment_variable` creds become `$MSB_` placeholder bindings.
 */
export interface SecretStore {
  /**
   * Resolve the bindings for a session: env-var creds → `$MSB_` placeholder bindings;
   * MCP creds → refs the MCP proxy injects. Returns bindings the SandboxProvider
   * registers host-side. NEVER returns secret values (§12, §25.1, §25.4).
   */
  resolveBindingsForSession(ctx: SessionContext): Promise<SecretBinding[]>;

  /**
   * Re-resolution hook (§12.5) — propagate rotation/archival/deletion to running
   * sessions without a restart, and refresh expired `mcp_oauth` tokens. Implementations
   * update the host-side bindings via the SandboxProvider.
   */
  revalidate(ctx: SessionContext): Promise<void>;
}

/**
 * Resolves a session's **model-provider API keys** (§4.2). Distinct from
 * {@link SecretStore}: those keys are the tenant's own credentials for calling the
 * model API, decrypted host-side into the per-session in-memory
 * `AuthStorage`. They are NEVER registered as sandbox bindings and NEVER exposed to
 * the guest. The map is `providerId → apiKey` (e.g. `{ openai: "sk-…" }`).
 *
 * Fail-closed: an unresolved provider key must abort the session before any model call
 * (so a session can never fall through to a provider key in the host's own
 * environment, §4.2 / R2.7).
 */
export interface ProviderKeyResolver {
  resolveProviderKeys(ctx: SessionContext): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// ObjectStore
// ---------------------------------------------------------------------------

/** Metadata for a stored object (§28). */
export interface ObjectMeta {
  key: string;
  size: number;
  etag?: string;
  version?: string;
  lastModified: string;
}

/** Result of a put/conditional-put (§28). */
export interface PutResult {
  etag?: string;
  version?: string;
}

/**
 * Streaming object store for files, memory-store contents, snapshots, and JSONL sync
 * (§28, §21, §13). Implementations: local filesystem (v1 default, §7.3) and
 * S3-compatible (SaaS). Keys per `docs/db-schema.md` layout.
 */
export interface ObjectStore {
  /** Whether the backend supports object versioning (§28 backup note). */
  readonly versioningSupported: boolean;

  /** Streaming put (§28). */
  put(key: string, stream: ReadableStream<Uint8Array>): Promise<PutResult>;

  /** Streaming get (§28). */
  get(key: string): Promise<ReadableStream<Uint8Array>>;

  /**
   * Conditional put for JSONL sync (§28): succeeds only if `ifMatch` (etag/version)
   * still matches. Used so local-write + object-store-sync never silently overwrites a
   * concurrent update.
   */
  conditionalPut(
    key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult>;

  /** Delete an object (§28). */
  delete(key: string): Promise<void>;

  /**
   * Permanently purge an object *and all of its versions* (§13.6 redaction).
   *
   * On a versioned store a plain {@link delete} only writes a delete marker,
   * leaving prior versions — the plaintext — retrievable by `VersionId`;
   * `hardDelete` removes every version and delete marker so redacted content is
   * unrecoverable. On a non-versioned store this is equivalent to {@link delete}.
   * Idempotent for a missing key.
   */
  hardDelete(key: string): Promise<void>;

  /**
   * Fetch a single object's metadata without a full {@link list} (§28). Returns
   * `null` when the object does not exist. Lets callers (e.g. JSONL-sync etag
   * recovery) read one object's etag/size in O(1) instead of walking the store.
   */
  head(key: string): Promise<ObjectMeta | null>;

  /** List objects under a prefix (§28). */
  list(prefix: string): AsyncIterable<ObjectMeta>;
}

// ---------------------------------------------------------------------------
// UsageRecorder
// ---------------------------------------------------------------------------

/** Token counts for a single model request, as the provider reports them (§9.7). */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Cumulative usage for a session or tenant (§9.7). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Sum of all token fields. */
  totalTokens: number;
  /** USD cost via the per-model price table (§9.7). */
  usd: number;
}

/** Hard caps enforced server-side; on breach the session is interrupted (§6.3). */
export interface Budget {
  maxTokens?: number;
  maxUsd?: number;
}

/** Budget-check outcome (§6.3 `budget_exhausted` stop). */
export interface BudgetCheck {
  exceeded: boolean;
  /** Present when `exceeded`; a machine-readable reason (§6.3). */
  reason?: string;
}

/**
 * Records per-model-request token usage and enforces budgets (§9.7, §6.3, §26.2).
 *
 * Token counts are recorded exactly as each provider reports them — cache TTL and
 * pricing are provider-dependent (§9.7); USD is derived from a per-model price table
 * (config). Used for cost tracking, budget enforcement (`budget_exhausted` stop, §6.3),
 * and quota accounting.
 */
export interface UsageRecorder {
  /** Record one model request's tokens for a session (§9.7). */
  record(sessionId: SessionId, model: string, tokens: TokenCounts): Promise<void>;

  /** USD cost for a model request via the per-model price table (§9.7). */
  usdCost(model: string, tokens: TokenCounts): number;

  /** Cumulative usage for a session (§6.3, §26.2). */
  cumulativeForSession(sessionId: SessionId): Promise<Usage>;

  /** Check a session against a budget; feeds the `budget_exhausted` stop (§6.3). */
  checkBudget(sessionId: SessionId, budget: Budget): Promise<BudgetCheck>;

  /** Per-tenant rollup for billing/quota (§8.12, §27.3). */
  rollupForTenant(tenantId: TenantId, range?: TimeRange): Promise<Usage>;
}

// ---------------------------------------------------------------------------
// Clock / Scheduler
// ---------------------------------------------------------------------------

/**
 * Injectable clock for deterministic tests (§17.8). The scheduler's wall-clock
 * semantics are literal (spring-forward skip, fall-back double-fire, §17.2), so time
 * must be injectable to test DST and double-fire behavior without waiting.
 */
export interface Clock {
  now(): Date;
}

/**
 * The cron-loop tick abstraction (§17.8). Exactly-once firing is enforced in Postgres
 * (`(job_id, scheduled_at)` unique), not here; `tick()` computes due jobs and creates
 * sessions. Injectable so tests can drive the loop deterministically.
 */
export interface Scheduler {
  /** Advance one tick: compute due jobs, claim and fire them (§17.8). */
  tick(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WebhookSink
// ---------------------------------------------------------------------------

/**
 * A thin webhook payload: event `type` + `id` + `createdAt` only (§23.2). Recipients
 * fetch the full object on receipt. `event.id` is unique per event, not per delivery —
 * a repeated `id` is a retry to discard.
 */
export interface WebhookEvent {
  type: string;
  id: string;
  createdAt: string;
}

/**
 * Enqueue a thin webhook payload (§23). The real dispatcher (Phase 2, WP-2.5) handles
 * retries, `X-Webhook-Signature`, auto-disable, and the persisted queue; this sink is
 * the enqueue seam so Phase-1 subsystems can emit lifecycle events without depending
 * on the dispatcher.
 */
export interface WebhookSink {
  dispatch(event: WebhookEvent): Promise<void>;
}
