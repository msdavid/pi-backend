/**
 * Test-only fake of the {@link ConsoleApi} client surface.
 *
 * seam-ok: this fake stands in for the API client as a COLLABORATOR of UI
 * components under test (injected via `<ApiClientProvider>`); the client
 * itself is the subject only in `src/api/__tests__/`, where it runs against
 * the real in-process backend (CONVENTIONS.md "Fakes at the seam").
 *
 * It models the console-support endpoints the auth flow touches — simulating
 * the server-held cookie: `POST /console/session` with a key from
 * {@link FakeConsoleApi.keys} "sets the cookie" (subsequent `GET
 * /console/session` succeeds); `DELETE` clears it — plus the `/v1` families
 * the feature suites drive. Responses still flow through the real contracts
 * schemas — the fake returns wire-shaped objects and lets `schema.parse`
 * validate them, like the real client does.
 *
 * Composition (WP-C3-prep): the console-session + stream logic lives here;
 * every `/v1` family's route handling lives in a module under `./fakes/`
 * operating on state fields of this class (the public seed surface is
 * unchanged for existing tests): sessions, jobs + memory stores (WP-C2.4),
 * and the phase-3 admin families — agents, environments (+ worker keys /
 * work-stats / work-stop), vaults & credentials (never a secret in a
 * response), api-keys + webhooks (show-once secrets, obviously fake
 * values), files + skills, tenant info/usage, and the public onboarding
 * signup (gated on {@link FakeConsoleApi.config}.onboardingEnabled).
 *
 * WP-C2.1: it also implements the optional {@link SessionStreamer} stream
 * capability that `useSessionStream` duck-types for. Tests script live
 * frames with {@link FakeConsoleApi.emitStream}, a clean server close with
 * {@link FakeConsoleApi.endStream}, and the phase a new connection reports
 * via {@link FakeConsoleApi.streamPhase}. The real SSE transport
 * (`src/api/stream.ts`) is the subject only in its own suites, where the
 * other side is a real server.
 */
import type {
  Agent,
  AgentVersion,
  ApiKey,
  AutoChargeConfig,
  ConsoleConfig,
  ConsoleSessionCreateResponse,
  Credential,
  Environment,
  File,
  Job,
  JobRun,
  LedgerEntry,
  Memory,
  MemoryStore,
  MemoryVersion,
  Session,
  SessionUsageResponse,
  Skill,
  TenantBillingState,
  TenantInfo,
  TenantUsageResponse,
  Vault,
  Webhook,
  WorkStats,
} from "@pi-managed/contracts";

import { type ConsoleApi } from "../api/client.js";
import type { ConsoleApiError, ResponseSchema } from "../api/client.js";
import type { SessionEntryWire } from "../api/sessions.js";
import type { SignupResponse } from "../api/onboarding.js";
import type {
  SessionStreamHandlers,
  SessionStreamOptions,
  SessionStreamPhase,
  SessionStreamer,
  SseFrame,
} from "../api/stream.js";
import { agentsGet, agentsPatch, agentsPost, makeAgent } from "./fakes/agents.js";
import {
  billingGet,
  billingPatch,
  billingPost,
  makeAutoCharge,
  makeBillingState,
  makeLedgerEntry,
} from "./fakes/billing.js";
import {
  environmentsDel,
  environmentsGet,
  environmentsPatch,
  environmentsPost,
  makeEnvironment,
} from "./fakes/environments.js";
import { filesSkillsDel, filesSkillsGet, makeFile, makeSkill } from "./fakes/files-skills.js";
import { jobsGet, jobsPost, makeJob, makeJobRun } from "./fakes/jobs.js";
import {
  makeMemoryStore,
  memoryStoresGet,
  memoryStoresPost,
} from "./fakes/memory-stores.js";
import {
  makeApiKey,
  makeWebhook,
  settingsDel,
  settingsGet,
  settingsPost,
} from "./fakes/settings.js";
import { makeSession, sessionsGet, sessionsPost } from "./fakes/sessions.js";
import { makeTenantInfo, makeTenantUsage, tenantGet } from "./fakes/tenant.js";
import { makeCredential, makeVault, vaultsDel, vaultsGet, vaultsPost } from "./fakes/vaults.js";
import { forbidden, unauthorized } from "./fakes/wire.js";

// Family makers re-exported so tests keep one import site.
export {
  makeSession,
  makeAgent,
  makeApiKey,
  makeAutoCharge,
  makeBillingState,
  makeCredential,
  makeEnvironment,
  makeFile,
  makeJob,
  makeJobRun,
  makeLedgerEntry,
  makeMemoryStore,
  makeSkill,
  makeTenantInfo,
  makeTenantUsage,
  makeVault,
  makeWebhook,
};

/** One open fake stream connection (see {@link FakeConsoleApi.streamSession}). */
interface OpenStream {
  handlers: SessionStreamHandlers;
  /** Simulates the server closing this connection cleanly. */
  end: () => void;
}

/** A tenant id that satisfies the contracts `tenantId` schema (`tnt_` prefix). */
export const FAKE_TENANT = { id: "tnt_01TEST", name: "Acme Corp" };

const FAKE_EXPIRES_AT = "2026-08-01T00:00:00.000Z";

export class FakeConsoleApi implements ConsoleApi, SessionStreamer {
  /** Every call the UI made, in order. */
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  config: ConsoleConfig = { mode: "solo", onboardingEnabled: false };
  /** apiKey → session granted by `POST /console/session`. */
  readonly keys = new Map<string, ConsoleSessionCreateResponse>();
  /** The "cookie": non-null once signed in. */
  signedIn: ConsoleSessionCreateResponse | null = null;

  /** The tenant's sessions, in insertion order (list sorts createdAt desc). */
  sessions: Session[] = [];
  /** session id → its log entries (`GET …/entries`), ascending seq. */
  readonly entries = new Map<string, SessionEntryWire[]>();
  /** session id → cumulative usage; missing ids answer all-zeros. */
  readonly usage = new Map<string, SessionUsageResponse>();
  /** session id → JSONL tree (`GET …/tree`); missing ids answer the empty tree. */
  readonly trees = new Map<string, unknown>();
  /** session id → output filenames (`GET …/outputs`; idle-only, like the API). */
  readonly outputs = new Map<string, string[]>();
  /** session id → post-compaction messages (`GET …/messages`, WP-C4.1). */
  readonly messages = new Map<string, unknown[]>();
  /** The id the next fork creates (`POST …/fork`). */
  nextForkId = "sess_01FORKED";
  /**
   * When set, an ACCEPTED `user.message` (idle) flips its session to
   * `running` (modelling the backend wake), so a second queued message can
   * only be accepted after the test returns the session to idle — the way the
   * ROB-5 one-message-per-turn guard behaves for real. Off by default so
   * existing tests script status transitions themselves.
   */
  wakeOnMessage = false;
  /** Contents of every ACCEPTED `user.message`, in order (queue-flush tests). */
  readonly acceptedUserMessages: string[] = [];
  /** pathname → error the next GETs of it throw (simulates partial failures). */
  readonly failGets = new Map<string, ConsoleApiError>();

  /** The tenant's jobs, in insertion order. */
  jobs: Job[] = [];
  /** job id → runs, newest first (the order the API returns). */
  readonly jobRuns = new Map<string, JobRun[]>();
  /** The session the next manual trigger reports (`POST …/run`). */
  triggerSessionId = "sess_01TRIGGERED";

  /** The tenant's memory stores, in insertion order. */
  memoryStores: MemoryStore[] = [];
  /** store id → memories WITH content (list strips it to the summary). */
  readonly memories = new Map<string, Memory[]>();
  /** store id → versions, newest first. */
  readonly memoryVersions = new Map<string, MemoryVersion[]>();
  /** The id the next version restore creates (`POST …/restore`, WP-C4.0b). */
  nextRestoredVersionId = "memver_01RESTORED";
  /**
   * When set, restoring THIS version id answers `409 conflict` even though it
   * is intact — the reachable tombstone-conflict path the restore ErrorAlert
   * handles (redacted versions have their button disabled, so they can never
   * exercise it). Off by default.
   */
  restoreConflictVersionId: string | null = null;

  // --- Phase-3 admin families (WP-C3-prep) ----------------------------------
  /** The tenant's agents, in insertion order. */
  agents: Agent[] = [];
  /** agent id → versions, newest first. */
  readonly agentVersions = new Map<string, AgentVersion[]>();
  /** The tenant's environments, in insertion order. */
  environments: Environment[] = [];
  /** environment id → work-stats; missing ids answer all-zeros. */
  readonly workStats = new Map<string, WorkStats>();
  /** The tenant's vaults, in insertion order. */
  vaults: Vault[] = [];
  /** vault id → credential RECORDS (never a secret field). */
  readonly credentials = new Map<string, Credential[]>();
  /** What `POST …/credentials/:key/validate` reports. */
  credentialValidation: "valid" | "invalid" | "unknown" = "valid";
  /** The tenant's API-key records (no raw key). */
  apiKeys: ApiKey[] = [];
  /** The tenant's webhook records (no signing secret). */
  webhooks: Webhook[] = [];
  /** What `POST /v1/webhooks/:id/test` reports. */
  webhookTestResult: { delivered: boolean; responseCode?: number } = {
    delivered: true,
    responseCode: 200,
  };
  /** The tenant's files, in insertion order. */
  files: File[] = [];
  /** The tenant's skills, in insertion order. */
  skills: Skill[] = [];
  /** `GET /v1/tenant` body. */
  tenantInfo: TenantInfo = makeTenantInfo();
  /** `GET /v1/tenant/usage` body. */
  tenantUsage: TenantUsageResponse = makeTenantUsage();

  // --- Billing (WP-C5.4; saas) ----------------------------------------------
  /** `GET /v1/tenant/billing` body; `null` ⇒ 404 (tenant not enrolled). */
  billingState: TenantBillingState | null = null;
  /** `GET /v1/tenant/billing/ledger` entries, newest first. */
  ledgerEntries: LedgerEntry[] = [];
  /** `GET/PATCH …/auto-charge`; `null` ⇒ 404 (no adapter — money controls
   * absent, §11.8). Set a config to model an adapter being present. */
  autoChargeConfig: AutoChargeConfig | null = null;
  /** What `POST …/verification/resend` reports. */
  resendSent = true;
  /** Hosted URL the checkout/portal link-outs return. */
  hostedUrl = "https://pay.example.test/session/cs_test_123";
  /** `POST /v1/onboarding/signup` body (when onboarding is enabled). */
  signupResult: SignupResponse = {
    tenantId: FAKE_TENANT.id,
    backendUrl: "http://console.test",
    installCommand: "pi install npm:@pi-managed/client",
    extensionConfig: {
      backendUrl: "http://console.test",
      apiKeyRef: "pi-managed-backend",
    },
  };

  /** A fake that already holds a session (skips the sign-in screen). */
  static signedIn(scopes: string[]): FakeConsoleApi {
    const api = new FakeConsoleApi();
    api.signedIn = { scopes, tenant: FAKE_TENANT };
    return api;
  }

  /** Register `apiKey` as valid, granting `scopes` on sign-in. */
  acceptKey(apiKey: string, scopes: string[]): this {
    this.keys.set(apiKey, { scopes, tenant: FAKE_TENANT });
    return this;
  }

  /** Seed a session (see {@link makeSession} for the defaults). */
  addSession(overrides: Partial<Session> & { id: string }): Session {
    const session = makeSession(overrides);
    this.sessions.push(session);
    return session;
  }

  /** Seed a job (see {@link makeJob} for the defaults). */
  addJob(overrides: Partial<Job> & { id: string }): Job {
    const job = makeJob(overrides);
    this.jobs.push(job);
    return job;
  }

  /** Seed a run for `jobId`, appended at the newest-first head. */
  addJobRun(jobId: string, overrides: Partial<JobRun> & { id: string }): JobRun {
    const run = makeJobRun(overrides);
    const runs = this.jobRuns.get(jobId) ?? [];
    runs.unshift(run);
    this.jobRuns.set(jobId, runs);
    return run;
  }

  /** Seed a memory store (see {@link makeMemoryStore} for the defaults). */
  addMemoryStore(overrides: Partial<MemoryStore> & { id: string }): MemoryStore {
    const store = makeMemoryStore(overrides);
    this.memoryStores.push(store);
    return store;
  }

  /** Seed a memory (with content) into `storeId`. */
  addMemory(
    storeId: string,
    memory: { path: string; content: string; contentSha256?: string },
  ): Memory {
    const full: Memory = {
      contentSha256: "a".repeat(64),
      updatedAt: "2026-07-01T00:00:00.000Z",
      ...memory,
    };
    const all = this.memories.get(storeId) ?? [];
    all.push(full);
    this.memories.set(storeId, all);
    return full;
  }

  /** Seed a version into `storeId`, appended at the newest-first head. */
  addMemoryVersion(
    storeId: string,
    overrides: Partial<MemoryVersion> & { id: string },
  ): MemoryVersion {
    const version: MemoryVersion = {
      memoryPath: "conventions.md",
      contentSha256: "b".repeat(64),
      redacted: false,
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: null,
      ...overrides,
    };
    const all = this.memoryVersions.get(storeId) ?? [];
    all.unshift(version);
    this.memoryVersions.set(storeId, all);
    return version;
  }

  /** Seed an agent (see {@link makeAgent} for the defaults). */
  addAgent(overrides: Partial<Agent> & { id: string }): Agent {
    const agent = makeAgent(overrides);
    this.agents.push(agent);
    return agent;
  }

  /** Seed a version for `agentId`, appended at the newest-first head. */
  addAgentVersion(agentId: string, version: AgentVersion): AgentVersion {
    const all = this.agentVersions.get(agentId) ?? [];
    all.unshift(version);
    this.agentVersions.set(agentId, all);
    return version;
  }

  /** Seed an environment (see {@link makeEnvironment} for the defaults). */
  addEnvironment(overrides: Partial<Environment> & { id: string }): Environment {
    const env = makeEnvironment(overrides);
    this.environments.push(env);
    return env;
  }

  /** Seed a vault (see {@link makeVault} for the defaults). */
  addVault(overrides: Partial<Vault> & { id: string }): Vault {
    const vault = makeVault(overrides);
    this.vaults.push(vault);
    return vault;
  }

  /** Seed a credential RECORD into `vaultId` (no secret field exists). */
  addCredential(
    vaultId: string,
    overrides: Partial<Credential> & { key: string },
  ): Credential {
    const record = makeCredential({ vaultId, ...overrides });
    const all = this.credentials.get(vaultId) ?? [];
    all.push(record);
    this.credentials.set(vaultId, all);
    return record;
  }

  /** Seed an API-key record (see {@link makeApiKey} for the defaults). */
  addApiKey(overrides: Partial<ApiKey> & { id: string }): ApiKey {
    const record = makeApiKey(overrides);
    this.apiKeys.push(record);
    return record;
  }

  /** Seed a webhook record (see {@link makeWebhook} for the defaults). */
  addWebhook(overrides: Partial<Webhook> & { id: string }): Webhook {
    const record = makeWebhook(overrides);
    this.webhooks.push(record);
    return record;
  }

  /** Seed a file (see {@link makeFile} for the defaults). */
  addFile(overrides: Partial<File> & { id: string }): File {
    const file = makeFile(overrides);
    this.files.push(file);
    return file;
  }

  /** Seed a skill (see {@link makeSkill} for the defaults). */
  addSkill(overrides: Partial<Skill> & { id: string }): Skill {
    const skill = makeSkill(overrides);
    this.skills.push(skill);
    return skill;
  }

  /** Seed a ledger entry, appended at the newest-first head (§11.3). */
  addLedgerEntry(overrides: Partial<LedgerEntry> & { id: string }): LedgerEntry {
    const entry = makeLedgerEntry(overrides);
    this.ledgerEntries.unshift(entry);
    return entry;
  }

  async get<T>(path: string, schema: ResponseSchema<T>): Promise<T> {
    this.calls.push({ method: "GET", path });
    const url = new URL(path, "http://console.test");
    const pathname = url.pathname;
    const params = url.searchParams;

    const forced = this.failGets.get(pathname);
    if (forced) throw forced;

    if (pathname === "/console/config") return schema.parse(this.config);
    if (pathname === "/console/session") {
      if (!this.signedIn) throw unauthorized();
      return schema.parse({ ...this.signedIn, expiresAt: FAKE_EXPIRES_AT });
    }
    const handled =
      sessionsGet(this, pathname, params) ??
      jobsGet(this, pathname, params) ??
      memoryStoresGet(this, pathname, params) ??
      agentsGet(this, pathname, params) ??
      environmentsGet(this, pathname, params) ??
      vaultsGet(this, pathname) ??
      settingsGet(this, pathname) ??
      filesSkillsGet(this, pathname, params) ??
      billingGet(this, pathname, params) ??
      tenantGet(this, pathname);
    if (handled !== undefined) return schema.parse(handled);
    throw new Error(`FakeConsoleApi: unexpected GET ${path}`);
  }

  async post<T>(
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
  ): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    if (path === "/console/session") {
      const granted = this.keys.get((body as { apiKey: string }).apiKey);
      if (!granted) throw unauthorized();
      this.signedIn = granted;
      return schema.parse(granted);
    }
    if (path === "/v1/onboarding/signup") {
      // Gated like the real route (`403` when onboarding is disabled).
      if (!this.config.onboardingEnabled) {
        throw forbidden("onboarding is disabled");
      }
      return schema.parse(this.signupResult);
    }
    const handled =
      sessionsPost(this, path, body) ??
      jobsPost(this, path, body) ??
      memoryStoresPost(this, path) ??
      agentsPost(this, path, body) ??
      environmentsPost(this, path, body) ??
      vaultsPost(this, path, body) ??
      settingsPost(this, path, body) ??
      billingPost(this, path, body);
    if (handled !== undefined) return schema.parse(handled);
    throw new Error(`FakeConsoleApi: unexpected POST ${path}`);
  }

  async patch<T>(
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
  ): Promise<T> {
    this.calls.push({ method: "PATCH", path, body });
    const handled =
      agentsPatch(this, path, body) ??
      environmentsPatch(this, path, body) ??
      billingPatch(this, path, body);
    if (handled !== undefined) return schema.parse(handled);
    throw new Error(`FakeConsoleApi: unexpected PATCH ${path}`);
  }

  async del(path: string): Promise<void> {
    this.calls.push({ method: "DELETE", path });
    if (path === "/console/session") {
      this.signedIn = null;
      return;
    }
    if (
      environmentsDel(this, path) ||
      vaultsDel(this, path) ||
      settingsDel(this, path) ||
      filesSkillsDel(this, path)
    ) {
      return;
    }
    throw new Error(`FakeConsoleApi: unexpected DELETE ${path}`);
  }

  // --- Session stream (WP-C2.1) --------------------------------------------

  /** Open stream connections per session id. */
  private readonly openStreams = new Map<string, Set<OpenStream>>();
  /** The phase every new stream connection reports on connect. */
  streamPhase: SessionStreamPhase = "live";

  /**
   * The {@link SessionStreamer} capability `useSessionStream` duck-types for:
   * registers the connection, reports {@link streamPhase}, then stays open
   * until the hook aborts (unmount / terminal status) or the test calls
   * {@link endStream} (a clean server close).
   */
  streamSession(
    sessionId: string,
    handlers: SessionStreamHandlers,
    opts: SessionStreamOptions,
  ): Promise<void> {
    this.calls.push({
      method: "STREAM",
      path: `/v1/sessions/${sessionId}/stream`,
    });
    return new Promise((resolve) => {
      const set = this.openStreams.get(sessionId) ?? new Set();
      this.openStreams.set(sessionId, set);
      const open: OpenStream = {
        handlers,
        end: () => {
          set.delete(open);
          handlers.onPhase?.("ended");
          resolve();
        },
      };
      set.add(open);
      opts.signal.addEventListener(
        "abort",
        () => {
          set.delete(open);
          resolve();
        },
        { once: true },
      );
      handlers.onPhase?.(this.streamPhase);
    });
  }

  /** Emit a live frame to every open stream of `sessionId`. */
  emitStream(sessionId: string, frame: SseFrame): void {
    for (const open of this.openStreams.get(sessionId) ?? []) {
      open.handlers.onFrame(frame);
    }
  }

  /** Close every open stream of `sessionId` cleanly (server-side end). */
  endStream(sessionId: string): void {
    for (const open of [...(this.openStreams.get(sessionId) ?? [])]) {
      open.end();
    }
  }
}
