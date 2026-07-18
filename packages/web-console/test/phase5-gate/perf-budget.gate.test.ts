// @vitest-environment node
/**
 * Phase-5 gate — console-spec §12.1, phase-5 addendum. The saas billing surface
 * must not eat the ≤ 200 KB gz initial-JS headroom (`scripts/check-budget.mjs`,
 * enforced on every fresh build by the phase-1 gate). The new
 * `/settings/billing` route is its own lazy chunk, and its money components stay
 * OUT of the initial JS set — a solo/team user never downloads billing code.
 *
 * Chunk helpers shared with the phase-1..4 pins.
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  distDir,
  distJsAssetNames,
  ensureConsoleDist,
  initialJsUrls,
  readText,
} from "../phase1-gate/helpers.js";

/** Copy unique to the Billing screen's no-adapter degradation (§11.8). */
const BILLING_MARKER = "Top-ups aren't available on this deployment";

describe("§12.1 (phase 5) — the billing surface stays lazy", () => {
  let assetNames: string[];
  let initialUrls: string[];

  beforeAll(() => {
    ensureConsoleDist();
    assetNames = distJsAssetNames();
    initialUrls = initialJsUrls();
  });

  it("billing.lazy is its own chunk, out of the initial JS set", () => {
    expect(
      assetNames.some((name) => name.startsWith("billing.lazy-")),
      "expected a billing.lazy-<hash>.js chunk — did the route stop being lazy?",
    ).toBe(true);
    for (const url of initialUrls) {
      expect(
        url.includes("billing.lazy-"),
        `billing.lazy is statically referenced by index.html (${url})`,
      ).toBe(false);
    }
  });

  it("the billing money surface is never in an initial chunk", () => {
    const chunksWithMarker = assetNames.filter((name) =>
      readText(join(distDir, "assets", name)).includes(BILLING_MARKER),
    );
    expect(chunksWithMarker.length).toBeGreaterThan(0);
    const initialNames = new Set(initialUrls.map((url) => url.split("/").pop()!));
    for (const name of chunksWithMarker) {
      expect(
        initialNames.has(name),
        `${name} carries the billing surface AND is initial JS — ` +
          "saas billing must stay behind the lazy /settings/billing route",
      ).toBe(false);
    }
  });
});
