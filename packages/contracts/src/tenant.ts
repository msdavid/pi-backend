/**
 * @pi-managed/contracts — Tenant / admin (SaaS shape).
 *
 * Mirrors docs/api-reference.md §"Tenant / admin". The raw API key is shown ONCE at
 * issuance; the resource (retrieve/list) never includes the raw key.
 */

import { z } from "zod";
import { Timestamp, Usage } from "./common.js";
import { tenantId, apikeyId, agentId } from "./ids.js";

// --- Quota usage (§27.3) ----------------------------------------------------

export const QuotaUsage = z.object({
  concurrentSessions: z.number().int().nonnegative(),
  concurrentSandboxes: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
  vaultSize: z.number().int().nonnegative(),
  memorySize: z.number().int().nonnegative(),
  fileStorage: z.number().int().nonnegative(),
  tokenSpendUsd: z.number().nonnegative(),
});
export type QuotaUsage = z.infer<typeof QuotaUsage>;

/**
 * The active quota plan's ceilings (api-reference §"GET /v1/tenant":
 * `quotaLimits`; backend `domain/quota/plans.ts` `QuotaPlan`). Shown next to
 * `quotaUsage` so clients can render usage vs limits (console spec §9.9).
 */
export const QuotaLimits = z.object({
  concurrentSessions: z.number().int().nonnegative(),
  concurrentSandboxes: z.number().int().nonnegative(),
  maxJobs: z.number().int().nonnegative(),
  maxVaultCredentials: z.number().int().nonnegative(),
  maxMemoryStores: z.number().int().nonnegative(),
  maxFileStorageBytes: z.number().int().nonnegative(),
  monthlyTokenSpendUsd: z.number().nonnegative(),
});
export type QuotaLimits = z.infer<typeof QuotaLimits>;

// --- Tenant info ------------------------------------------------------------

export const TenantInfo = z.object({
  tenantId: tenantId,
  name: z.string(),
  quotaPlan: z.string(),
  quotaUsage: QuotaUsage,
  quotaLimits: QuotaLimits,
});
export type TenantInfo = z.infer<typeof TenantInfo>;

// --- Usage over time (§26.2, console spec §11.5 — WP-C3.0) ------------------

export const TenantUsageGranularity = z.enum(["day", "month"]);
export type TenantUsageGranularity = z.infer<typeof TenantUsageGranularity>;

export const TenantUsageGroupBy = z.enum(["agent", "user"]);
export type TenantUsageGroupBy = z.infer<typeof TenantUsageGroupBy>;

/**
 * Query params for `GET /v1/tenant/usage` (api-reference §"GET /v1/tenant/usage").
 * `from` (inclusive) / `to` (exclusive) bound `recordedAt`; both default
 * server-side (`to` = now, `from` = `to` − 30 days for `day` / − 365 days for
 * `month`). Span limits (366 days / 24 months) are enforced server-side → 422.
 */
export const TenantUsageParams = z.object({
  granularity: TenantUsageGranularity.optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  groupBy: TenantUsageGroupBy.optional(),
});
export type TenantUsageParams = z.infer<typeof TenantUsageParams>;

/**
 * One UTC-aligned calendar bucket of the usage series. `agentId` is present
 * iff `groupBy=agent`; `userId` iff `groupBy=user` (`null` for spend whose
 * session carries no `metadata.userId`, §26.2).
 */
export const TenantUsageBucket = Usage.extend({
  bucketStart: Timestamp,
  usdCost: z.number().nonnegative(),
  agentId: agentId.optional(),
  userId: z.string().nullable().optional(),
});
export type TenantUsageBucket = z.infer<typeof TenantUsageBucket>;

/**
 * Response of `GET /v1/tenant/usage`. Not paginated — the bounded range bounds
 * the series; empty buckets are omitted. `from`/`to` echo the effective
 * (defaulted) bounds; `groupBy` is echoed only when requested.
 */
export const TenantUsageResponse = z.object({
  granularity: TenantUsageGranularity,
  from: Timestamp,
  to: Timestamp,
  groupBy: TenantUsageGroupBy.optional(),
  data: z.array(TenantUsageBucket),
});
export type TenantUsageResponse = z.infer<typeof TenantUsageResponse>;

// --- API keys (§8) ----------------------------------------------------------

export const ApiKeyCreate = z.object({
  name: z.string(),
  scopes: z.array(z.string()).optional(),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;

/** Create response — raw `key` shown ONCE (stored hashed argon2id, §8). */
export const ApiKeyCreateResponse = z.object({
  id: apikeyId,
  name: z.string(),
  key: z.string(),
  scopes: z.array(z.string()).optional(),
  createdAt: Timestamp,
});
export type ApiKeyCreateResponse = z.infer<typeof ApiKeyCreateResponse>;

/** API key resource (retrieve/list — NO raw key). */
export const ApiKey = z.object({
  id: apikeyId,
  name: z.string(),
  scopes: z.array(z.string()).optional(),
  createdAt: Timestamp,
  revokedAt: Timestamp.optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;
