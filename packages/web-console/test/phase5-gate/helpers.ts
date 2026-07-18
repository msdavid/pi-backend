/**
 * Shared helpers for the phase-5 conformance gate (console-spec §11, W15).
 */
import { join } from "node:path";

import { srcDir } from "../phase1-gate/helpers.js";
import {
  FakeConsoleApi,
  makeAutoCharge,
  makeBillingState,
  makeTenantUsage,
} from "../../src/test/fake-console-api.js";

/**
 * A signed-in saas admin with billing enrolled. `withAdapter` decides whether
 * the money-controls tier (auto-charge + checkout/portal) is present — the
 * single §11.8 degradation switch.
 */
export function saasBillingApi(opts: {
  withAdapter?: boolean;
  seed?: (api: FakeConsoleApi) => void;
} = {}): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = { mode: "saas", onboardingEnabled: true };
  api.billingState = makeBillingState();
  api.addLedgerEntry({ id: "led_01GRANT", kind: "grant", source: "trial" });
  api.tenantUsage = makeTenantUsage({
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-03T00:00:00.000Z",
    data: [
      dayBucket("2026-07-01T00:00:00.000Z", 0.5),
      dayBucket("2026-07-02T00:00:00.000Z", 0.5),
    ],
  });
  if (opts.withAdapter) api.autoChargeConfig = makeAutoCharge();
  opts.seed?.(api);
  return api;
}

function dayBucket(bucketStart: string, usdCost: number) {
  return {
    bucketStart,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    usdCost,
  };
}

/**
 * The money-DISPLAY source files (§11.9): these render balances/amounts and
 * MUST NOT do money arithmetic — they format what the API reports. The runway
 * projection (`src/lib/runway.ts`) is deliberately NOT here: it derives a day
 * count, not money, and is the one sanctioned place division on a money figure
 * is allowed.
 */
export const MONEY_DISPLAY_FILES = [
  join(srcDir, "features/settings/billing.lazy.tsx"),
  join(srcDir, "features/settings/auto-charge-form.tsx"),
  join(srcDir, "features/settings/top-up-dialog.tsx"),
  join(srcDir, "features/billing/widgets.tsx"),
  // The saas Home balance strip renders `balanceUsd` too — the same §11.9 rule
  // applies, so it is scanned for client-side money math like every other
  // money-display surface.
  join(srcDir, "features/billing/home-billing.tsx"),
];
