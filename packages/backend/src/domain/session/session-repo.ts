/**
 * Sessions repository (WP-1.6, §6.3, §30 item 8).
 *
 * The persistence layer for the `sessions` table (docs/db-schema.md §3.4). Holds
 * metadata only — the conversation lives in the object store at
 * `jsonl_object_key`, NEVER in Postgres (§28). All queries route through
 * {@link tenantScopedQuery} so cross-tenant access is impossible by construction
 * (§27.1).
 *
 * The wire `Session` resource (contracts/session.ts) omits internal columns
 * (`jsonl_object_key`, `sandbox_handle`, `agent_overrides`); those stay here as
 * repository-internal state. {@link toSession} maps a row → the wire shape.
 *
 * Per-session override resolution (omit→inherit, null→clear, value→full replace,
 * §6.3) lives in {@link applyOverrides}; {@link resolveEffectiveConfig} is the
 * authoritative read used both by the DB-backed `SessionStore` (materialization)
 * and by tests asserting the override matrix.
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { ApiError } from "../errors.js";
import { releaseQuota } from "../quota/index.js";
import {
  AgentConfig,
  type AgentConfig as AgentConfigType,
  type Budget,
  type Metadata,
  type Session,
  type SessionStatus,
  type StopReason,
  type Usage,
} from "@pi-managed/contracts";
import type { ObjectStore } from "../ports.js";

// ---------------------------------------------------------------------------
// Row shape & mapping
// ---------------------------------------------------------------------------

/** `sessions` row (snake_case; jsonb columns arrive as parsed objects). */
export interface SessionRow {
  id: string;
  agent_id: string;
  agent_version: number;
  environment_id: string;
  title: string | null;
  status: string;
  stop_reason: string | null;
  budget: Record<string, number> | null;
  usage: Record<string, number> | null;
  vault_ids: string[];
  resources: string[];
  agent_overrides: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  jsonl_object_key: string;
  forked_from_session_id: string | null;
  sandbox_handle: string | null;
}

/** ISO-string helper — contracts `Timestamp` is an RFC 3339 string. */
const iso = (d: Date): string => d.toISOString();

/** Empty cumulative usage (a fresh session has not consumed anything yet). */
export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Coerce a (possibly partial/empty) jsonb `usage` blob into the full `Usage`. */
function normalizeUsage(raw: Record<string, number> | null | undefined): Usage {
  return {
    inputTokens: raw?.inputTokens ?? 0,
    outputTokens: raw?.outputTokens ?? 0,
    cacheCreationInputTokens: raw?.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: raw?.cacheReadInputTokens ?? 0,
  };
}

/** Build the wire `Session` resource from a db row. Internal columns dropped. */
export function toSession(row: SessionRow): Session {
  const metadata =
    row.metadata && Object.keys(row.metadata).length
      ? (row.metadata as Metadata)
      : undefined;
  const session: Session = {
    id: row.id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    environmentId: row.environment_id,
    status: row.status as SessionStatus,
    stopReason: row.stop_reason as StopReason | null,
    usage: normalizeUsage(row.usage),
    vaultIds: row.vault_ids ?? [],
    resources: row.resources ?? [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastActivityAt: iso(row.last_activity_at),
    forkedFromSessionId: row.forked_from_session_id,
  };
  if (row.title) session.title = row.title;
  if (row.budget) session.budget = row.budget as Budget;
  if (metadata) session.metadata = metadata;
  return session;
}

// ---------------------------------------------------------------------------
// Overrides (§6.3: omit→inherit, null→clear, value→full replace)
// ---------------------------------------------------------------------------

/**
 * Apply per-session overrides onto a base `AgentConfig`. Semantics (§6.3):
 *  - field omitted from `overrides` → inherited (left as-is in `base`);
 *  - field set to `null`            → cleared (removed from the result);
 *  - field set to a value           → full replacement (NO merge).
 *
 * Returns a new object; `base` is not mutated. The result is re-validated
 * against {@link AgentConfig} — a cleared `model` (which `AgentConfig` requires)
 * yields a `422 invalid_request`, matching the spec's intent that `model` cannot
 * be null-cleared.
 */
export function applyOverrides(
  base: AgentConfigType,
  overrides: Record<string, unknown> | null | undefined,
): AgentConfigType {
  if (!overrides) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue; // omit → inherit
    if (v === null) {
      delete out[k]; // null → clear
      continue;
    }
    out[k] = v; // value → full replace
  }
  const parsed = AgentConfig.safeParse(out);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid effective agent config: ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Object-store key layout (§28)
// ---------------------------------------------------------------------------

/**
 * The object-store key for a session's durable JSONL log (§28). The conversation
 * lives here, NOT in Postgres. Layout per docs/db-schema.md §3.4:
 * `tenants/<tenant_id>/sessions/<session_id>/log.jsonl`.
 */
export function sessionJsonlObjectKey(
  tenantId: string,
  sessionId: string,
): string {
  return `tenants/${tenantId}/sessions/${sessionId}/log.jsonl`;
}

// ---------------------------------------------------------------------------
// Fetch / list
// ---------------------------------------------------------------------------

/** Fetch a single session row, or `null` if absent / cross-tenant / archived. */
export async function fetchSessionRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<SessionRow | null> {
  const { rows } = await tenantScopedQuery<SessionRow>(
    pool,
    tenantCtx,
    `SELECT * FROM sessions WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

/** Fetch a non-archived session row, or `null` (archived = soft-deleted). */
async function fetchLiveSessionRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<SessionRow | null> {
  const row = await fetchSessionRow(pool, tenantCtx, id);
  if (!row || row.status === "archived") return null;
  return row;
}

/** Get a session as the wire resource; `null` if absent / cross-tenant / archived. */
export async function getSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Session | null> {
  const row = await fetchLiveSessionRow(pool, tenantCtx, id);
  return row ? toSession(row) : null;
}

/** Read the stored per-session `agent_overrides` blob (test seam + materializer). */
export async function readSessionOverrides(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Record<string, unknown> | null> {
  const row = await fetchSessionRow(pool, tenantCtx, id);
  if (!row || row.status === "archived") return null;
  return row.agent_overrides;
}

export interface ListSessionsOptions {
  limit: number;
  cursor?: string;
  status?: SessionStatus;
  agentId?: string;
  environmentId?: string;
}

/** Decode a list cursor into its `{createdAt, id}` position marker. */
function decodeListCursor(cursor: string): { createdAt: string; id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
  if (!parsed.createdAt || !parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid session list cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

/**
 * List sessions for `tenantCtx`, newest first, cursor-paginated. Archived
 * (soft-deleted) sessions are always excluded. Optional `status` / `agentId` /
 * `environmentId` filters narrow the set (§"GET /v1/sessions").
 */
export async function listSessions(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListSessionsOptions,
): Promise<{ data: Session[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantCtx.tenantId];
  const where: string[] = ["status <> 'archived'"];
  let n = 1;
  if (opts.status) {
    where.push(`status = $${++n}`);
    params.push(opts.status);
  }
  if (opts.agentId) {
    where.push(`agent_id = $${++n}`);
    params.push(opts.agentId);
  }
  if (opts.environmentId) {
    where.push(`environment_id = $${++n}`);
    params.push(opts.environmentId);
  }
  if (opts.cursor) {
    const { createdAt, id } = decodeListCursor(opts.cursor);
    where.push(`(created_at, id) < ($${++n}, $${++n})`);
    params.push(createdAt, id);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<SessionRow>(
    pool,
    tenantCtx,
    `SELECT * FROM sessions
      WHERE tenant_id = $1 AND ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${++n}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(
          JSON.stringify({
            createdAt: iso(page[page.length - 1].created_at),
            id: page[page.length - 1].id,
          }),
          "utf8",
        ).toString("base64url")
      : null;
  return { data: page.map(toSession), nextCursor };
}

// ---------------------------------------------------------------------------
// Insert (used by create.ts + fork.ts)
// ---------------------------------------------------------------------------

export interface InsertSessionInput {
  id: string;
  agentId: string;
  agentVersion: number;
  environmentId: string;
  title?: string;
  budget?: Budget;
  vaultIds?: string[];
  resources?: string[];
  metadata?: Metadata;
  jsonlObjectKey: string;
  agentOverrides?: Record<string, unknown> | null;
  forkedFromSessionId?: string | null;
}

/**
 * Insert a fresh session row in `idle` status with zero usage. No sandbox
 * provisioning happens here — the sandbox starts lazily on the first
 * `user.message` event (§6.3). Returns the inserted row.
 */
export async function insertSessionRow(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: InsertSessionInput,
): Promise<SessionRow> {
  const { rows } = await tenantScopedQuery<SessionRow>(
    pool,
    tenantCtx,
    `INSERT INTO sessions
       (tenant_id, id, agent_id, agent_version, environment_id, title,
        status, stop_reason, budget, usage, vault_ids, resources,
        agent_overrides, metadata, jsonl_object_key, forked_from_session_id,
        sandbox_handle)
     VALUES ($1, $2, $3, $4, $5, $6,
             'idle', NULL, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
             $11::jsonb, $12::jsonb, $13, $14, NULL)
     RETURNING *`,
    [
      tenantCtx.tenantId,
      input.id,
      input.agentId,
      input.agentVersion,
      input.environmentId,
      input.title ?? null,
      input.budget ? JSON.stringify(input.budget) : null,
      JSON.stringify(EMPTY_USAGE),
      JSON.stringify(input.vaultIds ?? []),
      JSON.stringify(input.resources ?? []),
      input.agentOverrides ? JSON.stringify(input.agentOverrides) : null,
      JSON.stringify(input.metadata ?? {}),
      input.jsonlObjectKey,
      input.forkedFromSessionId ?? null,
    ],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Update (PATCH tools/mcpServers only, idle-only)
// ---------------------------------------------------------------------------

/**
 * Update a session's per-session `tools` and/or `mcpServers` (full-replacement
 * semantics, §6.3). Stored as `agent_overrides` so the effective config (read by
 * the DB-backed `SessionStore`) reflects the patch without creating a new agent
 * version. `model`/`systemPrompt`/`skills` are fixed for the session's lifetime.
 *
 * Rejects with `409 session_not_idle` unless the session is `idle`. A field
 * present in `patch` fully replaces the prior per-session value; an omitted
 * field is inherited (left as-is).
 */
export async function updateSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  patch: { tools?: unknown; mcpServers?: unknown },
): Promise<Session | null> {
  const existing = await fetchLiveSessionRow(pool, tenantCtx, id);
  if (!existing) return null;
  if (existing.status !== "idle") {
    throw new ApiError(
      409,
      "session_not_idle",
      `session must be idle to update (current status: ${existing.status})`,
    );
  }
  // Merge the patch into the existing overrides blob (full-replace per key).
  const merged: Record<string, unknown> = { ...(existing.agent_overrides ?? {}) };
  if ("tools" in patch) {
    merged.tools = patch.tools ?? undefined; // absent value → clear the override
  }
  if ("mcpServers" in patch) {
    merged.mcpServers = patch.mcpServers ?? undefined;
  }
  // Drop keys set to undefined so we don't store explicit undefined (jsonb null
  // would mean "clear" at the override layer; an absent key means "inherit").
  const stored: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) stored[k] = v;
  }
  const { rows } = await tenantScopedQuery<SessionRow>(
    pool,
    tenantCtx,
    `UPDATE sessions
        SET agent_overrides = $3::jsonb,
            updated_at = now(),
            last_activity_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'idle'
      RETURNING *`,
    [
      tenantCtx.tenantId,
      id,
      Object.keys(stored).length ? JSON.stringify(stored) : null,
    ],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Runtime-state persistence (R2.8): sandbox handle + status/stop_reason + synced etag
// ---------------------------------------------------------------------------

/**
 * Persist the provisioned sandbox handle onto a session row (R2.8). Written after the
 * runtime provisions (or re-provisions) a detached VM so a restart re-attaches the
 * surviving VM instead of orphaning it. `handle` is the provider handle name (the
 * tenant-namespaced VM name, stable across stop/start); `null` clears it.
 *
 * Tenant-scoped and archived-guarded — an archived session's handle is never rewritten.
 */
export async function updateSessionSandboxHandle(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  handle: string | null,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE sessions
        SET sandbox_handle = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'`,
    [tenantCtx.tenantId, id, handle],
  );
}

/**
 * Persist a session's wire status + stop reason (R2.8). The runtime's in-memory state
 * machine is a cache; this is the durable truth `GET /sessions` and the idle/action
 * guards read. Tenant-scoped and archived-guarded (a soft-deleted session is terminal).
 */
export async function updateSessionStatus(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  status: SessionStatus,
  stopReason: StopReason | null,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE sessions
        SET status = $3, stop_reason = $4,
            updated_at = now(), last_activity_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'`,
    [tenantCtx.tenantId, id, status, stopReason],
  );
}

/**
 * Persist the last synced object-store etag onto a session row (R2.10). Durable
 * optimistic-concurrency basis for the JSONL sync (replaces the former in-process Map,
 * which lost the basis on restart and forced a redundant full re-sync). Tenant-scoped.
 */
export async function updateSessionSyncedEtag(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  etag: string,
): Promise<void> {
  await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE sessions
        SET synced_etag = $3
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'`,
    [tenantCtx.tenantId, id, etag],
  );
}

/**
 * A row eligible for boot-time re-attach (R2.9): a session that was mid-flight when the
 * backend died (`running`/`rescheduling`) OR that already has a persisted sandbox
 * handle. Cross-tenant, unscoped — this is a system boot task (like the scheduler scan),
 * not a request path.
 */
export interface ResumableSessionRow {
  id: string;
  tenant_id: string;
  sandbox_handle: string | null;
}

/**
 * List sessions the boot-recovery step should try to re-attach a surviving detached VM
 * to (R2.9). Deliberately a raw cross-tenant scan (system task), NOT tenant-scoped.
 */
export async function listResumableSessions(
  pool: Pool,
): Promise<ResumableSessionRow[]> {
  const { rows } = await pool.query<ResumableSessionRow>(
    `SELECT id, tenant_id, sandbox_handle
       FROM sessions
      WHERE status IN ('running', 'rescheduling')
         OR sandbox_handle IS NOT NULL`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Sandbox reaper (ROB-3): destroy VMs orphaned by terminal sessions
// ---------------------------------------------------------------------------

/**
 * A terminal session that still owns a live sandbox handle (ROB-3). `DELETE` is a
 * soft-archive and a `terminated` session never runs again, yet neither path calls
 * `SandboxProvider.destroy()` — so the detached microVM (and its disk) leaks forever. The
 * reaper destroys these VMs and clears the handle. Cross-tenant, unscoped: a system
 * maintenance scan, not a request path.
 */
export interface ReapableSandboxRow {
  id: string;
  tenant_id: string;
  sandbox_handle: string;
}

/**
 * List up to `limit` terminal sessions (`archived`/`terminated`) that still carry a sandbox
 * handle (ROB-3). Batched (oldest first) so the reaper never loads the whole backlog at once.
 */
export async function listReapableSandboxSessions(
  pool: Pool,
  limit: number,
): Promise<ReapableSandboxRow[]> {
  const { rows } = await pool.query<ReapableSandboxRow>(
    `SELECT id, tenant_id, sandbox_handle
       FROM sessions
      WHERE status IN ('archived', 'terminated')
        AND sandbox_handle IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Clear a session's sandbox handle after the reaper destroyed its VM (ROB-3). Unscoped and
 * deliberately NOT archived-guarded — the reaper acts precisely on terminal/archived rows,
 * unlike the request-path {@link updateSessionSandboxHandle}.
 */
export async function clearReapedSandboxHandle(
  pool: Pool,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET sandbox_handle = NULL, updated_at = now() WHERE id = $1`,
    [sessionId],
  );
}

// ---------------------------------------------------------------------------
// Delete (archive JSONL; independent resources untouched, §6.3)
// ---------------------------------------------------------------------------

/**
 * Soft-delete a session: set `status='archived'` so the JSONL tree in the object
 * store is retained (archived) for audit unless explicitly purged (§6.3). The
 * session's agent, environment, vaults, skills, files, and memory stores are
 * independent resources in their own tables and are NOT touched. Returns `true`
 * if a live session was archived, `false` if already absent / archived.
 *
 * `status='archived'` is the ONLY way a session leaves the concurrent-session
 * set, and this UPDATE is the sole place that writes it — so this is also the
 * single source of truth for releasing the `concurrentSessions` quota counter
 * slot reserved by `createSession`/`forkSession` (R5.2). Released only when this
 * call performed the transition (a row was actually archived), not on a repeat
 * delete of an already-archived session, so the counter is decremented exactly
 * once per session.
 *
 * NOTE: the `sessions` table has no dedicated `deleted_at` column (migration
 * 006); `status='archived'` is the soft-delete marker. Archived rows are hidden
 * from `listSessions` and surfaced as `404` from `getSession`.
 */
export async function deleteSession(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<boolean> {
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `UPDATE sessions
        SET status = 'archived', updated_at = now(), last_activity_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'archived'`,
    [tenantCtx.tenantId, id],
  );
  const archived = (rowCount ?? 0) > 0;
  if (archived) {
    await releaseQuota(pool, tenantCtx, "concurrentSessions").catch(() => {});
  }
  return archived;
}

// ---------------------------------------------------------------------------
// Effective config (DB-backed SessionStore materialization + tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective `AgentConfig` for a session: load the pinned agent
 * version's config, then apply the stored per-session overrides (omit→inherit,
 * null→clear, value→full replace). Used by {@link DbSessionStore.get} and by the
 * override-matrix tests. Returns `null` if the session is absent / archived.
 */
export async function resolveEffectiveConfig(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<AgentConfigType | null> {
  const row = await fetchLiveSessionRow(pool, tenantCtx, id);
  if (!row) return null;
  const base = await loadAgentVersionConfig(pool, tenantCtx, row.agent_id, row.agent_version);
  return applyOverrides(base, row.agent_overrides);
}

/** Load a specific agent version's config blob (404 if absent). */
async function loadAgentVersionConfig(
  pool: Pool,
  tenantCtx: TenantCtx,
  agentId: string,
  version: number,
): Promise<AgentConfigType> {
  const { rows } = await tenantScopedQuery<{ config: AgentConfigType }>(
    pool,
    tenantCtx,
    `SELECT config FROM agent_versions
      WHERE tenant_id = $1 AND agent_id = $2 AND version = $3`,
    [tenantCtx.tenantId, agentId, version],
  );
  if (!rows[0]) {
    throw new ApiError(404, "not_found", `agent version not found: ${agentId} v${version}`);
  }
  return rows[0].config;
}

// ---------------------------------------------------------------------------
// Reads: entries / tree / messages / usage
// ---------------------------------------------------------------------------

/**
 * Stream a JSONL object line-by-line, yielding each parsed entry in order (PERF-4). Blank
 * and malformed lines are skipped (matching the former buffer-then-parse behavior). An
 * absent object (a fresh idle session whose log has not been written, §6.3) or a mid-read
 * error simply ends the stream — callers see no further entries rather than an error.
 *
 * Streaming lets a positional read (entries) stop as soon as it has enough instead of
 * buffering the entire transcript. The generator's `finally` cancels the underlying reader,
 * so an early `break` releases the object stream.
 */
async function* streamJsonlEntries(
  store: ObjectStore,
  key: string,
): AsyncGenerator<unknown> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await store.get(key);
  } catch {
    return; // object not found (or store error) → no entries yet
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const r = await reader.read();
        done = r.done;
        value = r.value;
      } catch {
        break; // mid-read error → stop, surfacing whatever parsed so far
      }
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* skip malformed line */
        }
      }
      if (done) break;
    }
    const tail = buf.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* skip malformed trailing line */
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Safety cap on entries materialized for whole-transcript reads (tree/messages), PERF-4. */
const MAX_JSONL_MATERIALIZED_ENTRIES = 100_000;

/**
 * Collect a session's entries into memory, bounded by
 * {@link MAX_JSONL_MATERIALIZED_ENTRIES} so a pathologically large transcript cannot OOM
 * the tree/messages reads. For a normal session (well under the cap) this is exactly the
 * former full parse.
 */
async function collectJsonlEntries(
  store: ObjectStore,
  key: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const entry of streamJsonlEntries(store, key)) {
    out.push(entry);
    if (out.length >= MAX_JSONL_MATERIALIZED_ENTRIES) break;
  }
  return out;
}

export interface EntriesQuery {
  from?: number;
  to?: number;
  limit?: number;
}

/**
 * Positional slice of the session log (§"GET /v1/sessions/:id/entries"). `seq`
 * is the 0-based monotonic position (the SSE replay cursor). For an idle session
 * with no work yet, the JSONL object is absent → empty slice.
 *
 * PERF-4: streams the log and stops once it has enough for the requested page, instead of
 * buffering + parsing the whole transcript then slicing.
 */
export async function getSessionEntries(
  store: ObjectStore | undefined,
  jsonlObjectKey: string,
  query: EntriesQuery,
): Promise<{ data: unknown[]; nextCursor: string | null }> {
  const limit = query.limit ?? 50;
  if (!store) return { data: [], nextCursor: null };
  const from = query.from ?? 0;
  const to = query.to ?? Number.POSITIVE_INFINITY;
  // Skip entries before `from`; collect within [from, to) until we have limit+1 (enough to
  // know whether another page exists), then stop — the generator's finally cancels the
  // object stream, so we never read past what the page needs.
  const collected: unknown[] = [];
  let seq = -1;
  for await (const raw of streamJsonlEntries(store, jsonlObjectKey)) {
    seq += 1;
    if (seq < from) continue;
    if (seq >= to) break;
    collected.push(raw);
    if (collected.length > limit) break;
  }
  const hasMore = collected.length > limit;
  const page = hasMore ? collected.slice(0, limit) : collected;
  const data = page.map((raw, i) => {
    const entry = raw as Record<string, unknown>;
    const s = from + i;
    const processedAt =
      typeof entry?.timestamp === "string"
        ? entry.timestamp
        : typeof entry?.processedAt === "string"
          ? entry.processedAt
          : null;
    return { ...entry, seq: s, processedAt };
  });
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(JSON.stringify({ from: from + page.length }), "utf8").toString(
          "base64url",
        )
      : null;
  return { data, nextCursor };
}

/**
 * The JSONL tree structure (§"GET /v1/sessions/:id/tree"): branches + fork
 * points. Opaque to clients (contracts `SessionTree = z.unknown()`); this is a
 * minimal concrete shape derived from entry `parentId` links. For an idle
 * session with no log, an empty tree is returned.
 */
export async function getSessionTree(
  store: ObjectStore | undefined,
  jsonlObjectKey: string,
): Promise<unknown> {
  if (!store) return { root: null, branches: [] };
  const entries = (await collectJsonlEntries(store, jsonlObjectKey)) as Array<{
    id?: string;
    parentId?: string | null;
    type?: string;
  }>;
  if (entries.length === 0) return { root: null, branches: [] };
  const nodes = entries.map((e) => ({
    id: e.id ?? null,
    parentId: e.parentId ?? null,
    type: e.type ?? null,
  }));
  return { root: nodes[0]?.id ?? null, branches: nodes };
}

/**
 * Post-compaction LLM-context message list (§"GET /v1/sessions/:id/messages",
 * Pi's `session.messages` view §A.2 #12). For an idle session (no work yet)
 * there are no messages. When a log exists, message-bearing entries are
 * surfaced in order. Full compaction is a runtime concern (WP-1.5).
 */
export async function getSessionMessages(
  store: ObjectStore | undefined,
  jsonlObjectKey: string,
): Promise<unknown[]> {
  if (!store) return [];
  const entries = (await collectJsonlEntries(store, jsonlObjectKey)) as Array<{
    message?: unknown;
  }>;
  return entries.map((e) => e.message).filter((m) => m !== undefined);
}

/**
 * Cumulative token usage for a session (§"GET /v1/sessions/:id/usage"). Token
 * counts are stored in the `sessions.usage` jsonb (updated by the usage recorder
 * during runtime, WP-1.10). `usdCost` is derived; until a price table is wired
 * at the session-read layer it is `0` (the authoritative counts are returned).
 */
export async function getSessionUsage(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Usage & { usdCost: number } | null> {
  const row = await fetchLiveSessionRow(pool, tenantCtx, id);
  if (!row) return null;
  return { ...normalizeUsage(row.usage), usdCost: 0 };
}
