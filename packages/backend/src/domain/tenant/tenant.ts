/**
 * Tenant model (§3.1, §7.1).
 *
 * Tenants are the tenancy *root* — the `tenants` table is not itself
 * tenant-scoped (it has no `tenant_id` column), so these helpers use the raw
 * `query` helper rather than {@link tenantScopedQuery} (which would reject a
 * query that does not filter on `tenant_id`).
 *
 * Single-tenant deployments auto-create the **implicit tenant** (§7.1):
 * {@link getOrCreateImplicitTenant} is idempotent and is called at first
 * API-key issuance / bootstrap so a fresh deployment has a tenant to scope
 * resources against.
 */

import { query, type Pool } from "../../infra/db/index.js";
import { newId } from "./ids.js";

/** A tenant row (camelCased for ergonomic internal use). */
export interface TenantRow {
  id: string;
  name: string;
  quotaPlan: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantInput {
  name: string;
  quotaPlan?: string;
}

/**
 * Create a tenant with a fresh `tnt_…` id. Use for multi-tenant (SaaS) onboarding;
 * single-tenant deployments should use {@link getOrCreateImplicitTenant}.
 */
export async function createTenant(
  pool: Pool,
  input: CreateTenantInput,
): Promise<TenantRow> {
  const id = newId("tnt_");
  const { rows } = await query<TenantRow>(
    pool,
    `INSERT INTO tenants (id, name, quota_plan)
       VALUES ($1, $2, $3)
     RETURNING id, name, quota_plan AS "quotaPlan",
       created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, input.name, input.quotaPlan ?? null],
  );
  const tenant = rows[0];
  await runTenantSeed(pool, tenant.id);
  return tenant;
}

// ---------------------------------------------------------------------------
// Tenant seeding (R6.5c)
// ---------------------------------------------------------------------------

/**
 * Seeds a freshly created tenant's default resources. Registered by the composition root
 * (`app.ts`), which wires it to `seedPrebuiltSkills` — the pre-built `pptx`/`xlsx`/`docx`/
 * `pdf` skill set (§20.1). It is
 * a registration seam rather than a parameter because tenant creation happens on paths
 * (`onboarding/signup.ts`) that hold no object store, and seeding writes skill bundles to
 * it.
 */
export type TenantSeedHook = (pool: Pool, tenantId: string) => Promise<void>;

let tenantSeedHook: TenantSeedHook | undefined;

/** Register the tenant seed hook (composition root). */
export function setTenantSeedHook(hook: TenantSeedHook): void {
  tenantSeedHook = hook;
}

/** Unregister the seed hook (app shutdown / test isolation). */
export function clearTenantSeedHook(): void {
  tenantSeedHook = undefined;
}

/**
 * Run the registered seed for a new tenant. Best-effort by design: an object-store blip
 * must not fail (and roll back) a sign-up. The seed is idempotent, so a later call
 * (a re-run, or the next tenant-scoped skill list) recreates what is missing.
 */
async function runTenantSeed(pool: Pool, tenantId: string): Promise<void> {
  if (!tenantSeedHook) return;
  try {
    await tenantSeedHook(pool, tenantId);
  } catch {
    /* best-effort: seeding must never fail tenant creation */
  }
}

/** Fetch a tenant by id, or `null` if absent. */
export async function getTenant(
  pool: Pool,
  tenantId: string,
): Promise<TenantRow | null> {
  const { rows } = await query<TenantRow>(
    pool,
    `SELECT id, name, quota_plan AS "quotaPlan",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/**
 * The well-known id of the implicit (single-tenant) tenant (§7.1). Deterministic
 * so repeated bootstrap calls resolve to the same row.
 */
export const IMPLICIT_TENANT_ID = "tnt_implicit";

/**
 * §7.1 — single-tenant deployments auto-create the implicit tenant. Idempotent:
 * inserts with `ON CONFLICT DO NOTHING` then reads the row, so it is safe to call
 * on every bootstrap / first-issuance path.
 */
export async function getOrCreateImplicitTenant(pool: Pool): Promise<TenantRow> {
  await query(
    pool,
    `INSERT INTO tenants (id, name, quota_plan)
       VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [IMPLICIT_TENANT_ID, "Implicit Tenant", "default"],
  );
  const tenant = await getTenant(pool, IMPLICIT_TENANT_ID);
  if (!tenant) {
    throw new Error("failed to create implicit tenant");
  }
  return tenant;
}
