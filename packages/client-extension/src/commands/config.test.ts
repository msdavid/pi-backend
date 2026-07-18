import { describe, it, expect } from "vitest";
import { runConfigFlow, type ConfigFlowUi } from "./config.js";
import { InMemoryAuthStore } from "../auth.js";
import { ManagedApiClient } from "../api-client.js";
import type { TenantInfo } from "@pi-managed/contracts";

const TENANT: TenantInfo = {
  tenantId: "t_01J",
  name: "Acme",
  quotaPlan: "pro",
  quotaUsage: {
    concurrentSessions: 1,
    concurrentSandboxes: 0,
    jobs: 0,
    vaultSize: 0,
    memorySize: 0,
    fileStorage: 0,
    tokenSpendUsd: 0.5,
  },
  quotaLimits: {
    concurrentSessions: 10,
    concurrentSandboxes: 10,
    maxJobs: 100,
    maxVaultCredentials: 100,
    maxMemoryStores: 25,
    maxFileStorageBytes: 10737418240,
    monthlyTokenSpendUsd: 200,
  },
};

/** Mock UI returning scripted answers keyed by dialog title. */
function mockUi(answers: Record<string, string>, selectChoice = "API key"): ConfigFlowUi & {
  notifications: { message: string; type?: string }[];
} {
  const notifications: { message: string; type?: string }[] = [];
  return {
    input: async (title) => answers[title],
    confirm: async () => true,
    select: async (title, _options) => answers[title] ?? selectChoice,
    notify: (message, type) => notifications.push({ message, type }),
    notifications,
  };
}

describe("/remote:config round-trip", () => {
  it("stores the key, pings /v1/tenant, and caches tenantId", async () => {
    const store = new InMemoryAuthStore();
    let saved: Record<string, unknown> | undefined;
    const ui = mockUi({
      "Pi Managed Backend URL": "https://api.example",
      "Backend API key": "secret-key",
    });

    const fetchImpl = async (url: string, init: RequestInit) => {
      if (url === "https://api.example/v1/tenant") {
        const headers = init.headers as Record<string, string>;
        if (headers["Authorization"] !== "Bearer secret-key") {
          return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(TENANT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    await runConfigFlow({
      ui,
      authStore: store,
      loadSettings: () => ({}),
      saveSettings: (patch) => {
        saved = patch;
      },
      createClient: (backendUrl) =>
        new ManagedApiClient({
          backendUrl,
          getApiKey: () => store.get("pi-managed-backend"),
          fetchImpl,
        }),
    });

    // key stored in AuthStorage, never in settings
    expect(store.get("pi-managed-backend")).toBe("secret-key");
    expect(JSON.stringify(saved)).not.toContain("secret-key");
    // settings hold backendUrl + apiKeyRef + cached tenant
    expect(saved).toMatchObject({
      backendUrl: "https://api.example",
      apiKeyRef: "pi-managed-backend",
      tenant: { tenantId: "t_01J", name: "Acme", quotaPlan: "pro" },
    });
    // success notification
    expect(ui.notifications.some((n) => /Connected/.test(n.message) && n.type === "info")).toBe(true);
  });

  it("notifies on backend failure without caching tenant", async () => {
    const store = new InMemoryAuthStore();
    let saved: Record<string, unknown> | undefined;
    const ui = mockUi({
      "Pi Managed Backend URL": "https://api.example",
      "Backend API key": "bad",
    });
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    await runConfigFlow({
      ui,
      authStore: store,
      loadSettings: () => ({}),
      saveSettings: (patch) => {
        saved = patch;
      },
      createClient: (backendUrl) =>
        new ManagedApiClient({
          backendUrl,
          getApiKey: () => store.get("pi-managed-backend"),
          fetchImpl,
        }),
    });

    // key was stored but settings were not persisted (no tenant cache)
    expect(store.get("pi-managed-backend")).toBe("bad");
    expect(saved).toBeUndefined();
    expect(ui.notifications.some((n) => n.type === "error" && /Could not reach/.test(n.message))).toBe(true);
  });

  it("cancels cleanly when no URL is provided", async () => {
    const store = new InMemoryAuthStore();
    const ui = mockUi({});
    let saved: unknown;
    await runConfigFlow({
      ui,
      authStore: store,
      loadSettings: () => ({}),
      saveSettings: (patch) => {
        saved = patch;
      },
      createClient: () => {
        throw new Error("should not be called");
      },
    });
    expect(saved).toBeUndefined();
    expect(ui.notifications.some((n) => /Cancelled/.test(n.message))).toBe(true);
  });

  it("reports the OAuth /remote:login stub and does not store a key", async () => {
    const store = new InMemoryAuthStore();
    const ui = mockUi(
      {
        "Pi Managed Backend URL": "https://api.example",
      },
      "OAuth (/remote:login)",
    );
    let saved: unknown;
    await runConfigFlow({
      ui,
      authStore: store,
      loadSettings: () => ({}),
      saveSettings: (patch) => {
        saved = patch;
      },
      createClient: () => {
        throw new Error("should not be called");
      },
    });
    expect(store.get("pi-managed-backend")).toBeUndefined();
    expect(saved).toBeUndefined();
    expect(
      ui.notifications.some((n) => n.type === "warning" && /\/remote:login/.test(n.message)),
    ).toBe(true);
  });
});
