/**
 * Tier-config loading + override + subsystem-wiring tests (WP-5.5).
 *
 * Covers:
 *  - Seeded defaults per tier (free < pro < enterprise).
 *  - Schema defaults honour §12.4 (20), §17.3 (1000), §6.3 (30/90), §13.5 (30).
 *  - Env override (`TIER_CONFIG_FREE`) + file override + env > file > default.
 *  - Unknown/null tier → `default` fallback.
 *  - The quota subsystem (`quota/plans.ts`) reads its limits from TierConfig.
 *  - The vault (§12.4 = 20) + scheduler (§17.3 = 1000) hard caps match the
 *    consolidated TierConfig surface (single source of truth).
 *  - Retention purge knobs resolve from TierConfig (checkpoint 30, JSONL 90,
 *    memory-version 30, job-run 90, webhook 90).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_CONFIGS,
  TierConfigSchema,
  getTierConfig,
  getAllTierConfigs,
  normalizeTierName,
} from "../index.js";
import { DEFAULT_QUOTA_PLANS, QUOTA_PLAN_NAMES } from "../../quota/index.js";
import { MAX_CREDENTIALS_PER_VAULT } from "../../vault/credential.js";
import { MAX_JOBS_PER_TENANT } from "../../scheduler/job-service.js";

describe("tier-config: seeded defaults", () => {
  it("resolves the four recognized tiers", () => {
    const all = getAllTierConfigs();
    expect(Object.keys(all).sort()).toEqual(
      ["default", "enterprise", "free", "pro"],
    );
  });

  it("free < pro < enterprise across every quota dimension", () => {
    const free = getTierConfig("free");
    const pro = getTierConfig("pro");
    const ent = getTierConfig("enterprise");
    expect(free.maxJobs).toBeLessThan(pro.maxJobs);
    expect(pro.maxJobs).toBeLessThan(ent.maxJobs);
    expect(free.maxVaultCredentials).toBeLessThan(pro.maxVaultCredentials);
    expect(pro.maxVaultCredentials).toBeLessThan(ent.maxVaultCredentials);
    expect(free.maxConcurrentSessions).toBeLessThan(pro.maxConcurrentSessions);
    expect(free.maxMemoryStores).toBeLessThan(pro.maxMemoryStores);
    expect(free.maxFileStorageBytes).toBeLessThan(pro.maxFileStorageBytes);
    expect(free.monthlyTokenSpendUsd).toBeLessThan(pro.monthlyTokenSpendUsd);
  });

  it("default tier mirrors pro (fresh deployments not artificially constrained)", () => {
    expect(getTierConfig("default")).toEqual(getTierConfig("pro"));
  });

  it("seeds match DEFAULT_TIER_CONFIGS when no overrides are present", () => {
    for (const name of QUOTA_PLAN_NAMES) {
      expect(getTierConfig(name)).toEqual(DEFAULT_TIER_CONFIGS[name]);
    }
  });
});

describe("tier-config: schema defaults (§12.4/§17.3/§6.3/§13.5)", () => {
  it("honours §12.4 vault cred cap = 20 as the schema default", () => {
    expect(TierConfigSchema.parse({}).maxVaultCredentials).toBe(20);
  });

  it("honours §17.3 job cap = 1000 as the schema default", () => {
    expect(TierConfigSchema.parse({}).maxJobs).toBe(1000);
  });

  it("honours §6.3 checkpoint = 30d and 90d JSONL log retention", () => {
    const cfg = TierConfigSchema.parse({});
    expect(cfg.checkpointRetentionDays).toBe(30);
    expect(cfg.jsonlRetentionDays).toBe(90);
  });

  it("honours §13.5 memory-version retention = 30d", () => {
    expect(TierConfigSchema.parse({}).memoryVersionRetentionDays).toBe(30);
  });

  it("honours db-schema 90d defaults for job_runs + webhook_deliveries", () => {
    const cfg = TierConfigSchema.parse({});
    expect(cfg.jobRunRetentionDays).toBe(90);
    expect(cfg.webhookDeliveryRetentionDays).toBe(90);
  });
});

describe("tier-config: overrides (env > file > default)", () => {
  it("applies a partial env override on top of the seeded default", () => {
    const free = getTierConfig("free", {
      env: { TIER_CONFIG_FREE: JSON.stringify({ maxJobs: 7 }) },
    });
    expect(free.maxJobs).toBe(7);
    // Untouched fields keep the seeded default.
    expect(free.maxVaultCredentials).toBe(
      DEFAULT_TIER_CONFIGS.free.maxVaultCredentials,
    );
  });

  it("applies a partial file override", () => {
    const pro = getTierConfig("pro", {
      file: { tiers: { pro: { monthlyTokenSpendUsd: 333 } } },
    });
    expect(pro.monthlyTokenSpendUsd).toBe(333);
    expect(pro.maxJobs).toBe(DEFAULT_TIER_CONFIGS.pro.maxJobs);
  });

  it("env override wins over file override", () => {
    const ent = getTierConfig("enterprise", {
      env: { TIER_CONFIG_ENTERPRISE: JSON.stringify({ maxJobs: 42 }) },
      file: { tiers: { enterprise: { maxJobs: 99 } } },
    });
    expect(ent.maxJobs).toBe(42);
  });

  it("ignores malformed env override (seeded default applies)", () => {
    const free = getTierConfig("free", {
      env: { TIER_CONFIG_FREE: "{not json" },
    });
    expect(free.maxJobs).toBe(DEFAULT_TIER_CONFIGS.free.maxJobs);
  });

  it("normalizes unknown/null tier names to default", () => {
    expect(normalizeTierName(null)).toBe("default");
    expect(normalizeTierName("nonsense")).toBe("default");
    expect(normalizeTierName("PRO")).toBe("pro");
    expect(getTierConfig("nonsense")).toEqual(getTierConfig("default"));
  });
});

describe("tier-config: subsystem wiring", () => {
  it("quota/plans.ts DEFAULT_QUOTA_PLANS reads each limit from TierConfig", () => {
    for (const name of QUOTA_PLAN_NAMES) {
      const cfg = getTierConfig(name);
      const plan = DEFAULT_QUOTA_PLANS[name];
      expect(plan.maxJobs).toBe(cfg.maxJobs);
      expect(plan.maxVaultCredentials).toBe(cfg.maxVaultCredentials);
      expect(plan.concurrentSessions).toBe(cfg.maxConcurrentSessions);
      expect(plan.concurrentSandboxes).toBe(cfg.maxConcurrentSandboxes);
      expect(plan.maxMemoryStores).toBe(cfg.maxMemoryStores);
      expect(plan.maxFileStorageBytes).toBe(cfg.maxFileStorageBytes);
      expect(plan.monthlyTokenSpendUsd).toBe(cfg.monthlyTokenSpendUsd);
    }
  });

  it("vault §12.4 per-vault cap (20) matches the TierConfig schema default", () => {
    expect(MAX_CREDENTIALS_PER_VAULT).toBe(20);
    expect(MAX_CREDENTIALS_PER_VAULT).toBe(
      TierConfigSchema.parse({}).maxVaultCredentials,
    );
  });

  it("scheduler §17.3 per-tenant job cap (1000) matches enterprise TierConfig", () => {
    expect(MAX_JOBS_PER_TENANT).toBe(1000);
    expect(MAX_JOBS_PER_TENANT).toBe(getTierConfig("enterprise").maxJobs);
    expect(MAX_JOBS_PER_TENANT).toBe(TierConfigSchema.parse({}).maxJobs);
  });

  it("retention purge knobs resolve from TierConfig (§6.3/§13.5/db-schema)", () => {
    const cfg = getTierConfig("default");
    expect(cfg.checkpointRetentionDays).toBe(30);
    expect(cfg.jsonlRetentionDays).toBe(90);
    expect(cfg.memoryVersionRetentionDays).toBe(30);
    expect(cfg.jobRunRetentionDays).toBe(90);
    expect(cfg.webhookDeliveryRetentionDays).toBe(90);
  });
});
