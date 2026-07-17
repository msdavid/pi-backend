/**
 * Tier config loader (WP-5.5).
 *
 * Resolves a {@link TierConfig} for a tier name with the same precedence as the
 * service config (`infra/config/index.ts`): env > file > seeded defaults.
 *
 *  - **File**: a JSON document at `TIER_CONFIG_FILE` (or `Config.tierConfigFile`)
 *    of shape `{ tiers: { free: { maxJobs: 7, … }, pro: { … } } }` — partial
 *    per-tier objects; omitted fields keep the seeded default.
 *  - **Env**: `TIER_CONFIG_FREE='{"maxJobs":7}'` (one partial-JSON object per
 *    tier) — mirrors the established `QUOTA_PLAN_*` override convention in
 *    `quota/tiers.ts`.
 *
 * Malformed file/JSON is ignored (a typo cannot brick boot), matching
 * `quota/tiers.ts`. Unknown tier names fall back to the `default` tier.
 *
 * Authority: spec §6.3/§12.4/§17.3, `docs/db-schema.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_TIER_CONFIGS,
  TIER_NAMES,
  TierConfigSchema,
  type TierConfig,
  type TierName,
} from "./config.js";

/** Env override prefix; `TIER_CONFIG_FREE`, `TIER_CONFIG_PRO`, … */
const ENV_OVERRIDE_PREFIX = "TIER_CONFIG_";

/** Shape of the optional JSON config file. */
interface TierConfigFile {
  tiers?: Partial<Record<TierName, Partial<TierConfig>>>;
}

/** Env-like map (string | undefined). Tests inject a fake env. */
export type EnvLike = Record<string, string | undefined>;

export interface LoadTierConfigOptions {
  /** Env map (defaults to `process.env`). */
  env?: EnvLike;
  /**
   * Parsed config file object. If omitted, read from
   * `env.TIER_CONFIG_FILE` (or `Config.tierConfigFile`). Tests inject a
   * literal object to avoid filesystem fixtures.
   */
  file?: TierConfigFile;
  /** Path to the JSON config file (defaults to `env.TIER_CONFIG_FILE`). */
  filePath?: string;
}

/** Read the optional JSON config file; `{}` if unset/missing/empty/malformed. */
function readConfigFile(path?: string): TierConfigFile {
  if (!path || !existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TierConfigFile;
    }
  } catch {
    // Ignore malformed file; seeded defaults apply.
  }
  return {};
}

/** Parse the per-tier env overrides (`TIER_CONFIG_<TIER>` partial JSON). */
function parseEnvOverrides(
  env: EnvLike,
): Partial<Record<TierName, Partial<TierConfig>>> {
  const out: Partial<Record<TierName, Partial<TierConfig>>> = {};
  for (const name of TIER_NAMES) {
    const raw = env[`${ENV_OVERRIDE_PREFIX}${name.toUpperCase()}`];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out[name] = parsed as Partial<TierConfig>;
      }
    } catch {
      // Ignore malformed overrides; seeded defaults apply.
    }
  }
  return out;
}

const KNOWN_TIERS = new Set<string>(TIER_NAMES);

/** Normalize a (possibly null/unknown) tier name to a known {@link TierName}. */
export function normalizeTierName(name: string | null | undefined): TierName {
  const norm = (name ?? "default").toLowerCase();
  return KNOWN_TIERS.has(norm) ? (norm as TierName) : "default";
}

/**
 * Resolve the {@link TierConfig} for a tier name.
 *
 * Precedence for each field: env override > file override > seeded default.
 * Unknown/null names resolve to the `default` tier. Validation runs through
 * {@link TierConfigSchema} (fills schema defaults for any still-missing field,
 * e.g. `maxVaultCredentials`→20 per §12.4 when a tier is entirely absent).
 *
 * Repeated calls are cheap: each call merges + validates afresh, so runtime
 * env/file mutations between calls are honoured (the boot path resolves once).
 */
export function getTierConfig(
  name: string | null | undefined,
  opts: LoadTierConfigOptions = {},
): TierConfig {
  const env = opts.env ?? process.env;
  const file =
    opts.file ?? readConfigFile(opts.filePath ?? env.TIER_CONFIG_FILE);
  const tier = normalizeTierName(name);

  const base = DEFAULT_TIER_CONFIGS[tier] ?? DEFAULT_TIER_CONFIGS.default;
  const fileOverride = file.tiers?.[tier] ?? {};
  const envOverride = parseEnvOverrides(env)[tier] ?? {};

  const merged = { ...base, ...fileOverride, ...envOverride };
  const parsed = TierConfigSchema.safeParse(merged);
  // `merged` is built from already-valid defaults + partial overrides; a
  // safeParse failure here would only come from a bad override type, which we
  // already filtered. Fall back to the seeded default defensively.
  return parsed.success ? parsed.data : base;
}

/**
 * Resolve every tier at once (handy for seeding/inspection). The `default`
 * tier is included. Unknown tiers are not present — callers use
 * {@link getTierConfig} for the unknown→default fallback.
 */
export function getAllTierConfigs(
  opts: LoadTierConfigOptions = {},
): Record<TierName, TierConfig> {
  const out = {} as Record<TierName, TierConfig>;
  for (const name of TIER_NAMES) {
    out[name] = getTierConfig(name, opts);
  }
  return out;
}
