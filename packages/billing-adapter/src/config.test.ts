import { describe, expect, it } from "vitest";
import { loadAdapterConfig, AdapterConfigError, DEFAULT_MAX_CONSECUTIVE_FAILURES } from "./config.js";

/** A complete, obviously test-only env (no real credentials). */
const FULL_ENV = {
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  PI_BACKEND_URL: "https://api.test",
  BILLING_PROVISION_TOKEN: "test-only-provision-secret",
  BILLING_CHECKOUT_SUCCESS_URL: "https://console.test/ok",
  BILLING_CHECKOUT_CANCEL_URL: "https://console.test/cancel",
  BILLING_PORTAL_RETURN_URL: "https://console.test/billing",
};

describe("loadAdapterConfig (fail-closed)", () => {
  it("loads a complete env with the default failure threshold", () => {
    const config = loadAdapterConfig(FULL_ENV);
    expect(config.stripeSecretKey).toBe("sk_test_dummy");
    expect(config.maxConsecutiveFailures).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES);
  });

  it.each([
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "PI_BACKEND_URL",
    "BILLING_PROVISION_TOKEN",
    "BILLING_CHECKOUT_SUCCESS_URL",
    "BILLING_CHECKOUT_CANCEL_URL",
    "BILLING_PORTAL_RETURN_URL",
  ])("fails closed when %s is missing", (key) => {
    const env: Record<string, string | undefined> = { ...FULL_ENV, [key]: undefined };
    expect(() => loadAdapterConfig(env)).toThrow(AdapterConfigError);
  });

  it("fails closed when a required value is blank", () => {
    expect(() => loadAdapterConfig({ ...FULL_ENV, STRIPE_SECRET_KEY: "   " })).toThrow(AdapterConfigError);
  });

  it("rejects a non-positive AUTO_CHARGE_MAX_FAILURES", () => {
    expect(() => loadAdapterConfig({ ...FULL_ENV, AUTO_CHARGE_MAX_FAILURES: "0" })).toThrow(AdapterConfigError);
  });
});
