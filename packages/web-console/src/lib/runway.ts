/**
 * Balance runway projection (WP-C5.4; console-spec §11.8, `console.md` §2a —
 * "at the current rate this lasts ~N days").
 *
 * ── §11.9 boundary ──────────────────────────────────────────────────────────
 * The console MUST NOT compute money client-side; it displays what `/v1`
 * reports. This module is the ONE sanctioned exception, and it does not cross
 * the line: it takes money figures the API already computed (`balanceUsd`, the
 * per-day `usdCost` buckets) and produces a **day count** — a presentation
 * projection, not a dollar amount. No output of this module is money, and it is
 * never used to render a balance, a price, or a spend figure. The per-day
 * spend the sparkline shows is the API's `usdCost` verbatim; only the *runway*
 * (a number of days) is derived here.
 */

import type { TenantUsageResponse } from "@pi-managed/contracts";

const MS_PER_DAY = 86_400_000;

/**
 * Estimate how many whole days the balance lasts at the recent average daily
 * spend. Returns `null` when it cannot be projected — no balance, or no
 * measurable burn yet (a zero/negative rate would divide to Infinity, which is
 * not a useful "lasts ~N days"). The window length comes from the usage
 * series' own `[from, to)` so omitted (zero-spend) days are counted, not
 * dropped — averaging over present buckets alone would overstate the burn.
 */
export function estimateRunwayDays(
  balanceUsd: number,
  usage: TenantUsageResponse | undefined,
): number | null {
  if (!usage || balanceUsd <= 0) return null;
  const windowDays = usageWindowDays(usage);
  if (windowDays <= 0) return null;
  const totalSpend = usage.data.reduce((sum, bucket) => sum + bucket.usdCost, 0);
  const perDay = totalSpend / windowDays;
  if (perDay <= 0) return null;
  return Math.floor(balanceUsd / perDay);
}

/** The usage window `[from, to)` length in days (≥ 0; 0 when unparsable). */
function usageWindowDays(usage: TenantUsageResponse): number {
  const from = Date.parse(usage.from);
  const to = Date.parse(usage.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return 0;
  return (to - from) / MS_PER_DAY;
}
