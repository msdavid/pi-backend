/**
 * @pi-managed/backend — the Pi Managed Backend service.
 *
 * P0.1 scaffold: layered config, structured logging + OTEL, health/readiness
 * endpoints, and the Fastify app factory + composition root. Subsystems land in
 * Phases 0–5 per implementation-plan.md.
 */

/** Package version (placeholder until real code lands). */
export const BACKEND_VERSION = "0.0.0";

/** Internal seam interfaces (ports) — WP-0.10. See `domain/ports.ts`. */
export * from "./domain/ports.js";

// WP-5.5 consolidated per-tier limit surface (§12.4/§17.3/§27.3/§6.3).
export * from "./domain/tier-config/index.js";

// WP-5.1 public plugin contracts & registration API (default impls overridable).
export * from "./plugins/index.js";

// P0.1 scaffold surface.
export * from "./infra/config/index.js";
export {
  createLogger,
  childLogger,
  initTelemetry,
  type Logger,
  type TelemetryHandle,
  type SessionLogContext,
} from "./infra/telemetry/index.js";
export {
  healthRoutes,
  DEFAULT_READINESS_CHECKS,
  type ReadinessCheck,
  type ReadinessResult,
  type ReadinessCheckEntry,
} from "./api/health.js";
export {
  createApp,
  startServer,
  type CreateAppOptions,
} from "./server.js";

// R7.2: the single error base for the whole backend. Declared in the domain (no
// HTTP dependency); rendered to status + ErrorEnvelope once, at the Fastify edge.
export { ApiError } from "./domain/errors.js";

// WP-5.3 Billing integration hooks (§29.6): pluggable BillingSink (no-op default +
// webhook-emitting impl) + the metering hook wiring the UsageRecorder to a sink.
export {
  NoopBillingSink,
  NOOP_BILLING_SINK,
  WebhookBillingSink,
  defaultBillingBackoff,
  DEFAULT_BILLING_MAX_ATTEMPTS,
  createMeteringHook,
  type MeteringEvent,
  type BillingSink,
  type WebhookBillingSinkOptions,
  type MeteringRecord,
  type MeteringHook,
} from "./domain/billing/index.js";

// WP-1.13 composition root: the fully-wired app + SessionManager registry + boot.
export {
  createManagedApp,
  startManagedServer,
  SessionManager,
  DEFAULT_REGISTRY_IDLE_MS,
  type ManagedApp,
  type CreateManagedAppOptions,
  type SessionManagerDeps,
} from "./app.js";

// P0.2 Postgres layer: pool, tenant-scoped query helper, migrations, DB readiness.
export {
  createPool,
  query,
  closePool,
  tenantScopedQuery,
  tenantScopedAll,
  TenantScopeError,
  TENANT_ID_COLUMN,
  dbReadinessCheck,
  runMigrations,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  type TenantCtx,
  type Pool,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
  type RunMigrationsOptions,
} from "./infra/db/index.js";

// P0.3 Object store: filesystem (v1 default) + S3-compatible impls, factory, readiness.
export {
  FilesystemObjectStore,
  S3ObjectStore,
  createS3ObjectStore,
  ensureS3Bucket,
  createObjectStore,
  objectStoreFromConfig,
  createObjectStoreReadinessCheck,
  type ObjectStoreConfig,
  type FilesystemObjectStoreOptions,
  type ObjectStoreProbeResult,
  type S3ObjectStoreOptions,
  type S3Credentials,
} from "./infra/objectstore/index.js";

// P0.4 Tenants, API keys (argon2id-hashed, shown once), and bearer auth.
export {
  createTenant,
  getTenant,
  getOrCreateImplicitTenant,
  IMPLICIT_TENANT_ID,
  type TenantRow,
  type CreateTenantInput,
} from "./domain/tenant/tenant.js";
export {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  type IssuedApiKey,
} from "./domain/tenant/api-key.js";
export {
  createAuthHandler,
  PUBLIC_PATHS,
  type AuthHook,
} from "./api/middleware/auth.js";
export { tenantRoutes } from "./api/tenant.js";

// WP-5.2 Tenant onboarding (SaaS): public sign-up service + route (§29.6, §24.3).
export {
  signup,
  tenantForEmail,
  SignupInputSchema,
  DEFAULT_INSTALL_COMMAND,
  DEFAULT_API_KEY_REF,
  type SignupInput,
  type SignupResult,
} from "./domain/onboarding/signup.js";
export { onboardingRoutes, type OnboardingRoutesOptions } from "./api/onboarding.js";

// WP-1.1 Agents: domain service + API routes.
export {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  archiveAgent,
  listVersions,
  getVersion,
  isAgentArchived,
  type ListAgentsOptions,
} from "./domain/agent/agent.js";
export { agentRoutes } from "./api/agents.js";

// WP-1.2 Environments: CRUD + archive + sandbox-spec compilation (§6.2).
export {
  createEnvironment,
  listEnvironments,
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  archiveEnvironment,
  type ListEnvironmentsOptions,
  type EnvCursor,
} from "./domain/environment/environment.js";
export {
  compileProvisionSpec,
  compileNetworkPolicy,
  compileVolumeMounts,
  type CompileSessionCtx,
} from "./domain/environment/compile-spec.js";
export { environmentRoutes } from "./api/environments.js";

// WP-4.1 Self-hosted work queue (§10.4): work queue, work-stats, work.stop,
// environment-scoped worker keys, and the unsupported-features matrix.
export {
  enqueue,
  claim,
  postResult,
  fetchWorkItem,
  completeWorkItem,
  toWorkItem,
  getWorkStats,
  stopWork,
  issueWorkerKey,
  resolveWorkerKey,
  assertOrgKey,
  requireWorkerKeyForEnv,
  assertSelfHostedSessionConstraints,
  assertSelfHostedConstraintsForEnv,
  selfHostedRoutes,
  WORKER_SCOPE_PREFIX,
  type WorkItem,
  type WorkItemStatus,
  type WorkSpec,
  type ToolResultEvent,
  type WorkStopInput,
  type IssuedWorkerKey,
  type ResolvedWorkerKey,
  type SessionConstraintInput,
} from "./domain/self-hosted/index.js";

// WP-4.3 Multi-host sandbox scheduling (§7.2, §4.2): host-pool registry,
// placement router, liveness monitor, and the routing MultiHostSandboxProvider
// (delegates to per-host local MicrosandboxProviders over the network).
export {
  HostRegistry,
  HostNotFoundError,
  chooseHost,
  NoHostAvailableError,
  LivenessMonitor,
  type RegisterHostInput,
  type ScoredHost,
  type LivenessMonitorOptions,
  type SandboxHost,
  type UnhealthyReason,
  type HostRegistryPort,
  type LivenessRegistryPort,
} from "./infra/sandbox-host-pool/index.js";
export {
  MultiHostSandboxProvider,
  HttpHostAgent,
  HostUnavailableError,
  type MultiHostSandboxProviderOptions,
  type HostAgent,
  type HostAgentFactory,
} from "./infra/sandbox/multi-host-provider.js";

// WP-1.6 Sessions: domain service (repo + create/fork) + DB-backed SessionStore + routes.
export {
  createSession,
  forkSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  fetchSessionRow,
  readSessionOverrides,
  resolveEffectiveConfig,
  applyOverrides,
  sessionJsonlObjectKey,
  getSessionEntries,
  getSessionTree,
  getSessionMessages,
  getSessionUsage,
  EMPTY_USAGE,
  DbSessionStore,
  sessionLocalJsonlPath,
  type SessionRow,
  type ListSessionsOptions,
  type InsertSessionInput,
  type EntriesQuery,
} from "./domain/session/index.js";
export { sessionRoutes } from "./api/sessions.js";

// WP-1.7 Events API + SSE streaming (send / history / stream).
export { eventRoutes, type EventRoutesOptions } from "./api/events.js";
export {
  encodeSseFrame,
  type SseFrame,
  inboundToPorts,
  outboundWireData,
  entryWireData,
  entryToHistoryItem,
  generateEventId,
  nowIso,
  replayFromLastEventId,
  type ReplayResult,
  reconcileDeltas,
  parseEventDeltas,
  DELTAABLE_TYPES,
  type EventDeltaSet,
  type ReconciledFrames,
  pipeSessionStream,
  type PipeSessionStreamOptions,
  type HistoryItem,
} from "./domain/event-stream/index.js";

// WP-1.8 Built-in toolset configuration: config schema, validation, defaults,
// permission-policy resolution, and materialization (§11.1 / §22.2).
export {
  BUILT_IN_TOOL_NAMES,
  isBuiltInToolName,
  validateToolsetConfig,
  DEFAULT_TOOLSET_CONFIG,
  DEFAULT_BUILTIN_PERMISSION_POLICY,
  DEFAULT_MCP_PERMISSION_POLICY,
  EVERYTHING_OFF_DEFAULT_CONFIG,
  enableOnly,
  getPermissionPolicy,
  getMcpPermissionPolicy,
  resolveTools,
  materializeToolset,
  type BuiltInToolName,
  type ToolsetConfig,
  type ToolConfig,
  type PermissionPolicy,
  type ToolsConfig,
  type ResolvedTool,
  type MaterializedToolset,
} from "./domain/toolset/index.js";

// P0.5 cross-cutting HTTP middleware: idempotency replay, rate limiting, pagination.
export { idempotencyMiddleware } from "./api/middleware/idempotency.js";
export { rateLimitMiddleware } from "./api/middleware/rate-limit.js";
export { quotaMiddleware, type QuotaMiddlewareOptions } from "./api/middleware/quota.js";
export {
  parseListParams,
  paginate,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type ParsedListParams,
} from "./api/middleware/pagination.js";

// WP-1.9 Vaults, credentials, AES-256-GCM encryption, and the SecretStore impl.
export {
  encryptSecret,
  decryptSecret,
  createVaultCrypto,
  getDefaultVaultCrypto,
  loadVaultCryptoKey,
  ENV_KEY as VAULT_ENV_KEY,
  ENV_KEY_FILE as VAULT_ENV_KEY_FILE,
  type EncryptedSecret,
  type VaultCrypto,
} from "./domain/vault/crypto.js";
export {
  createVault,
  listVaults,
  getVault,
  deleteVault,
  archiveVault,
} from "./domain/vault/vault.js";
export {
  addCredential,
  listCredentials,
  archiveCredential,
  MAX_CREDENTIALS_PER_VAULT,
} from "./domain/vault/credential.js";
export { createVaultSecretStore } from "./domain/vault/secret-store.js";
export { vaultRoutes } from "./api/vaults.js";

// WP-1.10 Usage tracking + budget enforcement: price table, recorder, budget hook.
export {
  loadPriceTable,
  priceFor,
  PriceEntrySchema,
  PriceTableSchema,
  FALLBACK_MODEL_KEY,
  USAGE_PRICES_FILE_ENV,
  DEFAULT_PRICES_PATH,
  EMBEDDED_DEFAULT_PRICES,
  type PriceEntry,
  type PriceTable,
} from "./domain/usage/prices.js";
export {
  PgUsageRecorder,
  createUsageRecorder,
  type UsageRecorderOptions,
} from "./domain/usage/usage-recorder.js";
export {
  enforceBudget,
  BUDGET_STOP_REASON,
  type BudgetEnforcement,
} from "./domain/usage/budget.js";

// WP-4.4 Quota enforcement + tier mapping (§27.3): per-tenant limits on
// concurrent sessions/sandboxes, jobs, vault credentials, memory stores, file
// storage, and monthly token spend. Defaults seeded from docs/capacity.md.
export {
  DEFAULT_QUOTA_PLANS,
  QUOTA_PLAN_NAMES,
  planForName,
  getQuotaPlanForTenant,
  getCurrentUsage,
  checkQuota,
  type QuotaPlan,
  type QuotaPlanName,
  type QuotaUsage,
  type QuotaResource,
  type QuotaCheck,
  type QuotaCheckOptions,
} from "./domain/quota/index.js";

// WP-1.12 Files: independent file resources (CRUD over the object store) + the
// session-outputs slice (read an idle session's /mnt/session/outputs/ live).
export {
  uploadFile,
  listFiles,
  fetchFileRow,
  getFile,
  downloadFile,
  deleteFile,
  toFile,
  fileObjectKey,
  listSessionOutputs,
  downloadSessionOutput,
  OUTPUTS_DIR,
  type FileRow,
  type UploadFileInput,
  type ListFilesOptions,
  type DownloadResult,
  type SessionSandboxResolver,
  type SessionOutputRef,
  type SessionOutputDownload,
} from "./domain/file/index.js";
export { fileRoutes } from "./api/files.js";

// WP-2.2 Memory stores: cross-session memory (stores + memories + versions +
// redact + mount pipeline + write-back sync).
export {
  slugify,
  createMemoryStore,
  listMemoryStores,
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
  fetchStoreRow,
  storeObjectKeyPrefix,
  versionContentObjectKey,
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  writeVersion,
  sha256Hex,
  listMemoryVersions,
  getMemoryVersion,
  redactVersion,
  purgeExpiredVersions,
  mountMemoryStores,
  mountPathFor,
  systemPromptNoteFor,
  systemPromptNotes,
  stageMemoryVolume,
  syncMemoryVolumeBack,
  InMemoryVolumeStore,
  VERSION_RETENTION_DAYS,
  MAX_MEMORIES_PER_STORE,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MEMORY_STORES_PER_SESSION,
  DEFAULT_KEEP_RECENT,
  type CreateMemoryStoreInput,
  type UpdateMemoryStoreInput,
  type ListMemoryStoresOptions,
  type ListMemoriesOptions,
  type ListVersionsOptions,
  type VolumeStore,
} from "./domain/memory/index.js";
export { memoryRoutes } from "./api/memory-stores.js";

// WP-2.1 Scheduled jobs (crons): cron parser, job service, tick loop, routes.
export {
  parseCron,
  nextOccurrence,
  instantsForWallClock,
  wallOf,
  validateSchedule,
  jitterMs,
  JITTER_MAX_MS,
  CronScheduler,
  startSchedulerLoop,
  enumerateOccurrences,
  createJob,
  listJobs,
  getJob,
  fetchJobRow,
  pauseJob,
  unpauseJob,
  archiveJob,
  runJob,
  listRuns,
  toJob,
  executeJobRun,
  autoPause,
  MAX_JOBS_PER_TENANT,
  DEFAULT_CATCHUP_MS,
  DEFAULT_TICK_INTERVAL_MS,
  type ParsedCron,
  type WallClock,
  type JobRow,
  type ListJobsOptions,
  type TriggerSessionFn,
  type RunOutcome,
  type SchedulerDeps,
  type SchedulerLoopHandle,
  type SchedulerLoopOptions,
} from "./domain/scheduler/index.js";
export { jobRoutes } from "./api/jobs.js";

// WP-2.5 Webhooks: endpoint registration, signature, persisted at-least-once retry
// queue, auto-disable, SSRF guard, and the tenant-aware event-source seam (§23).
export {
  signWebhookPayload,
  verifyWebhookSignature,
  DEFAULT_SIGNATURE_MAX_AGE_MS,
  defaultWebhookDnsResolver,
  WebhookSsrfError,
  createWebhook,
  listWebhooks,
  getWebhook,
  getWebhookWithSecret,
  deleteWebhook,
  testDelivery,
  decryptStoredSecret,
  disableWebhook,
  shouldDisableForStreak,
  DISABLE_STREAK_THRESHOLD,
  WebhookDispatcher,
  startDispatcherLoop,
  defaultBackoff,
  DEFAULT_DISPATCHER_INTERVAL_MS,
  DEFAULT_DISPATCHER_BATCH,
  DEFAULT_MAX_ATTEMPTS,
  createWebhookEventSource,
  NOOP_EVENT_SOURCE,
  type VerifyResult,
  type WebhookDnsResolver,
  type WebhookStatus,
  type WebhookRow,
  type CreatedWebhook,
  type WebhookWithSecret,
  type TestDeliveryResult,
  type TestDeliveryDeps,
  type DispatcherOptions,
  type DispatcherHandle,
  type WebhookEventSource,
} from "./domain/webhook/index.js";
export { webhookRoutes } from "./api/webhooks.js";

// WP-3.2 Outcomes: define/list service + grader + iteration loop + events + routes
// (§16). `user.define_outcome` → produce→grade→feedback loop → result taxonomy
// (§16.5). The grader is a separate AgentSession with its own context + rubric,
// reading /mnt/session/outputs/ (§16.1). Deliverables via the Files API (§16.6).
export {
  defineOutcome,
  listOutcomes,
  fetchActiveOutcomeRow,
  fetchOutcomeRow,
  updateOutcomeStatus,
  toOutcome,
  isTerminalResult,
  DEFAULT_MAX_ITERATIONS,
  MAX_MAX_ITERATIONS,
  runOutcomeLoop,
  SubagentGrader,
  SandboxOutputsResolver,
  FakeGrader,
  FakeProducer,
  parseVerdict,
  getRubricFileContent,
  isRubricFileRef,
  emitOutcomeEvaluationStart,
  emitOutcomeEvaluationEnd,
  emitOutcomeSessionEnded,
  type DefineOutcomeInput,
  type ListOutcomesOptions,
  type OutcomeRow,
  type OutcomeProducer,
  type OutcomeLoopDeps,
  type Grader,
  type GradeInput,
  type GraderEvaluation,
  type GraderOutputs,
  type GraderOutputsResolver,
  type GraderSessionFactory,
  type OutcomeEventSink,
  type CriterionVerdict,
  type RubricFileRef,
} from "./domain/outcome/index.js";
export { sessionOutcomeRoutes, type OutcomeRoutesOptions } from "./api/sessions-outcomes.js";

// WP-1.4 + WP-1.5 Session manager: Operations adapter (all seven built-in tools → microVM)
// + the Harness (per-session AgentSession lifecycle, state machine, idle policy, crash
// recovery, JSONL durability, config materialization).
export {
  SessionStateMachine,
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  LEGAL_TRANSITIONS,
  isLegalTransition,
  STOP_REASONS_FOR,
  IdlePolicy,
  DEFAULT_IDLE_TIMEOUT_MS,
  idleTimeoutMsFromEnv,
  CrashRecovery,
  JsonlSync,
  DEFAULT_SYNC_INTERVAL_MS,
  PiAgentSessionFactory,
  ManagedSessionRuntime,
  InMemorySessionStore,
  createRemoteTools,
  assertRemoteOperations,
  disableUserBash,
  safeFetch,
  isPrivateAddress,
  resolveAndAssertPublic,
  SsrfBlockedError,
  maybeSpillLargeOutput,
  SPILL_TOKEN_THRESHOLD,
  type StateTransition,
  type RetrySchedule,
  type StateMachineClock,
  type IdleScheduleOptions,
  type CrashRecoveryEvent,
  type CrashRecoveryOptions,
  type JsonlSyncEvent,
  type ManagedSessionRuntimeOptions,
  type AgentSessionFactory,
  type AgentSessionLike,
  type AgentSessionEventLike,
  type CreateAgentSessionOptions,
  type CustomToolDefinition,
  type InlineExtensionFactory,
  type ProviderKeys,
  type ResolvedAgentMaterial,
  type SessionEntryLike,
  type SessionMessageLike,
  type SessionRecord,
  type SessionStore,
} from "./domain/session-manager/index.js";

// R7.1 — session-worker process pool. `SESSION_WORKER_MODE=pool` runs each session's
// `ManagedSessionRuntime` in one of N bounded child processes (sharded by session id), so
// a harness crash has a bounded blast radius. `inproc` (default) is the unchanged
// in-process path. See `docs/session-worker-pool.md`.
export {
  SessionWorkerPool,
  RemoteSessionRuntime,
  defaultWorkerEntry,
  shardFor,
  DEFAULT_SESSION_WORKERS,
  DEFAULT_SESSIONS_PER_WORKER,
  RESPAWN_DELAY_MS,
  type SessionWorkerPoolOptions,
  type RemoteSessionRuntimeOptions,
  type RemoteSessionTransport,
  type RemoteSessionState,
  type SessionWorkerOverrides,
  type SessionWorkerOverridesModule,
} from "./domain/session-worker/index.js";

// WP-2.3 Permission gate: a managed Pi extension that intercepts `tool_call` for
// `always_ask` tools, blocks execution, emits `session.status_idle`
// (`stopReason: requires_action` + blocking event IDs), and awaits a
// `user.tool_confirmation` round-trip (§9.5). Built-ins default `always_allow`,
// MCP default `always_ask` (§22.1); running sessions keep creation-time config (§22.2).
export {
  createPermissionGate,
  onToolCall,
  type PermissionGateOptions,
} from "./pi-extensions/permission-gate/index.js";
export {
  ConfirmationCoordinator,
  DEFAULT_DENY_MESSAGE,
  type BlockingToolCall,
  type ConfirmationDecision,
  type ConfirmationCoordinatorHooks,
} from "./pi-extensions/permission-gate/confirmation.js";
export {
  snapshotToolsetConfig,
  isAlwaysAsk,
  resolvePermissionPolicy,
  isBuiltInTool,
  type PermissionPolicySnapshot,
} from "./pi-extensions/permission-gate/policy.js";

// WP-3.4 Custom tools: a managed Pi extension that registers a `defineTool` shim per
// custom tool declared on the agent. The shim's `execute` relays `agent.custom_tool_use`
// (carrying `customToolUseId` = the event id), pauses the session
// (`session.status_idle` / `requires_action` + the blocking id), and resumes on
// `user.custom_tool_result` keyed by `customToolUseId` (§9.4). The model never executes
// anything on its own (§11.2). Works cross-thread via 3.1's cross-posting (§18.7).
// Permissions do NOT apply (§22 preamble — the client executes custom tools, not the
// agent's sandbox; contrast with permission-gate above).
export {
  createCustomToolsRelay,
  buildCustomToolShim,
  type CustomToolDeclaration,
  type CustomToolsRelayOptions,
} from "./pi-extensions/custom-tools/index.js";
export {
  CustomToolCoordinator,
  type CustomToolRelay,
  type CustomToolUse,
  type CustomToolUseRequest,
  type CustomToolResult,
  type CustomToolCoordinatorHooks,
} from "./pi-extensions/custom-tools/relay.js";
export {
  ChildThreadCustomToolRelay,
  type ChildThreadCustomToolRelayOptions,
} from "./pi-extensions/custom-tools/cross-thread.js";
