/**
 * Quota plans + tier defaults (WP-4.4, §27.3, docs/capacity.md).
 *
 * A {@link QuotaPlan} is the per-tenant limit envelope across the seven
 * resource dimensions enforced at the API + scheduler (§27.3). Tiers
 * (`free` / `pro` / `enterprise`) map to plans; the active plan for a tenant is
 * stored on `tenants.quota_plan` and resolved via {@link getQuotaPlanForTenant}
 * (tiers.ts).
 *
 * Defaults are seeded **conservatively** from `docs/capacity.md` (WP-1.14): the
 * measured Phase-1 envelope provisioned 5 concurrent microsandbox sessions on a
 * single KVM host. The `free` tier stays well under that; paid tiers scale up.
 * `capacity.md` is otherwise a template, so these are conservative starting
 * points — operators tune via env overrides (see `tiers.ts`).
 */

import type { TierConfig } from "../tier-config/index.js";
import { getTierConfig } from "../tier-config/index.js";

/** The seven per-tenant quota dimensions enforced at the API + scheduler (§27.3). */
export interface QuotaPlan {
  /** Max concurrently-active (non-terminated) sessions. */
  concurrentSessions: number;
  /** Max concurrently-live sandboxes (running/rescheduling sessions). */
  concurrentSandboxes: number;
  /** Max total non-archived scheduled jobs. */
  maxJobs: number;
  /** Max total active vault credentials across all vaults. */
  maxVaultCredentials: number;
  /** Max total active memory stores. */
  maxMemoryStores: number;
  /** Max total bytes of uploaded file storage. */
  maxFileStorageBytes: number;
  /** Max USD token spend per calendar month. */
  monthlyTokenSpendUsd: number;
}

/** Supported tier names — stored on `tenants.quota_plan` (§3.1). */
export const QUOTA_PLAN_NAMES = [
  "free",
  "pro",
  "enterprise",
  "default",
] as const;
export type QuotaPlanName = (typeof QUOTA_PLAN_NAMES)[number];

/**
 * Project a {@link TierConfig} (the consolidated per-tier surface, WP-5.5) onto
 * the seven-field {@link QuotaPlan}. The TierConfig field names differ slightly
 * (`maxConcurrentSessions` vs `concurrentSessions`); this is the single place
 * that mapping lives.
 */
function tierConfigToPlan(cfg: TierConfig): QuotaPlan {
  return {
    concurrentSessions: cfg.maxConcurrentSessions,
    concurrentSandboxes: cfg.maxConcurrentSandboxes,
    maxJobs: cfg.maxJobs,
    maxVaultCredentials: cfg.maxVaultCredentials,
    maxMemoryStores: cfg.maxMemoryStores,
    maxFileStorageBytes: cfg.maxFileStorageBytes,
    monthlyTokenSpendUsd: cfg.monthlyTokenSpendUsd,
  };
}

/**
 * Conservative default plans seeded from `docs/capacity.md` (5-session measured
 * envelope). `default` is the fallback for the implicit single-tenant deployment
 * (§7.1) and for tenants whose `quota_plan` is null/unrecognized; it mirrors
 * `pro` so a fresh deployment is not artificially constrained.
 *
 * **WP-5.5**: the per-tier numbers now flow from the consolidated
 * {@link TierConfig} surface (`domain/tier-config/`) — the single source for
 * every per-tier knob (§12.4 cred cap, §17.3 job cap, §6.3 retention, §27.3
 * quotas). `quota/tiers.ts` still applies its `QUOTA_PLAN_*` env overrides on
 * top for backward compatibility.
 */
export const DEFAULT_QUOTA_PLANS: Record<QuotaPlanName, QuotaPlan> = {
  free: tierConfigToPlan(getTierConfig("free")),
  pro: tierConfigToPlan(getTierConfig("pro")),
  enterprise: tierConfigToPlan(getTierConfig("enterprise")),
  default: tierConfigToPlan(getTierConfig("default")),
};
