/**
 * @pi-managed/contracts — Tenant / admin (SaaS shape).
 *
 * Mirrors docs/api-reference.md §"Tenant / admin". The raw API key is shown ONCE at
 * issuance; the resource (retrieve/list) never includes the raw key.
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { tenantId, apikeyId } from "./ids.js";

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

// --- Tenant info ------------------------------------------------------------

export const TenantInfo = z.object({
  tenantId: tenantId,
  name: z.string(),
  quotaPlan: z.string(),
  quotaUsage: QuotaUsage,
});
export type TenantInfo = z.infer<typeof TenantInfo>;

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
