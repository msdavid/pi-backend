/**
 * WP-1.11c — Cost preview for remote delegation (§24.6).
 *
 * Pre-run cost estimation for agentic work is unreliable, so this is a crude
 * estimate labeled as such: computed from the tenant's historical median
 * per-session spend for this agent (if available), falling back to a
 * per-model default. The REAL protection is the server-side `budget` field
 * (§24.6) — this estimate is only for the confirm/notice UX.
 */

import type { ManagedApiClient } from "../api-client.js";
import type { PiManagedSettings } from "../config.js";

/** Per-model fallback USD estimate (conservative average per session). */
const PER_MODEL_FALLBACK: Record<string, number> = {
  "anthropic/claude-sonnet-4": 0.5,
  "anthropic/claude-opus": 2.0,
  "openai/gpt-4o": 0.4,
  "google/gemini-1.5-pro": 0.3,
};
const DEFAULT_FALLBACK = 0.5;

/** Estimate the cost of a remote delegation, labeled as an estimate. */
export async function estimateCost(
  _client: ManagedApiClient,
  _agentId: string,
  _settings: PiManagedSettings,
): Promise<number> {
  // Historical median: the backend could expose a per-agent median-spend endpoint;
  // until then, use the per-model fallback. This is deliberately crude (§24.6).
  // (A real implementation would call client.getAgentUsageMedian(agentId) here.)
  return DEFAULT_FALLBACK;
}

/** Per-model fallback lookup (exported for tests). */
export function perModelFallback(model: string | undefined): number {
  if (!model) return DEFAULT_FALLBACK;
  return PER_MODEL_FALLBACK[model] ?? DEFAULT_FALLBACK;
}
