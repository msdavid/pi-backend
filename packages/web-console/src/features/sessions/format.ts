/**
 * Display formatting for the sessions read surface (WP-C1.7). Rendering
 * conventions carried over from the v1 console (retired in WP-C1.8): timestamps as
 * `YYYY-MM-DD HH:MM:SSZ`, USD to four decimals.
 */
import type { SessionUsage } from "@pi-managed/contracts";

/** RFC 3339 → `2026-07-13 12:00:00Z`; `—` when absent, verbatim if unparsable. */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").replace(/\..*/, "Z");
}

/**
 * The Cost column value (WP-C2.2): the WP-C2.0 `usage.usdCost` rollup the
 * list/detail payloads now carry. `usdCost` is schema-optional (additive
 * field) so a payload without it renders `—`, never a fabricated $0. Token
 * counters stay on the Usage tab (`./usage-tab.tsx`).
 */
export function formatSessionCost(usage: SessionUsage | undefined): string {
  if (!usage || usage.usdCost === undefined) return "—";
  return formatUsd(usage.usdCost);
}

/** USD cost, four decimals (v1 parity — sub-cent spend must stay visible). */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
