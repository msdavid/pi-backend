/**
 * @pi-managed/client — `/remote:login` command (spec §24.5, §29.6).
 *
 * The OAuth-style first-run flow: opens the backend's onboarding page in a
 * browser, the user signs up there (or signs in), receives an API key, pastes
 * it back here, and the extension stores it in AuthStorage, pings
 * `GET /v1/tenant`, and caches the tenant into settings — the same end-state
 * as `/remote:config` but driven from the onboarding page rather than a raw
 * key prompt.
 *
 * v1 ships a paste-the-key flow (spec §24.5: "For v1, a paste-the-key flow is
 * acceptable; a full OAuth redirect is a future enhancement."). The raw key is
 * never written to settings JSON — only `apiKeyRef` (a pointer into
 * AuthStorage), matching `/remote:config`.
 *
 * `runLoginFlow` is decoupled from Pi types so it can be tested against a mock
 * client + in-memory store. `registerLoginCommand` wires it into Pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AuthStore,
  PiAuthStorageAdapter,
  resolveApiKey,
} from "../auth.js";
import {
  defaultSettingsPath,
  loadSettingsFile,
  saveSettingsFile,
  resolveConfig,
  type PiManagedSettings,
} from "../config.js";
import { ManagedApiClient } from "../api-client.js";

/** UI slice used by the login flow (structural subset of Pi's UI context). */
export interface LoginFlowUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /**
   * Best-effort open of `url` in the user's browser. Optional: when absent the
   * flow falls back to notifying the user with the URL to open manually (v1
   * paste-the-key flow, §24.5).
   */
  openUrl?(url: string): Promise<void> | void;
}

/** Dependencies for `runLoginFlow` (all injectable for testing). */
export interface LoginFlowDeps {
  ui: LoginFlowUi;
  authStore: AuthStore;
  loadSettings(): Partial<PiManagedSettings>;
  saveSettings(patch: Partial<PiManagedSettings>): void;
  createClient(backendUrl: string): ManagedApiClient;
}

/**
 * Run the `/remote:login` OAuth-style flow (§24.5, §29.6). Steps:
 *  1. Prompt for the backend URL (pre-filled with the current value).
 *  2. Open the backend's onboarding page (best-effort) and ask the user to
 *     sign up / sign in there.
 *  3. Prompt the user to paste the API key from the onboarding page.
 *  4. Store the key in AuthStorage under `apiKeyRef`.
 *  5. Ping `GET /v1/tenant`; on success cache `tenant` into settings.
 */
export async function runLoginFlow(deps: LoginFlowDeps): Promise<void> {
  const current = deps.loadSettings();
  const ref = current.apiKeyRef ?? "pi-managed-backend";

  const url = await deps.ui.input(
    "Pi Managed Backend URL",
    current.backendUrl ?? "https://api.pi-managed.example",
  );
  if (!url) {
    deps.ui.notify("Cancelled.", "info");
    return;
  }

  // Open the onboarding page (best-effort). Always surface the URL so a
  // headless/unsupported host can still complete the flow manually.
  const onboardingUrl = `${url.replace(/\/$/, "")}/onboarding`;
  if (deps.ui.openUrl) {
    try {
      await deps.ui.openUrl(onboardingUrl);
    } catch {
      // ignore — the notify below tells the user where to go.
    }
  }
  deps.ui.notify(
    `Opening the onboarding page in your browser: ${onboardingUrl}\nSign up (or sign in), then paste your API key below.`,
    "info",
  );

  const apiKey = await deps.ui.input(
    "Paste your Pi Managed Backend API key",
  );
  if (!apiKey) {
    deps.ui.notify("No API key provided; cancelled.", "info");
    return;
  }

  deps.authStore.set(ref, apiKey);

  const client = deps.createClient(url);
  let tenant;
  try {
    tenant = await client.getTenant();
  } catch (e) {
    deps.ui.notify(
      `Could not reach backend: ${(e as Error).message}`,
      "error",
    );
    return;
  }

  // Persist settings (NO raw key — only the ref + cached tenant).
  deps.saveSettings({
    ...current,
    backendUrl: url,
    apiKeyRef: ref,
    tenant: {
      tenantId: tenant.tenantId,
      name: tenant.name,
      quotaPlan: tenant.quotaPlan,
    },
  });

  deps.ui.notify(
    `Connected to Pi Managed Backend. Tenant: ${tenant.name} (${tenant.tenantId})`,
    "info",
  );
}

/** Register `/remote:login` with Pi. RPC-invokable (works in `rpc` mode). */
export function registerLoginCommand(pi: ExtensionAPI): void {
  pi.registerCommand("remote:login", {
    description: "Sign in / onboard against a Pi Managed Backend (spec §24.5).",
    handler: async (_args, ctx) => {
      const settingsPath = defaultSettingsPath(ctx.cwd);
      const authStore = new PiAuthStorageAdapter(ctx.modelRegistry.authStorage);
      await runLoginFlow({
        ui: {
          input: ctx.ui.input.bind(ctx.ui),
          notify: ctx.ui.notify.bind(ctx.ui),
          // Pi hosts may expose an opener; wire it best-effort so the flow still
          // works when it is absent (the URL is surfaced via notify).
          openUrl:
            typeof (ctx.ui as unknown as { openUrl?: unknown }).openUrl ===
            "function"
              ? (
                  ctx.ui as unknown as {
                    openUrl: (url: string) => Promise<void> | void;
                  }
                ).openUrl.bind(ctx.ui)
              : undefined,
        },
        authStore,
        loadSettings: () => loadSettingsFile(settingsPath),
        saveSettings: (patch) => saveSettingsFile(settingsPath, patch),
        createClient: (backendUrl) =>
          new ManagedApiClient({
            backendUrl,
            getApiKey: () =>
              resolveApiKey(resolveConfig(loadSettingsFile(settingsPath)), authStore),
          }),
      });
    },
  });
}
