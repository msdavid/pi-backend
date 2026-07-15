/**
 * Consolidated per-tier configuration surface (WP-5.5).
 *
 * Single schema consolidating EVERY "configurable per tier" knob accumulated
 * across the backend:
 *
 *  - Vault credential cap — §12.4 (schema default 20).
 *  - Job cap — §17.3 (schema default 1000).
 *  - Quota envelope — §27.3 (the seven per-tenant dimensions; previously
 *    hardcoded in `quota/plans.ts`).
 *  - Retention — §6.3 (30-day sandbox checkpoint + 90-day JSONL), §13.5
 *    (30-day memory version), plus the `job_runs` / `webhook_deliveries`
 *    90-day defaults documented in `docs/db-schema.md`.
 *
 * Subsystems resolve their limit via {@link getTierConfig} (see `loader.ts`)
 * rather than holding private constants. The {@link DEFAULT_TIER_CONFIGS} below
 * preserve the WP-4.4 quota numbers exactly so wiring `quota/plans.ts` to this
 * surface is behaviour-preserving.
 *
 * Authority: `docs/decisions.md` §6.3/§12.4/§17.3 + `docs/db-schema.md`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One tier's resolved limit envelope. Field names are authoritative across the
 * codebase; subsystems read the field that matches their concern.
 *
 * Schema defaults (applied when a field is omitted) cite the resolved ADRs:
 * `maxVaultCredentials`→§12.4 (20), `maxJobs`→§17.3 (1000),
 * `checkpointRetentionDays`→§6.3 (30), `jsonlRetentionDays`→90-day log
 * retention (decisions.md), `memoryVersionRetentionDays`→§13.5 (30),
 * `jobRunRetentionDays`/`webhookDeliveryRetentionDays`→90-day defaults
 * (`docs/db-schema.md`).
 */
export const TierConfigSchema = z.object({
  /** Max active vault credentials per tenant (§27.3). Per-vault hard cap is §12.4 = 20. */
  maxVaultCredentials: z.number().int().min(0).default(20),
  /** Max non-archived scheduled jobs per tenant (§17.3 = 1000). */
  maxJobs: z.number().int().min(0).default(1000),
  /** Max concurrently-active sessions (§27.3). */
  maxConcurrentSessions: z.number().int().min(0).default(10),
  /** Max concurrently-live sandboxes (§27.3). */
  maxConcurrentSandboxes: z.number().int().min(0).default(10),
  /** Max active memory stores per tenant (§27.3). */
  maxMemoryStores: z.number().int().min(0).default(25),
  /** Max bytes a single memory store may hold (§13.5). */
  maxMemoryPerStore: z.number().int().min(0).default(100 * 1024 * 1024),
  /** Max total bytes of uploaded file storage per tenant (§27.3). */
  maxFileStorageBytes: z.number().int().min(0).default(10 * 1024 * 1024 * 1024),
  /** Max USD token spend per calendar month (§27.3). */
  monthlyTokenSpendUsd: z.number().min(0).default(200),
  /** Days to retain idle sandbox checkpoints (§6.3 = 30). */
  checkpointRetentionDays: z.number().int().min(0).default(30),
  /** Days to retain the session JSONL tree after last activity (90, decisions.md). */
  jsonlRetentionDays: z.number().int().min(0).default(90),
  /** Days to retain memory versions (§13.5 = 30; recent versions always kept). */
  memoryVersionRetentionDays: z.number().int().min(0).default(30),
  /** Days to retain `job_runs` rows (`docs/db-schema.md`, 90-day default). */
  jobRunRetentionDays: z.number().int().min(0).default(90),
  /** Days to retain `webhook_deliveries` rows (`docs/db-schema.md`, 90-day default). */
  webhookDeliveryRetentionDays: z.number().int().min(0).default(90),
});
export type TierConfig = z.infer<typeof TierConfigSchema>;

/** Recognized tier names — mirror `quota/plans.ts` `QUOTA_PLAN_NAMES`. */
export const TIER_NAMES = ["free", "pro", "enterprise", "default"] as const;
export type TierName = (typeof TIER_NAMES)[number];

/**
 * Seeded per-tier configs. The seven quota dimensions mirror WP-4.4's
 * `DEFAULT_QUOTA_PLANS` exactly (free < pro < enterprise; `default` = `pro`).
 * Retention fields use the §6.3/§13.5/`db-schema.md` defaults uniformly; an
 * operator overrides any field per tier via the loader (file or env).
 */
export const DEFAULT_TIER_CONFIGS: Record<TierName, TierConfig> = {
  free: {
    maxVaultCredentials: 10,
    maxJobs: 5,
    maxConcurrentSessions: 2,
    maxConcurrentSandboxes: 2,
    maxMemoryStores: 3,
    maxMemoryPerStore: 10 * 1024 * 1024,
    maxFileStorageBytes: 500 * 1024 * 1024,
    monthlyTokenSpendUsd: 5,
    checkpointRetentionDays: 30,
    jsonlRetentionDays: 90,
    memoryVersionRetentionDays: 30,
    jobRunRetentionDays: 90,
    webhookDeliveryRetentionDays: 90,
  },
  pro: {
    maxVaultCredentials: 100,
    maxJobs: 100,
    maxConcurrentSessions: 10,
    maxConcurrentSandboxes: 10,
    maxMemoryStores: 25,
    maxMemoryPerStore: 100 * 1024 * 1024,
    maxFileStorageBytes: 10 * 1024 * 1024 * 1024,
    monthlyTokenSpendUsd: 200,
    checkpointRetentionDays: 30,
    jsonlRetentionDays: 90,
    memoryVersionRetentionDays: 30,
    jobRunRetentionDays: 90,
    webhookDeliveryRetentionDays: 90,
  },
  enterprise: {
    maxVaultCredentials: 500,
    maxJobs: 1000,
    maxConcurrentSessions: 50,
    maxConcurrentSandboxes: 50,
    maxMemoryStores: 100,
    maxMemoryPerStore: 1024 * 1024 * 1024,
    maxFileStorageBytes: 100 * 1024 * 1024 * 1024,
    monthlyTokenSpendUsd: 5000,
    checkpointRetentionDays: 30,
    jsonlRetentionDays: 90,
    memoryVersionRetentionDays: 30,
    jobRunRetentionDays: 90,
    webhookDeliveryRetentionDays: 90,
  },
  default: {
    maxVaultCredentials: 100,
    maxJobs: 100,
    maxConcurrentSessions: 10,
    maxConcurrentSandboxes: 10,
    maxMemoryStores: 25,
    maxMemoryPerStore: 100 * 1024 * 1024,
    maxFileStorageBytes: 10 * 1024 * 1024 * 1024,
    monthlyTokenSpendUsd: 200,
    checkpointRetentionDays: 30,
    jsonlRetentionDays: 90,
    memoryVersionRetentionDays: 30,
    jobRunRetentionDays: 90,
    webhookDeliveryRetentionDays: 90,
  },
};
