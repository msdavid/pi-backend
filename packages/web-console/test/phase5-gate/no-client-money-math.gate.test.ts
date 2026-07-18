/**
 * Phase-5 gate — §11.9: "the console MUST NOT compute money client-side; it
 * displays what the API reports." Two independent pins:
 *
 *  1. RUNTIME round-trip: a sentinel `balanceUsd` the API reports renders
 *     byte-identical in the Billing screen — no rounding, no re-derivation.
 *  2. STATIC scan: the money-DISPLAY source files contain no money arithmetic
 *     — no `* / 1_000_000`, no `MICROS_PER_USD`, no `*`/`/` applied to a `*Usd`
 *     or `*Micros` field. (The runway day-count projection in `src/lib/runway.ts`
 *     is the one sanctioned derivation and is deliberately NOT a display file.)
 */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TenantBillingState } from "@pi-managed/contracts";

import { readText, stripComments } from "../phase1-gate/helpers.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)
import { MONEY_DISPLAY_FILES, saasBillingApi } from "./helpers.js";

// A distinctive value the console must show exactly as `$42.4242` — any client-
// side arithmetic (dividing micros, re-rounding) would change it.
const SENTINEL: TenantBillingState = {
  lifecycle: "active",
  balanceMicros: 42_424_200,
  balanceUsd: 42.4242,
  verified: true,
  verificationRequired: false,
};

describe("§11.9 — money renders verbatim from the API", () => {
  it("a sentinel balance round-trips unmodified through the Billing screen", async () => {
    const api = saasBillingApi({ seed: (a) => (a.billingState = SENTINEL) });
    renderConsole(api, "/console/settings/billing");
    expect(await screen.findByText("$42.4242")).toBeInTheDocument();
  });

  it("the same sentinel round-trips through the Home balance strip", async () => {
    // Home's balance element is a second money-display surface (§11.8): the same
    // value must render byte-identical there too — catches money math added to
    // the Home strip, not just the Billing screen.
    const api = saasBillingApi({ seed: (a) => (a.billingState = SENTINEL) });
    renderConsole(api, "/console/");
    const region = await screen.findByRole("region", { name: "Balance" });
    expect(within(region).getByText("$42.4242")).toBeInTheDocument();
  });
});

describe("§11.9 — no money arithmetic in the money-display components", () => {
  const MONEY_FIELD_THEN_OP = /\b\w*(?:Usd|Micros)\b\s*[*/]/;
  const OP_THEN_MONEY_FIELD = /[*/]\s*\b\w*(?:Usd|Micros)\b/;

  for (const file of MONEY_DISPLAY_FILES) {
    it(`${file.split("/").slice(-2).join("/")} does no client-side money math`, () => {
      const code = stripComments(readText(file));
      expect(code, "micro-conversion constant present").not.toMatch(/1_000_000|1000000/);
      expect(code, "MICROS_PER_USD referenced").not.toContain("MICROS_PER_USD");
      expect(
        MONEY_FIELD_THEN_OP.test(code),
        "a *Usd/*Micros field is multiplied or divided",
      ).toBe(false);
      expect(
        OP_THEN_MONEY_FIELD.test(code),
        "a *Usd/*Micros field is the divisor/multiplicand",
      ).toBe(false);
    });
  }
});
