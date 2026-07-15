/**
 * Agent domain service (§6.1, §8.1, WP-1.1).
 *
 * Versioned agent definitions: create / list / get / update (→ new immutable
 * version) / archive (terminal) / list versions / get version. Per-tenant name
 * uniqueness (§6.6). No hard delete — archive only, and archive blocks new
 * sessions (§6.1); {@link isAgentArchived} is the guard WP-1.6 calls.
 *
 * Every query routes through {@link tenantScopedQuery} so cross-tenant access is
 * impossible by construction (§27.1). The two multi-table writes (create,
 * update) are issued as single-statement data-modifying CTEs so an agent row
 * and its version blob are written atomically (no orphan rows on partial
 * failure). Config blobs are validated against the `@pi-managed/contracts` zod
 * schemas (shape-only — cross-field referential integrity like
 * mcp_servers↔mcp_toolset is enforced elsewhere, §19.3).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
// `newId` is the shared prefixed-ULID generator (§6.6); it lives in the tenant
// domain (the only consumer pre-WP-1.1) but is a generic, dependency-free util.
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import {
  AgentConfig,
  AgentCreate,
  AgentUpdate,
  type Agent,
  type AgentConfig as AgentConfigType,
  type AgentVersion,
} from "@pi-managed/contracts";

// ---------------------------------------------------------------------------
// Types & row mapping
// ---------------------------------------------------------------------------

/** `agents` row as returned by the SQL aliases below (camelCased). */
interface AgentDbRow {
  id: string;
  name: string;
  current_version: number;
  status: string;
  metadata: Record<string, string | number | boolean | null>;
  created_at: Date;
  updated_at: Date;
  /** Only joined on retrieve; absent on list/create summaries. */
  config?: AgentConfigType;
}

/** `agent_versions` row. */
interface VersionDbRow {
  version: number;
  config: AgentConfigType;
  created_at: Date;
}

/** ISO-string helper — contracts `Timestamp` is an RFC 3339 string. */
const iso = (d: Date): string => d.toISOString();

/** Build the wire `Agent` resource from a db row. */
function toAgent(row: AgentDbRow, includeConfig = false): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    currentVersion: row.current_version,
    status: row.status as "active" | "archived",
    metadata: Object.keys(row.metadata ?? {}).length ? row.metadata : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (includeConfig && row.config) {
    agent.config = row.config;
  }
  return agent;
}

/** Build the wire `AgentVersion` resource. */
function toVersion(row: VersionDbRow): AgentVersion {
  return {
    version: row.version,
    config: row.config,
    createdAt: iso(row.created_at),
  };
}

/** pg unique-violation (constraint name varies) — maps to 409 conflict (§6.6). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create an agent under `tenantCtx`. Writes the `agents` row + its initial
 * `agent_versions` (v1) atomically via a CTE. `name` must be unique within the
 * tenant (§6.6) — a duplicate raises {@link ApiError} `409 conflict`.
 */
export async function createAgent(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: AgentCreate,
): Promise<Agent> {
  const parsed = AgentCreate.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid agent config: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;
  const id = newId("agent_");
  const metadata = data.metadata ?? {};
  // Validate the versioned config blob independently (defensive — create input
  // already carries it, but this guards future callers that assemble configs).
  const config = AgentConfig.parse(stripUndefined({
    model: data.model,
    systemPrompt: data.systemPrompt,
    tools: data.tools,
    skills: data.skills,
    extensions: data.extensions,
    mcpServers: data.mcpServers,
    multiagent: data.multiagent,
  }));

  try {
    const { rows } = await tenantScopedQuery<AgentDbRow>(
      pool,
      tenantCtx,
      `WITH agent_ins AS (
         INSERT INTO agents (id, tenant_id, name, current_version, status, metadata)
           VALUES ($1, $2, $3, 1, 'active', $4::jsonb)
         RETURNING id, name, current_version, status, metadata, created_at, updated_at
       ),
       ver_ins AS (
         INSERT INTO agent_versions (tenant_id, agent_id, version, config)
           SELECT $2, $1, 1, $5::jsonb FROM agent_ins
       )
       SELECT id, name, current_version, status, metadata, created_at, updated_at
         FROM agent_ins`,
      [id, tenantCtx.tenantId, data.name, JSON.stringify(metadata), JSON.stringify(config)],
    );
    return toAgent(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        "conflict",
        `an agent named "${data.name}" already exists in this tenant`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListAgentsOptions {
  limit: number;
  cursor?: string;
  /** Exact name match filter (optional). */
  name?: string;
  /** `metadata.<key>=<value>` equality filters (metadata->>'key' = value). */
  metadata?: Record<string, string>;
}

/** Decode a list cursor into its `{id}` position marker (ULIDs are monotonic — id alone suffices for stable seek pagination). */
function decodeListCursor(cursor: string): { id: string } {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { id?: string; createdAt?: string };
  // Back-compat: old cursors encoded {createdAt, id}; accept the id from either shape.
  if (!parsed.id) {
    throw new ApiError(400, "invalid_request", "invalid list cursor");
  }
  return { id: parsed.id };
}

/**
 * List agents for `tenantCtx`, newest first, cursor-paginated. Optional `name`
 * and `metadata.*` equality filters narrow the set (§"GET /v1/agents").
 */
export async function listAgents(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListAgentsOptions,
): Promise<{ data: Agent[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [tenantCtx.tenantId];
  let i = 2;
  if (opts.name) {
    where.push(`name = $${i++}`);
    params.push(opts.name);
  }
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) {
      where.push(`metadata->>$${i++} = $${i++}`);
      params.push(k, v);
    }
  }
  if (opts.cursor) {
    const c = decodeListCursor(opts.cursor);
    where.push(`id < $${i++}`);
    params.push(c.id);
  }
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  // Fetch limit+1 to detect a next page without a second round-trip.
  params.push(opts.limit + 1);
  const limitParam = `$${i++}`;
  const { rows } = await tenantScopedQuery<AgentDbRow>(
    pool,
    tenantCtx,
    `SELECT id, name, current_version, status, metadata, created_at, updated_at
       FROM agents
      WHERE tenant_id = $1 ${whereSql}
      ORDER BY id DESC
      LIMIT ${limitParam}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ id: last.id }),
      "utf8",
    ).toString("base64url");
  }
  return { data: page.map((r) => toAgent(r)), nextCursor };
}

// ---------------------------------------------------------------------------
// Retrieve
// ---------------------------------------------------------------------------

/** Load a single agent row (joined with its current-version config). */
async function fetchAgent(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<AgentDbRow | null> {
  const { rows } = await tenantScopedQuery<AgentDbRow>(
    pool,
    tenantCtx,
    `SELECT a.id, a.name, a.current_version, a.status, a.metadata,
            a.created_at, a.updated_at, v.config
       FROM agents a
       LEFT JOIN agent_versions v
         ON v.agent_id = a.id AND v.version = a.current_version
        AND v.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ?? null;
}

/** Retrieve an agent (current-version config expanded). `404` if absent. */
export async function getAgent(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Agent> {
  const row = await fetchAgent(pool, tenantCtx, id);
  if (!row) {
    throw new ApiError(404, "not_found", `agent not found: ${id}`);
  }
  return toAgent(row, true);
}

// ---------------------------------------------------------------------------
// Update (creates a new version)
// ---------------------------------------------------------------------------

/**
 * Merge a patch into the previous version's config. Per `AgentUpdate`
 * (AgentCreate.partial()): a present field fully replaces the prior value; an
 * omitted field is inherited. `name`/`metadata` live on the agent row, not the
 * versioned blob.
 */
function mergeConfig(
  prev: AgentConfigType,
  patch: AgentUpdate,
): AgentConfigType {
  const merged = stripUndefined({
    model: "model" in patch ? patch.model : prev.model,
    systemPrompt: "systemPrompt" in patch ? patch.systemPrompt : prev.systemPrompt,
    tools: "tools" in patch ? patch.tools : prev.tools,
    skills: "skills" in patch ? patch.skills : prev.skills,
    extensions: "extensions" in patch ? patch.extensions : prev.extensions,
    mcpServers: "mcpServers" in patch ? patch.mcpServers : prev.mcpServers,
    multiagent: "multiagent" in patch ? patch.multiagent : prev.multiagent,
  });
  return AgentConfig.parse(merged);
}

/**
 * Update an agent — creates a new immutable version and points
 * `current_version` at it (§6.1). `name`/`metadata` updates apply to the agent
 * row. Archive is terminal: updating an archived agent raises
 * `409 resource_archived`. A duplicate name on rename raises `409 conflict`.
 */
export async function updateAgent(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  patch: AgentUpdate,
): Promise<Agent> {
  const parsed = AgentUpdate.safeParse(patch);
  if (!parsed.success) {
    throw new ApiError(
      422,
      "invalid_request",
      `invalid agent update: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const data = parsed.data;

  const prev = await fetchAgent(pool, tenantCtx, id);
  if (!prev) {
    throw new ApiError(404, "not_found", `agent not found: ${id}`);
  }
  if (prev.status === "archived") {
    throw new ApiError(
      409,
      "resource_archived",
      `agent ${id} is archived; archived agents are read-only`,
    );
  }
  const prevConfig = prev.config ?? (AgentConfig.parse({ model: { provider: "", id: "" } }));
  const newConfig = mergeConfig(prevConfig, data);
  const newName = data.name ?? prev.name;
  const newMetadata = data.metadata ?? (prev.metadata ?? {});

  try {
    const { rows, rowCount } = await tenantScopedQuery<AgentDbRow>(
      pool,
      tenantCtx,
      `WITH ver_ins AS (
         INSERT INTO agent_versions (tenant_id, agent_id, version, config)
           VALUES ($1, $2,
                   (SELECT COALESCE(MAX(version), 0) + 1
                      FROM agent_versions
                     WHERE agent_id = $2 AND tenant_id = $1),
                   $3::jsonb)
         RETURNING version
       ),
       upd AS (
         UPDATE agents
            SET current_version = (SELECT version FROM ver_ins),
                name = $4,
                metadata = $5::jsonb,
                updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status = 'active'
         RETURNING id, name, current_version, status, metadata, created_at, updated_at
       )
       SELECT id, name, current_version, status, metadata, created_at, updated_at FROM upd`,
      [tenantCtx.tenantId, id, JSON.stringify(newConfig), newName, JSON.stringify(newMetadata)],
    );
    if ((rowCount ?? 0) === 0) {
      // Lost a race with an archive between the pre-check and the UPDATE.
      throw new ApiError(409, "resource_archived", `agent ${id} is archived`);
    }
    const row = rows[0];
    // Attach the freshly-written config (the CTE returns agent columns only).
    row.config = newConfig;
    return toAgent(row, true);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        "conflict",
        `an agent named "${newName}" already exists in this tenant`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Archive (terminal)
// ---------------------------------------------------------------------------

/**
 * Archive an agent — terminal (§6.1). Sets `status='archived'`; no unarchive.
 * Idempotent: archiving an already-archived agent returns the archived
 * resource (still `200`). `404` if the agent is absent (or another tenant's).
 */
export async function archiveAgent(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Agent> {
  const { rows, rowCount } = await tenantScopedQuery<AgentDbRow>(
    pool,
    tenantCtx,
    `UPDATE agents
        SET status = 'archived', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING id, name, current_version, status, metadata, created_at, updated_at`,
    [tenantCtx.tenantId, id],
  );
  if ((rowCount ?? 0) > 0) {
    return toAgent(rows[0]);
  }
  // No row updated: either absent or already archived. Distinguish for the
  // correct response (404 vs idempotent 200).
  const existing = await fetchAgent(pool, tenantCtx, id);
  if (!existing) {
    throw new ApiError(404, "not_found", `agent not found: ${id}`);
  }
  return toAgent(existing);
}

/**
 * Is `agentId` archived (terminal) for `tenantCtx`? Returns `true` only when
 * the agent exists and `status='archived'`; `false` when active or absent.
 * WP-1.6 calls this before provisioning a session against an agent (§6.1).
 */
export async function isAgentArchived(
  pool: Pool,
  tenantCtx: TenantCtx,
  agentId: string,
): Promise<boolean> {
  const { rows } = await tenantScopedQuery<{ status: string }>(
    pool,
    tenantCtx,
    `SELECT status FROM agents WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, agentId],
  );
  return rows[0]?.status === "archived";
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** List all versions of an agent, newest-version first (cursor-paginated). */
export async function listVersions(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  opts: { limit: number; cursor?: string },
): Promise<{ data: AgentVersion[]; nextCursor: string | null }> {
  // Existence + tenancy guard (returns 404 rather than an empty version list).
  const agent = await fetchAgent(pool, tenantCtx, id);
  if (!agent) {
    throw new ApiError(404, "not_found", `agent not found: ${id}`);
  }
  const params: unknown[] = [tenantCtx.tenantId, id];
  let where = "";
  if (opts.cursor) {
    const v = decodeVersionCursor(opts.cursor);
    where = `AND version < $3`;
    params.push(v);
  }
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT version, config, created_at
       FROM agent_versions
      WHERE tenant_id = $1 AND agent_id = $2 ${where}
      ORDER BY version DESC
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? Buffer.from(JSON.stringify({ version: page[page.length - 1].version }), "utf8").toString(
          "base64url",
        )
      : null;
  return { data: page.map(toVersion), nextCursor };
}

function decodeVersionCursor(cursor: string): number {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json) as { version?: number };
  if (typeof parsed.version !== "number") {
    throw new ApiError(400, "invalid_request", "invalid version cursor");
  }
  return parsed.version;
}

/** Retrieve a specific version's config blob. `404` if the version is absent. */
export async function getVersion(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  version: number,
): Promise<AgentVersion> {
  const { rows } = await tenantScopedQuery<VersionDbRow>(
    pool,
    tenantCtx,
    `SELECT version, config, created_at
       FROM agent_versions
      WHERE tenant_id = $1 AND agent_id = $2 AND version = $3`,
    [tenantCtx.tenantId, id, version],
  );
  if (!rows[0]) {
    throw new ApiError(
      404,
      "not_found",
      `agent version not found: ${id} v${version}`,
    );
  }
  return toVersion(rows[0]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop `undefined` own-properties so JSON.stringify omits them (zod-clean). */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
