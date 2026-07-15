/**
 * Tier-config domain barrel (WP-5.5): consolidated per-tier limit surface.
 */

export {
  TierConfigSchema,
  TIER_NAMES,
  DEFAULT_TIER_CONFIGS,
  type TierConfig,
  type TierName,
} from "./config.js";
export {
  getTierConfig,
  getAllTierConfigs,
  normalizeTierName,
  type LoadTierConfigOptions,
  type EnvLike as TierConfigEnvLike,
} from "./loader.js";
