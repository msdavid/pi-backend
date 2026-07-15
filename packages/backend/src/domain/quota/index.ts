/**
 * Quota domain barrel (WP-4.4): plans, tier mapping, enforcement.
 */

export {
  DEFAULT_QUOTA_PLANS,
  QUOTA_PLAN_NAMES,
  type QuotaPlan,
  type QuotaPlanName,
} from "./plans.js";
export {
  planForName,
  getQuotaPlanForTenant,
} from "./tiers.js";
export {
  getCurrentUsage,
  currentUsageForResource,
  checkQuota,
  reserveQuota,
  releaseQuota,
  reserveQuotaDelta,
  releaseQuotaDelta,
  reconcileQuotaCounter,
  type QuotaUsage,
  type QuotaResource,
  type CounterResource,
  type AmountResource,
  type ReconcilableResource,
  type ReconcileResult,
  type QuotaCheck,
  type QuotaCheckOptions,
} from "./enforce.js";
