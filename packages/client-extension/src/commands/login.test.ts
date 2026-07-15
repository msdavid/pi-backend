/**
 * `/remote:login` round-trip (spec §24.5, §29.6 verify).
 *
 * Mocked client + in-memory store: opens the onboarding URL, pastes the key,
 * stores it in AuthStorage, pings `GET /v1/tenant`, and caches the tenant into
 * settings — the same end-state as `/remote:config` but driven by the
 * paste-the-key flow. Mirrors `config.test.ts`'s mock patterns.
 */

import { describe, it, expect } from "vitest";
import { runLoginFlow, type LoginFlowUi } from "./login.js";
import { InMemoryAuthStore } from "../auth.js";
import { ManagedApiClient } from "../api-client.js";
import type { TenantInfo } from "@pi-managed/contracts";

const TENANT: TenantInfo = {
  tenantId: "tnt_01J",
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
};

/** Mock UI returning scripted `input` answers keyed by dialog title. */
function mockUi(answers: Record<string, string>): LoginFlowUi & {
  notifications: { message: string; type?: string }[];
  openedUrls: string[];
} {
  const notifications: { message: string; type?: string }[] = [];
  const openedUrls: string[] = [];
  return {
    input: async (title) => answers[title],
    notify: (message, type) => notifications.push({ message, type }),
    openUrl: async (url) => {
      openedUrls.push(url);
    },
    notifications,
    openedUrls,
  };
}

describe("/remote:login round-trip", () => {
  it("opens the onboarding page, pastes the key, pings /v1/tenant, caches tenant", async () => {
    const store = new InMemoryAuthStore();
    let saved: Record<string, unknown> | undefined;
    const ui = mockUi({
      "Pi Managed Backend URL": "https://api.example",
      "Paste your Pi Managed Backend API key": "secret-key",
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

    await runLoginFlow({
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

    // Opened the onboarding page.
    expect(ui.openedUrls).toEqual(["https://api.example/onboarding"]);
    // Key stored in AuthStorage, never in settings.
    expect(store.get("pi-managed-backend")).toBe("secret-key");
    expect(JSON.stringify(saved)).not.toContain("secret-key");
    // Settings hold backendUrl + apiKeyRef + cached tenant.
    expect(saved).toMatchObject({
      backendUrl: "https://api.example",
      apiKeyRef: "pi-managed-backend",
      tenant: { tenantId: "tnt_01J", name: "Acme", quotaPlan: "pro" },
    });
    // Success notification.
    expect(
      ui.notifications.some((n) => /Connected/.test(n.message) && n.type === "info"),
    ).toBe(true);
  });

  it("notifies on backend failure without caching tenant", async () => {
    const store = new InMemoryAuthStore();
    let saved: Record<string, unknown> | undefined;
    const ui = mockUi({
      "Pi Managed Backend URL": "https://api.example",
      "Paste your Pi Managed Backend API key": "bad",
    });
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "bad key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );

    await runLoginFlow({
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

    expect(store.get("pi-managed-backend")).toBe("bad");
    expect(saved).toBeUndefined();
    expect(
      ui.notifications.some((n) => n.type === "error" && /Could not reach/.test(n.message)),
    ).toBe(true);
  });

  it("cancels cleanly when no URL is provided", async () => {
    const store = new InMemoryAuthStore();
    const ui = mockUi({});
    let saved: unknown;
    await runLoginFlow({
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

  it("still works without an opener (surfaces the URL via notify)", async () => {
    const store = new InMemoryAuthStore();
    let saved: Record<string, unknown> | undefined;
    const { openUrl: _omit, ...uiWithoutOpener } = mockUi({
      "Pi Managed Backend URL": "https://api.example",
      "Paste your Pi Managed Backend API key": "secret-key",
    });
    const ui = uiWithoutOpener as LoginFlowUi & {
      notifications: { message: string; type?: string }[];
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(TENANT), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await runLoginFlow({
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

    // The onboarding URL was surfaced to the user via notify.
    expect(
      ui.notifications.some((n) => /onboarding/.test(n.message) && n.type === "info"),
    ).toBe(true);
    expect(saved).toMatchObject({
      backendUrl: "https://api.example",
      apiKeyRef: "pi-managed-backend",
    });
  });
});
