/**
 * Environment service (WP-1.2, §6.2, §"Environments").
 *
 * CRUD + archive for the sandbox configuration resource. Not versioned (§6.2).
 * Supports both `cloud` and `self_hosted` types (WP-4.1 unlocks `self_hosted`,
 * §10.4); the self-hosted unsupported-features matrix (no memory stores, no
 * env-var creds) is enforced at session creation (domain/self-hosted/constraints.ts).
 *
 * All persistence is tenant-scoped via {@link tenantScopedQuery} (§27.1). Cross-
 * tenant access is impossible by construction; absent resources return `null`
 * (routes map that to `404`).
 */

import {
  tenantScopedQuery,
  type Pool,
  type TenantCtx,
} from "../../infra/db/index.js";
import { newId } from "../tenant/ids.js";
import { ApiError } from "../errors.js";
import type {
  Environment,
  EnvironmentCreate,
  EnvironmentUpdate,
  Networking,
  ResourceStatus,
} from "@pi-managed/contracts";

/** DB row shape (snake_case + jsonb as parsed objects + dates). */
interface EnvRow {
  id: string;
  name: string;
  type: string;
  image: string;
  resources: Record<string, unknown>;
  networking: Networking;
  packages: string[];
  mounts: unknown[];
  max_duration: number | null;
  idle_timeout: number | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** Default image when the create body omits `image` (DB column is NOT NULL). */
const DEFAULT_IMAGE = "ubuntu:22.04";

/** Default networking when omitted: public-internet, private denied (§10.5). */
const DEFAULT_NETWORKING: Networking = { mode: "unrestricted" };

/** Supported environment types (cloud + self_hosted, §6.2). */
const SUPPORTED_TYPES = new Set(["cloud", "self_hosted"]);

/**
 * Map a stored DB row to the {@link Environment} wire resource (camelCase).
 * The row's `networking`/`resources`/`packages`/`mounts`/`metadata` jsonb
 * columns arrive already parsed by `pg`.
 */
function toEnvironment(r: EnvRow): Environment {
  const env: Environment = {
    id: r.id,
    name: r.name,
    type: r.type as Environment["type"],
    image: r.image,
    resources: r.resources as Environment["resources"],
    networking: r.networking,
    packages: r.packages,
    mounts: r.mounts as Environment["mounts"],
    status: r.status as ResourceStatus,
    metadata: r.metadata as Environment["metadata"],
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
  if (r.max_duration !== null) env.maxDuration = r.max_duration;
  if (r.idle_timeout !== null) env.idleTimeout = r.idle_timeout;
  return env;
}

/**
 * Create an environment. `self_hosted` is now supported (WP-4.1, §10.4); the
 * unsupported-features matrix is enforced at session creation. Enforces the
 * `(tenant_id, name)` unique constraint — a duplicate name throws a `409
 * conflict` (caught from Postgres unique-violation, code `23505`).
 */
export async function createEnvironment(
  pool: Pool,
  tenantCtx: TenantCtx,
  input: EnvironmentCreate,
): Promise<Environment> {
  if (!SUPPORTED_TYPES.has(input.type)) {
    throw new ApiError(
      422,
      "invalid_request",
      "self_hosted environments are a Phase 4 feature",
    );
  }
  const id = newId("env_");
  const image = input.image ?? DEFAULT_IMAGE;
  const resources = input.resources ?? {};
  const networking = input.networking ?? DEFAULT_NETWORKING;
  const packages = input.packages ?? [];
  const mounts = input.mounts ?? [];
  const metadata = input.metadata ?? {};
  try {
    const { rows } = await tenantScopedQuery<EnvRow>(
      pool,
      tenantCtx,
      `INSERT INTO environments
         (id, tenant_id, name, type, image, resources, networking,
          packages, mounts, max_duration, idle_timeout, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)
       RETURNING *`,
      [
        id,
        tenantCtx.tenantId,
        input.name,
        input.type,
        image,
        JSON.stringify(resources),
        JSON.stringify(networking),
        JSON.stringify(packages),
        JSON.stringify(mounts),
        input.maxDuration ?? null,
        input.idleTimeout ?? null,
        JSON.stringify(metadata),
      ],
    );
    return toEnvironment(rows[0]);
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new ApiError(
        409,
        "conflict",
        `environment name already exists: ${input.name}`,
      );
    }
    throw err;
  }
}

/** Position marker encoded in list cursors (createdAt-desc + id tiebreaker). */
export interface EnvCursor {
  createdAt: string;
  id: string;
}

/** List options for {@link listEnvironments}. */
export interface ListEnvironmentsOptions {
  limit: number;
  cursor?: EnvCursor;
  status?: ResourceStatus;
}

/** List a tenant's environments, createdAt-desc, paginated by cursor. */
export async function listEnvironments(
  pool: Pool,
  tenantCtx: TenantCtx,
  opts: ListEnvironmentsOptions,
): Promise<{ data: Environment[]; nextCursor: EnvCursor | null }> {
  const params: unknown[] = [tenantCtx.tenantId];
  let where = "tenant_id = $1";
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  if (opts.cursor) {
    params.push(opts.cursor.createdAt, opts.cursor.id);
    where +=
      ` AND (created_at < $${params.length - 1}` +
      ` OR (created_at = $${params.length - 1} AND id < $${params.length}))`;
  }
  // Fetch one extra to detect a next page without a separate count query.
  params.push(opts.limit + 1);
  const { rows } = await tenantScopedQuery<EnvRow>(
    pool,
    tenantCtx,
    `SELECT * FROM environments WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const data = page.map(toEnvironment);
  let nextCursor: EnvCursor | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = {
      createdAt: last.created_at.toISOString(),
      id: last.id,
    };
  }
  return { data, nextCursor };
}

/** Fetch a single environment by id, or `null` if absent / cross-tenant. */
export async function getEnvironment(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Environment | null> {
  const { rows } = await tenantScopedQuery<EnvRow>(
    pool,
    tenantCtx,
    `SELECT * FROM environments WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ? toEnvironment(rows[0]) : null;
}

/**
 * Patch-update an environment (not versioned — §6.2). Rejects `self_hosted`.
 * Returns the updated resource, or `null` if absent / cross-tenant.
 */
export async function updateEnvironment(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
  patch: EnvironmentUpdate,
): Promise<Environment | null> {
  if (patch.type !== undefined && !SUPPORTED_TYPES.has(patch.type)) {
    throw new ApiError(
      422,
      "invalid_request",
      "self_hosted environments are a Phase 4 feature",
    );
  }
  // Read-then-write: environments are small and rare-update; a row lock keeps
  // the patch atomic without a complex dynamic UPDATE builder.
  const { rows: existing } = await tenantScopedQuery<EnvRow>(
    pool,
    tenantCtx,
    `SELECT * FROM environments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantCtx.tenantId, id],
  );
  if (existing.length === 0) return null;
  const cur = toEnvironment(existing[0]);
  const next: Environment = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.image !== undefined ? { image: patch.image } : {}),
    ...(patch.resources !== undefined ? { resources: patch.resources } : {}),
    ...(patch.networking !== undefined ? { networking: patch.networking } : {}),
    ...(patch.packages !== undefined ? { packages: patch.packages } : {}),
    ...(patch.mounts !== undefined ? { mounts: patch.mounts } : {}),
    ...(patch.maxDuration !== undefined ? { maxDuration: patch.maxDuration } : {}),
    ...(patch.idleTimeout !== undefined ? { idleTimeout: patch.idleTimeout } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
  };
  try {
    const { rows } = await tenantScopedQuery<EnvRow>(
      pool,
      tenantCtx,
      `UPDATE environments SET
          name = $3, type = $4, image = $5, resources = $6, networking = $7,
          packages = $8, mounts = $9, max_duration = $10, idle_timeout = $11,
          metadata = $12, updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      [
        tenantCtx.tenantId,
        id,
        next.name,
        next.type,
        next.image,
        JSON.stringify(next.resources ?? {}),
        JSON.stringify(next.networking ?? DEFAULT_NETWORKING),
        JSON.stringify(next.packages ?? []),
        JSON.stringify(next.mounts ?? []),
        next.maxDuration ?? null,
        next.idleTimeout ?? null,
        JSON.stringify(next.metadata ?? {}),
      ],
    );
    return rows[0] ? toEnvironment(rows[0]) : null;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      throw new ApiError(
        409,
        "conflict",
        `environment name already exists: ${next.name}`,
      );
    }
    throw err;
  }
}

/**
 * Hard-delete an environment (§6.2). Returns `true` if deleted, `false` if
 * absent / cross-tenant. Running sessions continue; new sessions referencing
 * the (now-gone) id fail with `404`.
 */
export async function deleteEnvironment(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<boolean> {
  const { rowCount } = await tenantScopedQuery(
    pool,
    tenantCtx,
    `DELETE FROM environments WHERE tenant_id = $1 AND id = $2`,
    [tenantCtx.tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Archive an environment (`status → archived`). Idempotent on an already-
 * archived row. Returns the archived resource, or `null` if absent /
 * cross-tenant. Archived environments cannot be used for new sessions (§6.2).
 */
export async function archiveEnvironment(
  pool: Pool,
  tenantCtx: TenantCtx,
  id: string,
): Promise<Environment | null> {
  const { rows } = await tenantScopedQuery<EnvRow>(
    pool,
    tenantCtx,
    `UPDATE environments SET status = 'archived', updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantCtx.tenantId, id],
  );
  return rows[0] ? toEnvironment(rows[0]) : null;
}
