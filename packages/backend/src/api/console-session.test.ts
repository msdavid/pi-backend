/**
 * Unit tests for the console-session TTL resolution (console spec §4.6):
 * per-mode sliding-TTL defaults (solo 30 d, team 7 d, saas 24 h — the same
 * mode `GET /console/config` reports, including derivation from onboarding)
 * and the `CONSOLE_SESSION_TTL` override, which wins over every mode.
 */

import { describe, expect, it } from "vitest";
import { resolveConsoleSessionTtlSeconds } from "./console-session.js";

describe("resolveConsoleSessionTtlSeconds (console spec §4.6)", () => {
  it("per-mode defaults: solo 30 d, team 7 d, saas 24 h", () => {
    expect(
      resolveConsoleSessionTtlSeconds({
        consoleMode: "solo",
        onboardingEnabled: false,
        consoleSessionTtl: undefined,
      }),
    ).toBe(30 * 24 * 60 * 60);
    expect(
      resolveConsoleSessionTtlSeconds({
        consoleMode: "team",
        onboardingEnabled: false,
        consoleSessionTtl: undefined,
      }),
    ).toBe(7 * 24 * 60 * 60);
    expect(
      resolveConsoleSessionTtlSeconds({
        consoleMode: "saas",
        onboardingEnabled: false,
        consoleSessionTtl: undefined,
      }),
    ).toBe(24 * 60 * 60);
  });

  it("with CONSOLE_MODE unset, the mode is derived exactly as GET /console/config derives it", () => {
    // Onboarding on → saas → 24 h; off → solo → 30 d.
    expect(
      resolveConsoleSessionTtlSeconds({
        consoleMode: undefined,
        onboardingEnabled: true,
        consoleSessionTtl: undefined,
      }),
    ).toBe(24 * 60 * 60);
    expect(
      resolveConsoleSessionTtlSeconds({
        consoleMode: undefined,
        onboardingEnabled: false,
        consoleSessionTtl: undefined,
      }),
    ).toBe(30 * 24 * 60 * 60);
  });

  it("CONSOLE_SESSION_TTL overrides the default for every mode", () => {
    for (const consoleMode of ["solo", "team", "saas"] as const) {
      expect(
        resolveConsoleSessionTtlSeconds({
          consoleMode,
          onboardingEnabled: false,
          consoleSessionTtl: 3600,
        }),
      ).toBe(3600);
    }
  });
});
