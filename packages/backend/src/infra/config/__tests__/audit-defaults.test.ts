/**
 * Audit-remediation config defaults (SEC-13, SEC-4, PERF-1, ROB-13).
 *
 * These knobs are security-/robustness-sensitive, so their DEFAULTS are the contract:
 * onboarding closed, the multi-host channel secure, the DB pool bounded, and an instance
 * lease present for boot recovery.
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "../index.js";

describe("audit-remediation config defaults", () => {
  const cfg = loadConfig({ env: {}, file: {} });

  it("disables onboarding by default (SEC-13)", () => {
    expect(cfg.onboardingEnabled).toBe(false);
  });

  it("honors ONBOARDING_ENABLED=true for the SaaS shape (SEC-13)", () => {
    const saas = loadConfig({ env: { ONBOARDING_ENABLED: "true" }, file: {} });
    expect(saas.onboardingEnabled).toBe(true);
  });

  it("keeps the insecure multi-host transport off by default (SEC-4)", () => {
    expect(cfg.allowInsecureHostAgent).toBe(false);
  });

  it("bounds the DB pool size and timeouts (PERF-1)", () => {
    expect(cfg.dbPoolMax).toBe(25);
    expect(cfg.dbConnectionTimeoutMs).toBeGreaterThan(0);
    expect(cfg.dbStatementTimeoutMs).toBeGreaterThan(0);
  });

  it("defaults an instance-ownership lease window and no fixed instance id (ROB-13)", () => {
    expect(cfg.instanceLeaseMs).toBe(300_000);
    expect(cfg.instanceId).toBeUndefined();
  });
});
