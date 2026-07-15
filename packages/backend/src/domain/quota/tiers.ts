/**
 * Tier → {@link QuotaPlan} mapping (WP-4.4, §27.3).
 *
 * Resolves a tenant's `quota_plan` (stored on `tenants`, §3.1) to a concrete
 * {@link QuotaPlan}. Config-driven: an operator may override any plan field per
 * tier via env vars of the form
 *
 *   QUOTA_PLAN_FREE='{"concurrentSessions":1,"maxJobs":3}'
 *
 * (one JSON object per tier, partial — unspecified fields keep the seeded
 * default). Malformed JSON is ignored so a typo cannot brick boot.
 */

import type { Pool } from "../../infra/db/index.js";
import { getTenant } from "../tenant/tenant.js";
import { DEFAULT_QUOTA_PLANS, type QuotaPlan, type QuotaPlanName } from "./plans.js";

/** Env override prefix; `QUOTA_PLAN_FREE`, `QUOTA_PLAN_PRO`, … */
const ENV_OVERRIDE_PREFIX = "QUOTA_PLAN_";

/** Parse env overrides once at module load (config is fixed at boot). */
function parseEnvOverrides(): Partial<Record<QuotaPlanName, Partial<QuotaPlan>>> {
  const out: Partial<Record<QuotaPlanName, Partial<QuotaPlan>>> = {};
  for (const name of Object.keys(DEFAULT_QUOTA_PLANS) as QuotaPlanName[]) {
    const raw = process.env[`${ENV_OVERRIDE_PREFIX}${name.toUpperCase()}`];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out[name] = parsed as Partial<QuotaPlan>;
      }
    } catch {
      // Ignore malformed overrides; seeded defaults apply.
    }
  }
  return out;
}

const envOverrides = parseEnvOverrides();

/** Resolve a plan name to a concrete plan, applying any env override. */
function resolvePlan(name: QuotaPlanName): QuotaPlan {
  const base = DEFAULT_QUOTA_PLANS[name] ?? DEFAULT_QUOTA_PLANS.default;
  const override = envOverrides[name];
  return override ? { ...base, ...override } : base;
}

/** The set of recognized plan names (lowercased). */
const KNOWN = new Set<string>(Object.keys(DEFAULT_QUOTA_PLANS));

/**
 * Resolve a (possibly null/unknown) `quota_plan` string to a {@link QuotaPlan}.
 * Unknown / null → `default` (= `pro`), so the implicit single-tenant deployment
 * (§7.1, `quota_plan = 'default'`) and unrecognized values fall back gracefully.
 */
export function planForName(name: string | null | undefined): QuotaPlan {
  const norm = (name ?? "default").toLowerCase();
  return resolvePlan(
    (KNOWN.has(norm) ? norm : "default") as QuotaPlanName,
  );
}

/**
 * Resolve the active {@link QuotaPlan} for a tenant by reading its `quota_plan`
 * from the `tenants` table. Returns the `default` plan if the tenant is absent
 * (defensive — the auth layer guarantees the tenant exists in request paths).
 */
export async function getQuotaPlanForTenant(
  pool: Pool,
  tenantId: string,
): Promise<QuotaPlan> {
  const tenant = await getTenant(pool, tenantId);
  return planForName(tenant?.quotaPlan);
}
