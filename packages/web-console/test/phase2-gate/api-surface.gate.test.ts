// @vitest-environment node
/**
 * Phase-2 gate — console-spec §1.2, phase-2 addendum: the live-streaming
 * surface stays inside the endpoint allowlist. The phase-1 gate
 * (`test/phase1-gate/api-surface.gate.test.ts`) scans every production
 * module and still runs unchanged; a scan can only protect endpoints it
 * actually SEES, so this file adds the positive control for the phase-2
 * transport: the SSE client's endpoint literals (`…/stream`, and its
 * degraded-mode `…/entries` polling) are extractable by the same
 * literal-scan the allowlist uses, and both are `/v1/*`-shaped. If someone
 * rewrites `src/api/stream.ts` to assemble its URLs in a way the scan can't
 * see, this gate fails instead of the allowlist passing vacuously.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  pkgRoot,
  readText,
  stripComments,
} from "../phase1-gate/helpers.js";

/** The same endpoint-literal extraction the §1.2 allowlist scan performs. */
function endpointLiterals(code: string): string[] {
  return [...stripComments(code).matchAll(
    /(["'`])(\/(?:v1|console)(?:\/[^"'`\n]*)?)\1/g,
  )].map((m) => m[2]!);
}

describe("§1.2 (phase 2) — the stream transport is visible to, and inside, the allowlist", () => {
  const streamSource = readText(join(pkgRoot, "src/api/stream.ts"));
  const literals = endpointLiterals(streamSource);

  it("the scan extracts the SSE endpoint literal from src/api/stream.ts", () => {
    expect(
      literals.filter((lit) => /^\/v1\/sessions\/.*\/stream$/.test(lit)),
    ).toHaveLength(1);
  });

  it("the scan extracts the polling-fallback entries literal too", () => {
    expect(
      literals.filter((lit) => /^\/v1\/sessions\/.*\/entries$/.test(lit)),
    ).toHaveLength(1);
  });

  it("every endpoint literal in the stream transport is /v1/* (parity rule)", () => {
    expect(literals.length).toBeGreaterThanOrEqual(2);
    for (const lit of literals) {
      expect(lit, `non-/v1 endpoint in stream.ts: ${lit}`).toMatch(/^\/v1\//);
    }
  });
});
