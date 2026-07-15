/**
 * @pi-managed/client — `/remote:config` command (spec §24).
 *
 * First-run flow: prompt for backend URL + API key (or `/remote:login` OAuth
 * stub), store the key in Pi's AuthStorage under `apiKeyRef`, ping
 * `GET /v1/tenant`, and cache `tenantId` into settings on success. Re-run to
 * update URL/key/defaults. The raw key is never written to settings JSON.
 *
 * `runConfigFlow` is decoupled from Pi types so it can be tested against a
 * mock client + in-memory store. `registerConfigCommand` wires it into Pi.
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

/** UI slice used by the config flow (structural subset of Pi's UI context). */
export interface ConfigFlowUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Dependencies for `runConfigFlow` (all injectable for testing). */
export interface ConfigFlowDeps {
  ui: ConfigFlowUi;
  authStore: AuthStore;
  loadSettings(): Partial<PiManagedSettings>;
  saveSettings(patch: Partial<PiManagedSettings>): void;
  createClient(backendUrl: string): ManagedApiClient;
}

const AUTH_API_KEY = "API key";
const AUTH_OAUTH = "OAuth (/remote:login)";

/**
 * Run the config flow. Steps:
 *  1. Prompt for backend URL (pre-filled with current value).
 *  2. Choose auth: API key (prompt) or OAuth (stub → `/remote:login`).
 *  3. Store the key in AuthStorage under `apiKeyRef`.
 *  4. Ping `GET /v1/tenant`; on success cache `tenant` into settings.
 */
export async function runConfigFlow(deps: ConfigFlowDeps): Promise<void> {
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

  const method = await deps.ui.select("Authentication", [AUTH_API_KEY, AUTH_OAUTH]);
  if (method === AUTH_OAUTH) {
    deps.ui.notify(
      "`/remote:login` (OAuth) is not implemented yet — use an API key for now.",
      "warning",
    );
    return;
  }

  const apiKey = await deps.ui.input("Backend API key");
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

/** Register `/remote:config` with Pi. RPC-invokable (works in `rpc` mode). */
export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("remote:config", {
    description: "Configure the Pi Managed Backend connection (spec §24).",
    handler: async (_args, ctx) => {
      const settingsPath = defaultSettingsPath(ctx.cwd);
      const authStore = new PiAuthStorageAdapter(ctx.modelRegistry.authStorage);
      await runConfigFlow({
        ui: ctx.ui,
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
