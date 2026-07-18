/**
 * Layered configuration for the Pi Managed Backend.
 *
 * Precedence (highest wins): environment variables > config file > schema defaults.
 * Config is the single source of runtime knobs; subsystems receive a validated
 * {@link Config} and never read `process.env` directly.
 *
 * Config errors are **fatal**: an invalid value (bad port, unknown log level, …)
 * prints a clear message to stderr and exits the process with code 1. The service
 * must never boot with a half-parsed config.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
// The wire *contract* for the console mode (single zod source, CONVENTIONS
// "Validation") — the enum is part of the GET /console/config response shape.
import {
  ConsoleMode,
  DEFAULT_LOW_BALANCE_THRESHOLD_MICROS,
  DEFAULT_METERING_BUCKET_MS,
} from "@pi-managed/contracts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const LogLevel = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export type LogLevel = z.infer<typeof LogLevel>;

export const SandboxRuntime = z.enum(["enabled", "disabled"]);
export type SandboxRuntime = z.infer<typeof SandboxRuntime>;

/** Backing store for rate-limit token buckets (§27.3). */
export const RateLimitStore = z.enum(["memory", "postgres"]);
export type RateLimitStore = z.infer<typeof RateLimitStore>;

/**
 * Which sandbox provider the composition root builds (R6.7, §7.2).
 * `single` → the host-local {@link MicrosandboxProvider}; `multi` → the routing
 * {@link MultiHostSandboxProvider} over the host pool ({@link ConfigSchema.sandboxHosts}).
 */
export const SandboxMode = z.enum(["single", "multi"]);
export type SandboxMode = z.infer<typeof SandboxMode>;

/**
 * Where the session harnesses run (R7.1). `inproc` — every `ManagedSessionRuntime` in the
 * control-plane process (the default, unchanged). `pool` — runtimes in bounded child
 * processes sharded by session id, so a harness crash has a bounded blast radius.
 */
export const SessionWorkerMode = z.enum(["inproc", "pool"]);
export type SessionWorkerMode = z.infer<typeof SessionWorkerMode>;

/**
 * Which {@link BillingSink} the composition root wires into the usage recorder's
 * metering hook (§29.6). `none` — the no-op sink (billing disabled; the default,
 * and the only behavior self-hosted deployments get). `webhook` — post each
 * metering event to {@link ConfigSchema.billingWebhookUrl}, HMAC-signed.
 */
export const BillingSinkKind = z.enum(["none", "webhook"]);
export type BillingSinkKind = z.infer<typeof BillingSinkKind>;

/**
 * One KVM host in the pool (R6.7, §7.2). Mirrors `RegisterHostInput`
 * (`infra/sandbox-host-pool/registry.ts`): the composition root upserts each entry into
 * the `sandbox_hosts` registry on boot, so config is the declarative source of the pool
 * while Postgres stays the runtime source of truth (rotation status, placements).
 */
export const SandboxHostConfigSchema = z.object({
  /** `host_…` prefixed id (§6.6). Also selects the per-host auth token (see below). */
  id: z.string().min(1),
  /** Host-agent endpoint, e.g. `https://kvm-1.internal:8443`. */
  endpoint: z.string().url(),
  /** Total CPU capacity in cores. */
  cpus: z.number().int().positive(),
  /** Total memory capacity in MiB. */
  memoryMiB: z.number().int().positive(),
  /** Placement constraints (§4.2). */
  labels: z.record(z.string(), z.string()).default({}),
});
export type SandboxHostConfig = z.infer<typeof SandboxHostConfigSchema>;

/**
 * Validated service configuration. Field names mirror the env var that overrides
 * them (camelCased) so the precedence is obvious. OTEL fields are passthrough
 * strings consumed by {@link infra/telemetry/otel.ts}.
 */
export const ConfigSchema = z.object({
  /** TCP port the HTTP server binds. Env `PORT`. */
  port: z.number().int().min(1).max(65535).default(3000),
  /** pino log level. Env `LOG_LEVEL`. */
  logLevel: LogLevel.default("info"),
  /**
   * Postgres connection URL. Optional in P0.1 (no pool yet); `readyz` reports the
   * db check as `down` while unset. Required once WP-0.2 lands the query layer.
   */
  dbUrl: z.string().url().optional(),
  /**
   * Max Postgres pool connections (PERF-1). Env `DB_POOL_MAX`, default 25. `pg`'s own
   * default is 10; a busy control plane (request handlers + the background loops wired in
   * `app.ts`) exhausts that, and — combined with the unbounded default acquire timeout —
   * turns exhaustion into an unbounded hang rather than a fast, observable error.
   */
  dbPoolMax: z.number().int().positive().default(25),
  /**
   * Max time (ms) to wait to acquire a pooled connection before failing (PERF-1). Env
   * `DB_CONNECTION_TIMEOUT_MS`, default 10_000. `pg`'s default is `0` (wait forever), which
   * is exactly the "queues forever" failure mode this closes.
   */
  dbConnectionTimeoutMs: z.number().int().nonnegative().default(10_000),
  /**
   * Server-side `statement_timeout` (ms) applied to every pooled connection (PERF-1). Env
   * `DB_STATEMENT_TIMEOUT_MS`, default 30_000. A runaway query is cancelled instead of
   * pinning a connection indefinitely. `0` disables the timeout.
   */
  dbStatementTimeoutMs: z.number().int().nonnegative().default(30_000),
  /** Root directory of the local object store (§7.3, §28). Env `OBJECT_STORE_ROOT`. */
  objectStoreRoot: z.string().min(1).default("./data/objectstore"),
  /**
   * Durable host-side root for per-session local JSONL logs (R2.10). Env
   * `PI_SESSION_LOCAL_DIR`. Default `./data/sessions` — deliberately NOT `/tmp`: the
   * JSONL is the conversation log the object-store sync + cold-wake restore depend on,
   * so it must survive a host reboot. Consumed by {@link DbSessionStore}.
   */
  sessionLocalDir: z.string().min(1).default("./data/sessions"),
  /** Whether the microsandbox runtime is wired (P0.1: always `disabled`). Env `SANDBOX_RUNTIME`. */
  sandboxRuntime: SandboxRuntime.default("disabled"),
  /**
   * Single-host vs multi-host sandboxing (R6.7, §7.2). Env `SANDBOX_MODE`, default
   * `single`. `multi` makes the composition root build a `MultiHostSandboxProvider`
   * (host registry + liveness monitor + one authenticated `HttpHostAgent` per host)
   * instead of the host-local `MicrosandboxProvider`. Only meaningful when
   * `sandboxRuntime === "enabled"`.
   */
  sandboxMode: SandboxMode.default("single"),
  /**
   * The KVM host pool (R6.7, §7.2). Env `SANDBOX_HOSTS` — a JSON array of
   * {@link SandboxHostConfigSchema} objects. Upserted into the `sandbox_hosts` registry on
   * boot; a pool may also be registered out of band (the registry, not config, is the
   * runtime source of truth). Ignored unless `sandboxMode === "multi"`.
   */
  sandboxHosts: z.array(SandboxHostConfigSchema).default([]),
  /**
   * Pool-wide host-agent shared secret (§6.1). Env `SANDBOX_HOST_AGENT_TOKEN`. Used for
   * any host without a {@link ConfigSchema.sandboxHostAgentTokens} override. There is no
   * default: a host with no secret **fails closed** (`HostAgentTokenMissingError`) rather
   * than talking to the privileged host-agent channel unauthenticated.
   */
  sandboxHostAgentToken: z.string().min(1).optional(),
  /**
   * Per-host host-agent secret overrides (§6.1), keyed by the host id's env suffix
   * (upper-cased, non-alphanumerics → `_`). Collected from every
   * `SANDBOX_HOST_AGENT_TOKEN_<SUFFIX>` env var. Consumed by
   * `sandbox-host-pool/auth.ts` via {@link hostAgentTokenEnv}.
   */
  sandboxHostAgentTokens: z.record(z.string(), z.string().min(1)).default({}),
  /**
   * Liveness probe interval in ms for the host pool (§7). Env `SANDBOX_LIVENESS_INTERVAL_MS`,
   * default 10s. Only used in `multi` mode.
   */
  sandboxLivenessIntervalMs: z.number().int().positive().default(10_000),
  /**
   * Dev/test escape hatch (SEC-4): permit `SANDBOX_MODE=multi` to talk to host agents over
   * plain `http://` and WITHOUT a mutual-TLS client agent. Env
   * `SANDBOX_ALLOW_INSECURE_HOST_AGENT`. Default `false` — the pool secret is a bearer
   * token, so in production the privileged host-agent channel MUST be https + mTLS or the
   * token travels in cleartext. The composition root fails the boot closed unless this is
   * set. NEVER set in production.
   */
  allowInsecureHostAgent: z.boolean().default(false),
  /** Path to a JSON config file (optional). Env `CONFIG_FILE`. */
  configFile: z.string().optional(),
  /**
   * Path to the per-tier config JSON file (WP-5.5). Env `TIER_CONFIG_FILE`.
   * Consumed by `domain/tier-config/loader.ts`; unset → seeded tier defaults.
   */
  tierConfigFile: z.string().optional(),
  /**
   * Whether the public self-service sign-up route (`POST /v1/onboarding/signup`,
   * §29.6) is enabled. Env `ONBOARDING_ENABLED`. Defaults to `false`
   * (secure-by-default: a self-hosted deployment must not expose open tenant creation
   * unless it opts in). The SaaS shape sets `ONBOARDING_ENABLED=true` explicitly.
   */
  onboardingEnabled: z.boolean().default(false),
  /**
   * Console presentation mode override (console spec §3.2), returned by the public
   * `GET /console/config`. Env `CONSOLE_MODE` (`solo` | `team` | `saas`). Unset ⇒
   * derived at the serve hook: `onboardingEnabled` → `saas`, else `solo`. A
   * presentation concern only — no `/v1` behavior differs by mode.
   */
  consoleMode: ConsoleMode.optional(),
  /**
   * Console-session sliding TTL override in **seconds** (console spec §4.6).
   * Env `CONSOLE_SESSION_TTL`. Unset ⇒ the per-mode default (solo 30 d, team
   * 7 d, saas 24 h) resolved by `api/console-session.ts`.
   */
  consoleSessionTtl: z.number().int().positive().optional(),

  /**
   * Vault secret-encryption key (hex 64-char or base64, 32 bytes once decoded).
   * Env `VAULT_KEY` (deprecated alias: `MSB_SECRET_ENCRYPTION_KEY`). Resolved by
   * {@link resolveVaultKeySource} and consumed by `domain/vault/crypto.ts`.
   */
  vaultKey: z.string().optional(),
  /**
   * Path to a file holding the 32-byte vault key. Env `VAULT_KEY_FILE`
   * (deprecated alias: `MSB_SECRET_ENCRYPTION_KEY_FILE`).
   */
  vaultKeyFile: z.string().optional(),
  /**
   * Dev-only escape hatch: boot with an EPHEMERAL vault key when none is set
   * (secrets become unreadable after a restart). Env `ALLOW_EPHEMERAL_VAULT_KEY`.
   * NEVER set in production — the boot otherwise REFUSES to start without a key.
   */
  allowEphemeralVaultKey: z.boolean().default(false),

  /**
   * Per-tenant rate-limit ceiling in requests/minute (§27.3). Env `RATE_LIMIT_RPM`.
   * Wired into {@link api/middleware/rate-limit.ts} by the composition root.
   */
  rateLimitRpm: z.number().int().positive().default(600),
  /**
   * Per-IP rate-limit ceiling in requests/minute for unauthenticated requests
   * (the auth allowlist — notably the public `POST /v1/onboarding/signup`).
   * Env `RATE_LIMIT_ANON_RPM`.
   */
  rateLimitAnonRpm: z.number().int().positive().default(30),
  /**
   * Peer IPs whose `X-Forwarded-For` header is trusted (e.g. a fronting load
   * balancer). Without this, all traffic behind an LB shares one IP bucket.
   * Env `TRUSTED_PROXIES` (comma-separated list). Default: none.
   */
  trustedProxies: z.array(z.string()).default([]),
  /**
   * Backing store for rate-limit buckets: `memory` (per-process — N replicas
   * allow N× the ceiling) or `postgres` (shared, so the ceiling is global).
   * Env `RATE_LIMIT_STORE`. Default `memory`.
   */
  rateLimitStore: RateLimitStore.default("memory"),

  /**
   * Stable identifier for THIS backend instance (ROB-13). Env `INSTANCE_ID`. Boot recovery
   * only resets `running`/`rescheduling` sessions this instance previously owned, sessions
   * with no owner, or sessions whose ownership lease has expired — so a second instance can
   * never flip a peer's live sessions to `idle`. Unset ⇒ a random per-boot id (correct for
   * multiple instances; a restarted instance reclaims its own abandoned rows via the
   * expired-lease path below, not by id). SINGLE-WRITER ASSUMPTION: two instances sharing
   * one `INSTANCE_ID` will reclaim each other's rows — give every instance a distinct id
   * (or leave it unset).
   */
  instanceId: z.string().min(1).optional(),
  /**
   * Ownership lease window (ms) for boot recovery (ROB-13). Env `INSTANCE_LEASE_MS`, default
   * 300_000 (5 min). A `running` row untouched (`updated_at`) for longer than this is treated
   * as abandoned by a dead instance and is eligible for reset even if a different instance id
   * owns it.
   */
  instanceLeaseMs: z.number().int().positive().default(300_000),

  /**
   * Where session harnesses run (R7.1 — harness blast radius). Env `SESSION_WORKER_MODE`.
   *
   * - `inproc` (default, unchanged behavior): every `ManagedSessionRuntime` lives in the
   *   control-plane process. One session's heap leak or event-loop block degrades every
   *   tenant, and a harness crash takes down all sessions.
   * - `pool`: the runtimes live in {@link ConfigSchema.sessionWorkerCount} bounded child
   *   processes, sharded deterministically by session id, so a harness crash has a bounded
   *   blast radius. See `docs/session-worker-pool.md`.
   */
  sessionWorkerMode: SessionWorkerMode.default("inproc"),
  /**
   * Requested number of session-worker child processes (R7.1). Env `SESSION_WORKER_COUNT`.
   * The effective width is `min(os.cpus().length, this)`. Ignored in `inproc` mode.
   */
  sessionWorkerCount: z.number().int().positive().optional(),
  /**
   * Hard cap on live sessions per worker child (R7.1). Env `SESSION_WORKER_MAX_SESSIONS`.
   * Past the cap the pool refuses the wake rather than over-subscribing one process.
   */
  sessionWorkerMaxSessions: z.number().int().positive().optional(),
  /**
   * Override the compiled worker entry the pool forks (R7.1). Env `SESSION_WORKER_ENTRY`.
   * Defaults to the `worker-entry.js` sibling of the pool module in `dist/`.
   */
  sessionWorkerEntry: z.string().optional(),
  /**
   * Module a session worker imports to override its sandbox provider / agent-session
   * factory (R7.1). Env `SESSION_WORKER_OVERRIDES_MODULE`. These are the two collaborators
   * the in-process composition root accepts as objects (`createManagedApp({ sandboxProvider,
   * factory })`) and which therefore cannot cross the process boundary; a worker resolves
   * them by module path instead. Unset ⇒ the real `MicrosandboxProvider` +
   * `PiAgentSessionFactory`.
   */
  sessionWorkerOverridesModule: z.string().optional(),

  /**
   * Billing metering sink (§29.6). Env `BILLING_SINK`, default `none` — the no-op
   * sink, so existing deployments are unchanged. `webhook` requires both
   * {@link ConfigSchema.billingWebhookUrl} and {@link ConfigSchema.billingWebhookSecret};
   * the composition root refuses to boot without them.
   */
  billingSink: BillingSinkKind.default("none"),
  /**
   * Billing webhook endpoint (`https:` only — the signing secret must not travel in
   * cleartext, §25.5). Env `BILLING_WEBHOOK_URL`. Egress goes through the shared
   * SSRF-pinned transport (`domain/net/ssrf-pin.ts`), so the host must resolve to a
   * public IP on port 80/443.
   */
  billingWebhookUrl: z.string().url().optional(),
  /**
   * HMAC signing secret for billing metering deliveries (shared with the recipient,
   * `X-Webhook-Signature`, §23.4). Env `BILLING_WEBHOOK_SECRET`.
   */
  billingWebhookSecret: z.string().min(1).optional(),
  /**
   * WP-C5.1 (console spec §11.1): enable prepaid ledger enforcement (fail-soft
   * suspension of new work for a saas tenant at balance ≤ 0) and the trial
   * email-verification grant. Env `BILLING_ENABLED`, default `false` — this is
   * the deliberate saas switch, distinct from the presentation `consoleMode`
   * (which by §3.3 may not change any `/v1` behavior). Solo/team leave it off and
   * are never suspended or balance-gated.
   */
  billingEnabled: z.boolean().default(false),
  /**
   * WP-C5.1 (console spec §11.7): shared secret for the machine credit-surface
   * (`POST /internal/billing/credit`) the billing adapter calls to credit the
   * ledger. Host-agent pattern (constant-time bearer). Env
   * `BILLING_PROVISION_TOKEN`. Unset ⇒ the surface is fail-closed (rejects every
   * request). NOT a tenant API key.
   */
  billingProvisionToken: z.string().min(1).optional(),
  /**
   * WP-C5.3 (console spec §11.7–11.8): base URL of the billing-adapter's internal
   * surface (a SEPARATE process). When set — together with `billingProvisionToken`,
   * the shared machine secret presented back over this channel — the tenant billing
   * proxy routes (`/v1/tenant/billing/{checkout,portal,auto-charge}`) forward to the
   * adapter (the SDK-free link-out seam). Env `BILLING_ADAPTER_URL`. **Unset ⇒ those
   * four routes 404 and the console renders the no-adapter state (§11.8).** The Stripe
   * SDK never enters the backend — this is an HTTP call to the adapter.
   */
  billingAdapterUrl: z.string().url().optional(),
  /**
   * WP-C5.2 (console spec §11.6): the low-balance threshold in µUSD. When a usage
   * debit crosses DOWN through this line the backend fires the `tenant.balance_low`
   * webhook event (once per crossing). Env `BILLING_LOW_BALANCE_THRESHOLD_MICROS`,
   * default $2 ({@link DEFAULT_LOW_BALANCE_THRESHOLD_MICROS}). Global (not per-tenant),
   * consistent with the other `BILLING_*` switches; 0 disables the low event
   * (exhaustion still fires).
   */
  billingLowBalanceThresholdMicros: z
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_LOW_BALANCE_THRESHOLD_MICROS),
  /**
   * WP-C5.2 (console spec §11.4): the metering aggregation bucket width in ms. Usage
   * is summed per tenant per wall-clock bucket into one export event + one ledger
   * debit (never per-turn). Env `BILLING_METERING_BUCKET_MS`, default 60 000 (1 min).
   * Shorter ⇒ tighter enforcement latency but more events; must be > 0.
   */
  billingMeteringBucketMs: z.number().int().positive().default(DEFAULT_METERING_BUCKET_MS),

  // OTEL passthrough (WP-5.4 finalizes span names / resource attrs).
  otelExporterOtlpEndpoint: z.string().optional(),
  otelServiceName: z.string().optional(),
  otelResourceAttributes: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Raw env-like map (string | undefined). Tests inject a fake env. */
export type EnvLike = Record<string, string | undefined>;

/** Parsed JSON config file shape (partial Config — all keys optional). */
type ConfigFile = Partial<{
  port: number;
  logLevel: LogLevel;
  dbUrl: string;
  dbPoolMax: number;
  dbConnectionTimeoutMs: number;
  dbStatementTimeoutMs: number;
  objectStoreRoot: string;
  sessionLocalDir: string;
  sandboxRuntime: SandboxRuntime;
  sandboxMode: SandboxMode;
  sandboxHosts: SandboxHostConfig[];
  sandboxHostAgentToken: string;
  sandboxHostAgentTokens: Record<string, string>;
  sandboxLivenessIntervalMs: number;
  allowInsecureHostAgent: boolean;
  onboardingEnabled: boolean;
  consoleMode: ConsoleMode;
  consoleSessionTtl: number;
  vaultKey: string;
  vaultKeyFile: string;
  allowEphemeralVaultKey: boolean;
  rateLimitRpm: number;
  rateLimitAnonRpm: number;
  trustedProxies: string[];
  rateLimitStore: RateLimitStore;
  instanceId: string;
  instanceLeaseMs: number;
  sessionWorkerMode: SessionWorkerMode;
  sessionWorkerCount: number;
  sessionWorkerMaxSessions: number;
  sessionWorkerEntry: string;
  sessionWorkerOverridesModule: string;
  billingSink: BillingSinkKind;
  billingWebhookUrl: string;
  billingWebhookSecret: string;
  billingEnabled: boolean;
  billingProvisionToken: string;
  billingAdapterUrl: string;
  billingLowBalanceThresholdMicros: number;
  billingMeteringBucketMs: number;
  otelExporterOtlpEndpoint: string;
  otelServiceName: string;
  otelResourceAttributes: string;
}>;

/**
 * Read the optional JSON config file. Returns `{}` if the path is unset, the file
 * does not exist, or it is empty. A malformed file is a fatal config error.
 */
function readConfigFile(env: EnvLike): ConfigFile {
  const path = env.CONFIG_FILE;
  if (!path) return {};
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    fatal(`config file "${path}" is not valid JSON: ${(err as Error).message}`);
  }
}

/** Env var holding the pool-wide host-agent secret (§6.1). */
export const HOST_AGENT_TOKEN_ENV = "SANDBOX_HOST_AGENT_TOKEN";
/** Per-host host-agent secret prefix: `SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>` (§6.1). */
export const HOST_AGENT_TOKEN_PREFIX = "SANDBOX_HOST_AGENT_TOKEN_";

/**
 * Parse `SANDBOX_HOSTS` (a JSON array of {@link SandboxHostConfigSchema} objects).
 * A malformed value is a fatal config error — booting `multi` mode with a half-parsed
 * pool would silently route every session to the wrong (or to no) host.
 */
function parseSandboxHosts(raw: string | undefined): unknown[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      fatal(`SANDBOX_HOSTS must be a JSON array of host objects`);
    }
    return parsed;
  } catch (err) {
    fatal(`SANDBOX_HOSTS is not valid JSON: ${(err as Error).message}`);
  }
}

/** Collect every `SANDBOX_HOST_AGENT_TOKEN_<SUFFIX>` env var, keyed by `<SUFFIX>`. */
function collectHostAgentTokens(env: EnvLike): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(HOST_AGENT_TOKEN_PREFIX) || !v) continue;
    out[k.slice(HOST_AGENT_TOKEN_PREFIX.length)] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Rebuild the env-shaped map `sandbox-host-pool/auth.ts` consumes
 * (`createHostAgentTokenSource`) from validated {@link Config}. Subsystems read config,
 * not `process.env` — this keeps that invariant while reusing the auth module's
 * fail-closed per-host → pool-wide resolution unchanged.
 */
export function hostAgentTokenEnv(config: Config): EnvLike {
  const env: EnvLike = {};
  if (config.sandboxHostAgentToken) {
    env[HOST_AGENT_TOKEN_ENV] = config.sandboxHostAgentToken;
  }
  for (const [suffix, token] of Object.entries(config.sandboxHostAgentTokens)) {
    env[`${HOST_AGENT_TOKEN_PREFIX}${suffix}`] = token;
  }
  return env;
}

/** Merge sources: later sources win, but `undefined` never overrides a real value. */
function merge(
  ...sources: Array<Record<string, unknown>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/** Print a fatal config message and exit(1). */
function fatal(message: string): never {
   
  console.error(`[config] fatal: ${message}`);
  process.exit(1);
}

export interface LoadConfigOptions {
  /** Env map (defaults to `process.env`). */
  env?: EnvLike;
  /**
   * Parsed config file object. If omitted, read from `env.CONFIG_FILE`.
   * Tests inject a literal object to avoid filesystem fixtures.
   */
  file?: ConfigFile;
}

/**
 * Load and validate config.
 *
 * Precedence: env > file > defaults. Env values are coerced (port → number);
 * everything else is a string the zod schema validates/coerces.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const file = opts.file ?? readConfigFile(env);

  const envLayer: Record<string, unknown> = {
    port: env.PORT !== undefined ? Number(env.PORT) : undefined,
    logLevel: env.LOG_LEVEL,
    dbUrl: env.DB_URL,
    dbPoolMax: env.DB_POOL_MAX !== undefined ? Number(env.DB_POOL_MAX) : undefined,
    dbConnectionTimeoutMs:
      env.DB_CONNECTION_TIMEOUT_MS !== undefined
        ? Number(env.DB_CONNECTION_TIMEOUT_MS)
        : undefined,
    dbStatementTimeoutMs:
      env.DB_STATEMENT_TIMEOUT_MS !== undefined
        ? Number(env.DB_STATEMENT_TIMEOUT_MS)
        : undefined,
    objectStoreRoot: env.OBJECT_STORE_ROOT,
    sessionLocalDir: env.PI_SESSION_LOCAL_DIR,
    sandboxRuntime: env.SANDBOX_RUNTIME,
    sandboxMode: env.SANDBOX_MODE,
    sandboxHosts: parseSandboxHosts(env.SANDBOX_HOSTS),
    sandboxHostAgentToken: env[HOST_AGENT_TOKEN_ENV],
    sandboxHostAgentTokens: collectHostAgentTokens(env),
    sandboxLivenessIntervalMs:
      env.SANDBOX_LIVENESS_INTERVAL_MS !== undefined
        ? Number(env.SANDBOX_LIVENESS_INTERVAL_MS)
        : undefined,
    allowInsecureHostAgent:
      env.SANDBOX_ALLOW_INSECURE_HOST_AGENT !== undefined
        ? env.SANDBOX_ALLOW_INSECURE_HOST_AGENT === "true"
        : undefined,
    onboardingEnabled:
      env.ONBOARDING_ENABLED !== undefined
        ? env.ONBOARDING_ENABLED === "true"
        : undefined,
    consoleMode: env.CONSOLE_MODE,
    consoleSessionTtl:
      env.CONSOLE_SESSION_TTL !== undefined
        ? Number(env.CONSOLE_SESSION_TTL)
        : undefined,
    vaultKey: env.VAULT_KEY ?? env.MSB_SECRET_ENCRYPTION_KEY,
    vaultKeyFile: env.VAULT_KEY_FILE ?? env.MSB_SECRET_ENCRYPTION_KEY_FILE,
    allowEphemeralVaultKey:
      env.ALLOW_EPHEMERAL_VAULT_KEY !== undefined
        ? env.ALLOW_EPHEMERAL_VAULT_KEY === "true"
        : undefined,
    rateLimitRpm:
      env.RATE_LIMIT_RPM !== undefined ? Number(env.RATE_LIMIT_RPM) : undefined,
    rateLimitAnonRpm:
      env.RATE_LIMIT_ANON_RPM !== undefined
        ? Number(env.RATE_LIMIT_ANON_RPM)
        : undefined,
    trustedProxies:
      env.TRUSTED_PROXIES !== undefined
        ? env.TRUSTED_PROXIES.split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
    rateLimitStore: env.RATE_LIMIT_STORE,
    instanceId: env.INSTANCE_ID,
    instanceLeaseMs:
      env.INSTANCE_LEASE_MS !== undefined ? Number(env.INSTANCE_LEASE_MS) : undefined,
    sessionWorkerMode: env.SESSION_WORKER_MODE,
    sessionWorkerCount:
      env.SESSION_WORKER_COUNT !== undefined
        ? Number(env.SESSION_WORKER_COUNT)
        : undefined,
    sessionWorkerMaxSessions:
      env.SESSION_WORKER_MAX_SESSIONS !== undefined
        ? Number(env.SESSION_WORKER_MAX_SESSIONS)
        : undefined,
    sessionWorkerEntry: env.SESSION_WORKER_ENTRY,
    sessionWorkerOverridesModule: env.SESSION_WORKER_OVERRIDES_MODULE,
    billingSink: env.BILLING_SINK,
    billingWebhookUrl: env.BILLING_WEBHOOK_URL,
    billingWebhookSecret: env.BILLING_WEBHOOK_SECRET,
    billingEnabled:
      env.BILLING_ENABLED !== undefined ? env.BILLING_ENABLED === "true" : undefined,
    billingProvisionToken: env.BILLING_PROVISION_TOKEN,
    billingAdapterUrl: env.BILLING_ADAPTER_URL,
    billingLowBalanceThresholdMicros:
      env.BILLING_LOW_BALANCE_THRESHOLD_MICROS !== undefined
        ? Number(env.BILLING_LOW_BALANCE_THRESHOLD_MICROS)
        : undefined,
    billingMeteringBucketMs:
      env.BILLING_METERING_BUCKET_MS !== undefined
        ? Number(env.BILLING_METERING_BUCKET_MS)
        : undefined,
    configFile: env.CONFIG_FILE,
  tierConfigFile: env.TIER_CONFIG_FILE,
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: env.OTEL_SERVICE_NAME,
    otelResourceAttributes: env.OTEL_RESOURCE_ATTRIBUTES,
  };

  // env > file (defaults applied by the schema for anything still undefined).
  const merged = merge(file as Record<string, unknown>, envLayer);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    fatal(`invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Vault encryption key resolution (§12.4, §25.1)
// ---------------------------------------------------------------------------

/** Canonical env var holding the raw vault key (hex or base64, 32 bytes). */
export const VAULT_KEY_ENV = "VAULT_KEY";
/** Canonical env var holding a path to a 32-byte vault key file. */
export const VAULT_KEY_FILE_ENV = "VAULT_KEY_FILE";
/** Deprecated alias for {@link VAULT_KEY_ENV}. */
export const DEPRECATED_VAULT_KEY_ENV = "MSB_SECRET_ENCRYPTION_KEY";
/** Deprecated alias for {@link VAULT_KEY_FILE_ENV}. */
export const DEPRECATED_VAULT_KEY_FILE_ENV = "MSB_SECRET_ENCRYPTION_KEY_FILE";
/** Dev-only escape hatch: opt into an ephemeral key when none is configured. */
export const ALLOW_EPHEMERAL_VAULT_KEY_ENV = "ALLOW_EPHEMERAL_VAULT_KEY";

/**
 * Where the vault encryption key comes from. `inline` carries the raw key
 * material, `file` a path to read it from, `ephemeral` a dev-only signal to
 * generate a throwaway key. The `keyId` is persisted in `vault_credentials.key_id`.
 */
export type VaultKeySource =
  | { kind: "inline"; value: string; keyId: string }
  | { kind: "file"; path: string; keyId: string }
  | { kind: "ephemeral"; keyId: "ephemeral" };

function warnDeprecatedVaultEnv(deprecated: string, canonical: string): void {

  console.warn(
    `[config] WARNING: ${deprecated} is deprecated — rename it to ${canonical}. ` +
      `The old name still works but will be removed in a future release.`,
  );
}

/**
 * Resolve where the vault encryption key comes from (§12.4, §25.1).
 *
 * Precedence: `VAULT_KEY` > `MSB_SECRET_ENCRYPTION_KEY` (deprecated) >
 * `VAULT_KEY_FILE` > `MSB_SECRET_ENCRYPTION_KEY_FILE` (deprecated) > ephemeral.
 *
 * When NO key is configured this **throws** rather than silently generating an
 * ephemeral key — an ephemeral key re-keys on every restart and makes every
 * stored secret permanently undecryptable. The dev-only escape hatch is
 * `ALLOW_EPHEMERAL_VAULT_KEY=true` — the ONLY signal that enables an ephemeral
 * key. `NODE_ENV=test` is deliberately NOT inferred (a prod process mis-set to
 * `test` must refuse to boot, not silently use a throwaway key); the test
 * bootstrap sets the flag explicitly. The thrown error propagates to the boot
 * entrypoint, which exits non-zero.
 */
export function resolveVaultKeySource(env: EnvLike = process.env): VaultKeySource {
  const inline = env[VAULT_KEY_ENV];
  if (inline) return { kind: "inline", value: inline, keyId: "env" };

  const inlineDeprecated = env[DEPRECATED_VAULT_KEY_ENV];
  if (inlineDeprecated) {
    warnDeprecatedVaultEnv(DEPRECATED_VAULT_KEY_ENV, VAULT_KEY_ENV);
    return { kind: "inline", value: inlineDeprecated, keyId: "env" };
  }

  const file = env[VAULT_KEY_FILE_ENV];
  if (file) return { kind: "file", path: file, keyId: `file:${file}` };

  const fileDeprecated = env[DEPRECATED_VAULT_KEY_FILE_ENV];
  if (fileDeprecated) {
    warnDeprecatedVaultEnv(DEPRECATED_VAULT_KEY_FILE_ENV, VAULT_KEY_FILE_ENV);
    return { kind: "file", path: fileDeprecated, keyId: `file:${fileDeprecated}` };
  }

  const allowEphemeral = env[ALLOW_EPHEMERAL_VAULT_KEY_ENV] === "true";
  if (allowEphemeral) return { kind: "ephemeral", keyId: "ephemeral" };

  throw new Error(
    `vault encryption key not configured: set ${VAULT_KEY_ENV} (32 bytes, hex or base64) ` +
      `or ${VAULT_KEY_FILE_ENV} (path to a 32-byte key file). Refusing to boot — an ephemeral ` +
      `key would make every stored secret permanently undecryptable after a restart. For local ` +
      `development only, set ${ALLOW_EPHEMERAL_VAULT_KEY_ENV}=true to opt into an ephemeral key.`,
  );
}
