// @vitest-environment node
/**
 * Phase-4 gate — console-spec §12.1, phase-4 addendum. Phase 4 deliberately
 * added NO new routes: the Conversation tab + composer live inside the
 * existing `/sessions/$sessionId` screen, whose route module is the
 * `session-detail.lazy` chunk. What this pin protects is therefore not a new
 * lazy chunk but the placement of the phase-4 surface:
 *
 *  - `session-detail.lazy` (the chunk that now carries the conversation
 *    surface) is still emitted as a lazy chunk and stays OUT of the initial
 *    JS set `scripts/check-budget.mjs` meters (≤ 200 KB gz — enforced by
 *    every fresh `pnpm build`, which the phase-1 gate runs);
 *  - the conversation surface itself is IN that lazy chunk and NOT in any
 *    initial chunk, pinned by its distinctive §10.4 hand-back copy — a
 *    refactor that folded the composer into the entry would eat the §12.1
 *    headroom without failing the chunk-name pin alone.
 *
 * Chunk helpers shared with the phase-1/-2/-3 pins
 * (`test/phase1-gate/helpers.ts`).
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

/** §10.4 hand-back copy — unique to the conversation composer surface. */
const CONVERSATION_MARKER = "Continue in Pi instead:";

describe("§12.1 (phase 4) — the conversation surface stays lazy", () => {
  let assetNames: string[];
  let initialUrls: string[];

  beforeAll(() => {
    // The phase-1/-2 gates force a FRESH build and assert the budget on it;
    // reuse that dist/ (or build it) instead of building again mid-run.
    ensureConsoleDist();
    assetNames = distJsAssetNames();
    initialUrls = initialJsUrls();
  });

  it("session-detail.lazy is still its own chunk, out of the initial JS set", () => {
    expect(
      assetNames.some((name) => name.startsWith("session-detail.lazy-")),
      "expected a session-detail.lazy-<hash>.js chunk — did the route stop being lazy?",
    ).toBe(true);
    expect(initialUrls.length).toBeGreaterThan(0);
    for (const url of initialUrls) {
      expect(
        url.includes("session-detail.lazy-"),
        `session-detail.lazy is statically referenced by index.html (${url})`,
      ).toBe(false);
    }
  });

  it("the composer ships in the session-detail chunk graph, not in any initial chunk", () => {
    const chunksWithMarker = assetNames.filter((name) =>
      readText(join(distDir, "assets", name)).includes(CONVERSATION_MARKER),
    );
    // The marker must exist somewhere (the copy is a normative §10.4 item)…
    expect(chunksWithMarker.length).toBeGreaterThan(0);
    // …and never inside a chunk the entry loads eagerly.
    const initialNames = new Set(
      initialUrls.map((url) => url.split("/").pop()!),
    );
    for (const name of chunksWithMarker) {
      expect(
        initialNames.has(name),
        `${name} carries the conversation composer AND is initial JS — ` +
          "the phase-4 surface must stay behind the lazy session-detail route",
      ).toBe(false);
    }
  });
});
