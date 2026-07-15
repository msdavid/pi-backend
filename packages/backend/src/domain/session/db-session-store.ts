/**
 * DB-backed `SessionStore` (WP-1.6) — the bridge between the Sessions API (DB
 * rows) and the `ManagedSessionRuntime` (which needs the JSONL path + resolved
 * config). Implements the {@link SessionStore} seam from
 * `session-manager/types.ts` (`get` + `saveSyncedEtag`).
 *
 * `get(sessionId)` reconstructs a {@link SessionRecord} from the `sessions` row:
 *  - `objectStoreKey` ← `jsonl_object_key` (§28 layout: `tenants/<t>/sessions/<s>/log.jsonl`);
 *  - `localJsonlPath` ← a host-side temp path the runtime's `SessionManager` writes to;
 *  - `material.agentConfig` ← the pinned agent-version config with per-session
 *    overrides applied (omit→inherit, null→clear, value→full replace, §6.3);
 *  - `environment` ← the `environments` row;
 *  - `budget`/`vaultIds` ← the row;
 *  - `sandboxHandle` ← the row's `sandbox_handle` (null until first provision).
 *
 * This store provides only the DB-derived material — `agentConfig`, `environment`,
 * `budget`, and `vaultIds`. The live-bound fields (`cwd`, `customTools`,
 * `providerKeys`, `extensionFactories`) are augmented later by
 * `ManagedSessionRuntime.wake()` (R2.1), which alone has the provisioned sandbox
 * handle the sandbox tools bind to. The placeholder `providerKeys: {}` / `cwd` set
 * here are overwritten at wake — provider keys are decrypted host-side from the tenant
 * vault (§4.2) and `cwd` becomes the guest workdir.
 *
 * `saveSyncedEtag` / `saveSandboxHandle` / `saveStatus` persist the durable runtime
 * state (R2.8 / R2.10): the last object-store etag, the provisioned sandbox handle, and
 * the wire status/stop reason. All three are tenant-scoped writes; the tenant is resolved
 * from the row (cached on `get`, looked up on demand otherwise). Best-effort at the call
 * site — the runtime wraps these so a DB blip never crashes a turn.
 */

import { type Pool, type TenantCtx } from "../../infra/db/index.js";
import { getEnvironment } from "../environment/environment.js";
import type {
  Environment,
  Budget,
  StopReason,
} from "@pi-managed/contracts";
import type {
  SessionRecord,
  SessionStore,
} from "../session-manager/types.js";
import type {
  SessionId,
  TenantId,
  SessionStatus,
  SandboxHandle,
} from "../ports.js";
import {
  resolveEffectiveConfig,
  updateSessionSandboxHandle,
  updateSessionStatus,
  updateSessionSyncedEtag,
} from "./session-repo.js";

/**
 * Default host-side root for local JSONL files. Durable by design (NOT `/tmp`, R2.10b):
 * the JSONL is the conversation log the object-store sync + cold-wake restore depend on,
 * so it must survive a host reboot. Overridden by `config.sessionLocalDir`
 * (`PI_SESSION_LOCAL_DIR`) via the {@link DbSessionStore} constructor.
 */
export const DEFAULT_LOCAL_DIR = "./data/sessions";

/** Read the local JSONL root from env, falling back to the durable default. */
function localJsonlDir(): string {
  return process.env.PI_SESSION_LOCAL_DIR ?? DEFAULT_LOCAL_DIR;
}

/** Build the host-side local JSONL path for a session under `dir`. */
export function sessionLocalJsonlPathIn(dir: string, sessionId: SessionId): string {
  return `${dir}/${sessionId}/log.jsonl`;
}

/** Build the host-side local JSONL path for a session (env/default root). */
export function sessionLocalJsonlPath(sessionId: SessionId): string {
  return sessionLocalJsonlPathIn(localJsonlDir(), sessionId);
}

/** Options for {@link DbSessionStore}. */
export interface DbSessionStoreOptions {
  /** Durable local JSONL root (`config.sessionLocalDir`). Defaults to env/{@link DEFAULT_LOCAL_DIR}. */
  localDir?: string;
}

/**
 * Postgres-backed `SessionStore`. Constructed with a pool; the runtime reads a
 * record by session id and persists the durable runtime state (etag/handle/status).
 */
export class DbSessionStore implements SessionStore {
  private readonly pool: Pool;
  private readonly localDir: string;
  /** Tenant cache keyed by session id — populated on `get`, else looked up on demand. */
  private readonly tenants = new Map<SessionId, TenantId>();

  constructor(pool: Pool, opts: DbSessionStoreOptions = {}) {
    this.pool = pool;
    this.localDir = opts.localDir ?? localJsonlDir();
  }

  async get(sessionId: SessionId): Promise<SessionRecord | undefined> {
    // The session is tenant-scoped; the runtime already knows the tenant from the
    // record it was constructed with. We locate the row by id (PK) then resolve its
    // tenant context for the tenant-scoped environment + agent-version reads.
    const row = await fetchSessionRowById(this.pool, sessionId);
    if (!row || row.status === "archived") return undefined;
    this.tenants.set(sessionId, row.tenant_id);
    const tenantCtx = { tenantId: row.tenant_id };

    const agentConfig = await resolveEffectiveConfig(
      this.pool,
      tenantCtx,
      sessionId,
    );
    if (!agentConfig) return undefined;

    const environment: Environment | null = await getEnvironment(
      this.pool,
      tenantCtx,
      row.environment_id,
    );
    if (!environment) return undefined;

    const vaultIds = row.vault_ids ?? [];
    const record: SessionRecord = {
      sessionId,
      tenantId: row.tenant_id,
      localJsonlPath: sessionLocalJsonlPathIn(this.localDir, sessionId),
      objectStoreKey: row.jsonl_object_key,
      sandboxHandle: row.sandbox_handle
        ? ({ id: row.sandbox_handle, name: row.sandbox_handle, labels: { tenant: row.tenant_id, session: sessionId } } as SandboxHandle)
        : undefined,
      // Vault secret bindings are resolved host-side at wake by the SecretStore
      // (`resolveBindingsForSession`), NOT here — the runtime reads live vault rows so
      // rotation/archival propagate without a restart (§25.5 / §12.5). The record
      // carries no `secretBindings`.
      material: {
        agentConfig,
        // Placeholders — overwritten by ManagedSessionRuntime.wake() (R2.1). Provider
        // keys are decrypted host-side from the vault (§4.2); cwd becomes the guest workdir.
        providerKeys: {},
        cwd: "/workspace",
      },
      environment,
      budget: (row.budget ?? undefined) as Budget | undefined,
      vaultIds,
      // Durable optimistic-concurrency basis (R2.10d) — survives a restart so the sync
      // resumes conditional puts instead of a redundant full re-sync.
      ...(row.synced_etag ? { lastSyncedEtag: row.synced_etag } : {}),
    };
    return record;
  }

  async saveSyncedEtag(sessionId: SessionId, etag: string): Promise<void> {
    const ctx = await this.tenantCtxFor(sessionId);
    if (!ctx) return;
    await updateSessionSyncedEtag(this.pool, ctx, sessionId, etag);
  }

  async saveSandboxHandle(
    sessionId: SessionId,
    handle: SandboxHandle | null,
  ): Promise<void> {
    const ctx = await this.tenantCtxFor(sessionId);
    if (!ctx) return;
    // The `sandbox_handle` column stores the provider handle NAME (the tenant-namespaced
    // VM name, stable across stop/start; id === name for the real provider). get()
    // reconstructs the full handle from it.
    await updateSessionSandboxHandle(this.pool, ctx, sessionId, handle?.name ?? null);
  }

  async saveStatus(
    sessionId: SessionId,
    status: SessionStatus,
    stopReason: StopReason | null,
  ): Promise<void> {
    const ctx = await this.tenantCtxFor(sessionId);
    if (!ctx) return;
    await updateSessionStatus(this.pool, ctx, sessionId, status, stopReason);
  }

  /** Resolve the tenant ctx for a session (cache, else a by-id lookup). */
  private async tenantCtxFor(sessionId: SessionId): Promise<TenantCtx | undefined> {
    let tenantId = this.tenants.get(sessionId);
    if (!tenantId) {
      const { rows } = await this.pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM sessions WHERE id = $1 LIMIT 1`,
        [sessionId],
      );
      tenantId = rows[0]?.tenant_id;
      if (tenantId) this.tenants.set(sessionId, tenantId);
    }
    return tenantId ? { tenantId } : undefined;
  }
}

/** Fetch a session row by id (PK) without a tenant context (for the store seam). */
interface RawSessionRow {
  tenant_id: string;
  id: string;
  environment_id: string;
  status: string;
  budget: Record<string, number> | null;
  vault_ids: string[];
  sandbox_handle: string | null;
  jsonl_object_key: string;
  synced_etag: string | null;
}

async function fetchSessionRowById(
  pool: Pool,
  sessionId: string,
): Promise<RawSessionRow | null> {
  const { rows } = await pool.query<RawSessionRow>(
    `SELECT tenant_id, id, environment_id, status, budget, vault_ids,
            sandbox_handle, jsonl_object_key, synced_etag
       FROM sessions WHERE id = $1 LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}
