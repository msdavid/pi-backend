// @vitest-environment node
/**
 * Phase-1 gate — console-spec §13 item §12.1: performance budgets are
 * CI-enforced. Runs the REAL package build (`vite build` +
 * `scripts/check-budget.mjs`) and asserts the budget check passed: initial
 * JS (entry chunk + statically imported chunks, read off `dist/index.html`
 * the way a browser would) ≤ 200 KB gzipped, every chunk under the
 * `/console/` base. Route-level code splitting keeps lazy chunks out of the
 * initial set — the budget script only counts what blocks first paint.
 */
import { describe, expect, it } from "vitest";

import { buildConsole } from "./helpers.js";

describe("§12.1 — perf budget on a fresh build", () => {
  it("vite build + check-budget pass (≤ 200 KB gzipped initial JS)", () => {
    // Throws (failing the gate) if the build or the budget check exits
    // non-zero; the explicit assertion pins that the budget checker actually
    // ran and reported success.
    const output = buildConsole();
    expect(output).toContain("check-budget: OK");
  });
});
