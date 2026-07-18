// @vitest-environment node
/**
 * Phase-2 gate — console-spec §13 item §12.1, phase-2 addendum: the budget
 * stays green WITH every phase-2 surface in the bundle, and the phase-2
 * screens are lazy route chunks (route-level code splitting) — none of them
 * may join the initial JS set that `scripts/check-budget.mjs` meters. The
 * phase-1 gate already asserts the budget on a fresh build; this file pins
 * that the phase-2 screens stay OUT of what blocks first paint, so a future
 * refactor can't silently fold a screen into the entry and eat the headroom.
 * The phase-3 counterpart (`test/phase3-gate/perf-budget.gate.test.ts`)
 * pins the same for the phase-3 screens, sharing this file's helpers.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildConsole,
  distJsAssetNames,
  initialJsUrls,
} from "../phase1-gate/helpers.js";

/**
 * Every phase-2 screen, by its route module's chunk-name prefix (Vite names
 * lazy chunks `<module>.lazy-<hash>.js`). Session detail carries the phase-2
 * tabs (live Trace, Tree, Outputs) and the W4 interaction panel.
 */
const PHASE2_LAZY_CHUNKS = [
  "session-detail.lazy",
  "jobs.lazy",
  "job-detail.lazy",
  "resources.lazy",
  "memory-stores.lazy",
  "memory-store-detail.lazy",
];

describe("§12.1 (phase 2) — budget green, phase-2 screens are lazy chunks", () => {
  let buildOutput: string;
  let assetNames: string[];
  let initialUrls: string[];

  beforeAll(() => {
    // Always a FRESH production build — same rule as the phase-1 gate.
    buildOutput = buildConsole();
    assetNames = distJsAssetNames();
    initialUrls = initialJsUrls();
  });

  it("the budget check passed with all phase-2 chunks built", () => {
    expect(buildOutput).toContain("check-budget: OK");
  });

  it("every phase-2 screen is emitted as its own lazy chunk", () => {
    for (const chunk of PHASE2_LAZY_CHUNKS) {
      expect(
        assetNames.some((name) => name.startsWith(`${chunk}-`)),
        `expected a ${chunk}-<hash>.js chunk in dist/ — did the route stop being lazy?`,
      ).toBe(true);
    }
  });

  it("no phase-2 screen is part of the initial JS set", () => {
    expect(initialUrls.length).toBeGreaterThan(0);
    for (const url of initialUrls) {
      for (const chunk of PHASE2_LAZY_CHUNKS) {
        expect(
          url.includes(`${chunk}-`),
          `${chunk} is statically referenced by index.html (${url}) — it would count against the §12.1 budget`,
        ).toBe(false);
      }
    }
  });
});
