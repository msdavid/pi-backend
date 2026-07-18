// @vitest-environment node
/**
 * Phase-3 gate — console-spec §13 item §12.1, phase-3 addendum: every
 * phase-3 screen stays a lazy route chunk, OUT of the initial JS set that
 * `scripts/check-budget.mjs` meters. Mirrors the phase-2 pin
 * (`test/phase2-gate/perf-budget.gate.test.ts`) via the shared chunk
 * helpers in `test/phase1-gate/helpers.ts`, so a refactor can't silently
 * fold an admin screen into the entry and eat the §12.1 headroom.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  distJsAssetNames,
  ensureConsoleDist,
  initialJsUrls,
} from "../phase1-gate/helpers.js";

/**
 * Every phase-3 screen, by its route module's chunk-name prefix (Vite names
 * lazy chunks `<module>.lazy-<hash>.js`).
 */
const PHASE3_LAZY_CHUNKS = [
  "agents.lazy",
  "agent-detail.lazy",
  "environments.lazy",
  "environment-detail.lazy",
  "vaults.lazy",
  "vault-detail.lazy",
  "api-keys.lazy",
  "webhooks.lazy",
  "tenant.lazy",
  "health.lazy",
  "files.lazy",
  "skills.lazy",
  "signup.lazy",
];

describe("§12.1 (phase 3) — phase-3 screens are lazy chunks, not initial JS", () => {
  let assetNames: string[];
  let initialUrls: string[];

  beforeAll(() => {
    // The phase-1/-2 gates already force a FRESH build (and assert the
    // budget on it); reuse that dist/ — or build it — instead of building a
    // third time in the same gate run.
    ensureConsoleDist();
    assetNames = distJsAssetNames();
    initialUrls = initialJsUrls();
  });

  it("every phase-3 screen is emitted as its own lazy chunk", () => {
    for (const chunk of PHASE3_LAZY_CHUNKS) {
      expect(
        assetNames.some((name) => name.startsWith(`${chunk}-`)),
        `expected a ${chunk}-<hash>.js chunk in dist/ — did the route stop being lazy?`,
      ).toBe(true);
    }
  });

  it("no phase-3 screen is part of the initial JS set", () => {
    expect(initialUrls.length).toBeGreaterThan(0);
    for (const url of initialUrls) {
      for (const chunk of PHASE3_LAZY_CHUNKS) {
        expect(
          url.includes(`${chunk}-`),
          `${chunk} is statically referenced by index.html (${url}) — it would count against the §12.1 budget`,
        ).toBe(false);
      }
    }
  });
});
