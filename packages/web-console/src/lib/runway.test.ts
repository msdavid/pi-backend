/**
 * Runway projection (WP-C5.4; §11.8 "lasts ~N days"). The projection divides
 * API money by a window to yield DAYS — the one sanctioned derivation (§11.9);
 * it never produces a dollar figure.
 */
import { describe, expect, it } from "vitest";
import type { TenantUsageResponse } from "@pi-managed/contracts";

import { estimateRunwayDays } from "./runway.js";

function usage(
  data: Array<{ usdCost: number }>,
  from = "2026-07-01T00:00:00.000Z",
  to = "2026-07-03T00:00:00.000Z",
): TenantUsageResponse {
  return {
    granularity: "day",
    from,
    to,
    data: data.map((d) => ({
      bucketStart: from,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      usdCost: d.usdCost,
    })),
  };
}

describe("estimateRunwayDays", () => {
  it("projects days from balance and average daily spend over the window", () => {
    // $10 / ($1/day averaged over a 2-day window) = 10 days.
    expect(
      estimateRunwayDays(10, usage([{ usdCost: 1 }, { usdCost: 1 }])),
    ).toBe(10);
  });

  it("counts omitted (zero-spend) days via the window, not just present buckets", () => {
    // One $2 bucket over a 2-day window ⇒ $1/day ⇒ $10 lasts 10 days (not 5).
    expect(estimateRunwayDays(10, usage([{ usdCost: 2 }]))).toBe(10);
  });

  it("returns null when there is no balance", () => {
    expect(estimateRunwayDays(0, usage([{ usdCost: 1 }]))).toBeNull();
    expect(estimateRunwayDays(-1, usage([{ usdCost: 1 }]))).toBeNull();
  });

  it("returns null when burn is not yet measurable", () => {
    expect(estimateRunwayDays(10, usage([]))).toBeNull();
    expect(estimateRunwayDays(10, usage([{ usdCost: 0 }]))).toBeNull();
    expect(estimateRunwayDays(10, undefined)).toBeNull();
  });
});
