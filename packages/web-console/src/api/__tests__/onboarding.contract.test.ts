// @vitest-environment node
/**
 * Onboarding signup contract tests (WP-C3.7; console-spec §9.6, journey W8)
 * — the console fetchers against the REAL in-process backend booted with
 * `ONBOARDING_ENABLED=true` (the harness's `loadConfig` env is REPLACED, not
 * merged, so the flag rides an explicit config through the `options.app`
 * seam; mode then derives to `saas`, §3.2).
 *
 * Covers: public signup issues the tenant + admin key exactly once; the key
 * signs in through the real console-session flow; the first-run progress
 * probe flips step by step as the real resources are created; a repeat
 * sign-up reuses the tenant and OMITS the key (no re-issuance to a public
 * caller — R0.3). The disabled-path `403` is covered by the backend's own
 * `api/__tests__/onboarding.test.ts` (a second container boot here would buy
 * nothing).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@pi-managed/backend";
import { ConsoleApiClient } from "../client.js";
import { fetchConsoleConfig, fetchConsoleSession } from "../console.js";
import { fetchFirstRunProgress, signup } from "../onboarding.js";
import type { SignupResponse } from "../onboarding.js";
import { addCredential, createVault } from "../vaults.js";
import { seedSession, signInCookie } from "./collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("onboarding signup contract suite");

const ADMIN_EMAIL = "admin@signup-contract.test";

describe.skipIf(!RUNTIME)("onboarding signup ↔ real backend (ONBOARDING_ENABLED)", () => {
  let backend: TestBackend;
  /** Unauthenticated client — signup is a public endpoint. */
  let anon: ConsoleApiClient;
  /** Client riding the console-session cookie of the SIGNUP key. */
  let cookieClient: ConsoleApiClient;
  let first: SignupResponse;

  beforeAll(async () => {
    backend = await startTestBackend({
      app: {
        config: loadConfig({
          env: {
            LOG_LEVEL: "error",
            ONBOARDING_ENABLED: "true",
            // Same escape hatch the harness sets on process.env — this env
            // object replaces process.env for config parsing.
            ALLOW_EPHEMERAL_VAULT_KEY: "true",
          },
        }),
      },
    });
    anon = new ConsoleApiClient({ baseUrl: backend.baseUrl });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("GET /console/config derives saas mode with onboarding enabled (§3.2)", async () => {
    const config = await fetchConsoleConfig(anon);
    expect(config).toEqual({ mode: "saas", onboardingEnabled: true });
  });

  it("public signup creates the tenant and issues the admin key once (§9.6)", async () => {
    first = await signup(
      { tenantName: "Signup Contract Tenant", adminEmail: ADMIN_EMAIL },
      anon,
    );
    expect(first.tenantId).toMatch(/^tnt_/);
    expect(first.apiKey).toBeDefined();
    expect(first.apiKey!.key).not.toBe("");
    expect(first.apiKey!.scopes).toContain("admin");
    expect(first.installCommand).toContain("pi install");
    expect(first.extensionConfig.backendUrl).toBe(first.backendUrl);
  });

  it("the signup key signs in via the real console-session flow (W8)", async () => {
    const cookie = await signInCookie(backend.baseUrl, first.apiKey!.key);
    cookieClient = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: cookie },
    });
    const info = await fetchConsoleSession(cookieClient);
    expect(info.tenant.id).toBe(first.tenantId);
    expect(info.scopes).toContain("admin");
  });

  it("first-run progress flips as the real W8 steps complete (DP-12)", async () => {
    // Fresh tenant: nothing done yet.
    expect(await fetchFirstRunProgress(cookieClient)).toEqual({
      hasModelProviderKey: false,
      hasAgent: false,
      hasSession: false,
    });

    // Step 1 — a model_provider_key credential in a vault (obviously fake
    // secret value; write-only on the wire).
    const vault = await createVault({ name: "first-run-vault" }, cookieClient);
    await addCredential(
      vault.id,
      {
        key: "anthropic",
        category: "model_provider_key",
        apiKey: "test-model-key-value-NOTASECRET",
      },
      cookieClient,
    );
    const afterKey = await fetchFirstRunProgress(cookieClient);
    expect(afterKey.hasModelProviderKey).toBe(true);
    expect(afterKey.hasAgent).toBe(false);
    expect(afterKey.hasSession).toBe(false);

    // Steps 2 + 3 — agent + first session through the public API.
    await seedSession(cookieClient, "first-run");
    expect(await fetchFirstRunProgress(cookieClient)).toEqual({
      hasModelProviderKey: true,
      hasAgent: true,
      hasSession: true,
    });
  });

  it("repeat sign-up reuses the tenant and OMITS the key (R0.3)", async () => {
    const repeat = await signup(
      { tenantName: "Another Name Entirely", adminEmail: ADMIN_EMAIL },
      anon,
    );
    expect(repeat.tenantId).toBe(first.tenantId);
    expect(repeat.apiKey).toBeUndefined();
  });
});
