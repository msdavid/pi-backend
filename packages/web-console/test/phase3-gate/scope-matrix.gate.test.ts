/**
 * Phase-3 gate — console-spec §13 item §6.1, extended to the phase-3
 * surfaces: the TOP-LEVEL sidebar set per scope is pinned by the phase-1
 * gate (`test/phase1-gate/scope-matrix.gate.test.ts`, never trimmed); this
 * file pins the §7.1 CONTEXTUAL SUBMENUS the phase-3 WPs filled in —
 * Resources and Settings — as exact sets, plus the §6.1 presentation rule
 * on the new management surfaces: sections a scope can browse stay visible
 * with their mutations DISABLED (with a reason naming the scope the backend
 * ACTUALLY requires — §6.2: `write` for resource management, `admin` only
 * for API-key management), never hidden.
 *
 * Per-screen disabled-with-reason coverage lives in each feature suite
 * (agents/environments/vaults/api-keys/webhooks/jobs tests); the gate keeps
 * one representative pin per pattern so a regression in the shared approach
 * fails a release item, not only a dev-time test.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

/** §7.1: the Resources submenu, in sidebar-sketch order. */
const RESOURCES_SECTIONS = [
  "Environments",
  "Vaults",
  "Memory stores",
  "Files",
  "Skills",
];
/** §7.1: the Settings submenu (mode-invariant part; Health is §5's). */
const SETTINGS_SECTIONS = ["API keys", "Webhooks", "Tenant"];

async function submenuLabels(name: string): Promise<string[]> {
  const nav = await screen.findByRole("navigation", { name });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§6.1/§7.1 — the phase-3 submenus are exact sets", () => {
  it("Resources: read scope sees exactly the five families", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/resources");
    expect(await submenuLabels("Resources sections")).toEqual(
      RESOURCES_SECTIONS,
    );
  });

  it("Resources: admin scope sees the same five (admin adds actions, not sections)", async () => {
    renderConsole(
      FakeConsoleApi.signedIn(["read", "write", "admin"]),
      "/console/resources",
    );
    expect(await submenuLabels("Resources sections")).toEqual(
      RESOURCES_SECTIONS,
    );
  });

  it("Settings (admin, team mode): exactly API keys · Webhooks · Tenant · Health", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.config = { mode: "team", onboardingEnabled: false };
    renderConsole(api, "/console/settings");
    // The Health item joins once /console/config resolves the mode (§5.1).
    await screen.findByRole("link", { name: "Health" });
    expect(await submenuLabels("Settings sections")).toEqual([
      ...SETTINGS_SECTIONS,
      "Health",
    ]);
  });

  it("Settings (admin, saas mode): no Health item (§5.1 — pre-phase-5 exact set)", async () => {
    const api = FakeConsoleApi.signedIn(["admin"]);
    api.config = { mode: "saas", onboardingEnabled: true };
    const { queryClient } = renderConsole(api, "/console/settings");
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(await submenuLabels("Settings sections")).toEqual(
      SETTINGS_SECTIONS,
    );
  });
});

describe("§6.1 — mutations on browsable sections disable with an accurate reason", () => {
  it("read scope on /agents: the section renders, New agent is disabled and names the write scope (§6.2)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addAgent({ id: "agent_01SCOPE", name: "code-reviewer" });
    renderConsole(api, "/console/agents");

    await screen.findByText("code-reviewer");
    const create = screen.getByRole("button", { name: "New agent" });
    expect(create).toBeDisabled();
    // The reason is exposed to AT, not only visually (§6.1/DP-6), and names
    // the scope the backend actually requires — write, not admin (§6.2).
    expect(create).toHaveAccessibleDescription(/write/);
  });

  it("write scope on /agents: resource-management mutations are ENABLED (§6.2)", async () => {
    const api = FakeConsoleApi.signedIn(["read", "write"]);
    api.addAgent({ id: "agent_01SCOPE", name: "code-reviewer" });
    renderConsole(api, "/console/agents");

    await screen.findByText("code-reviewer");
    expect(screen.getByRole("button", { name: "New agent" })).toBeEnabled();
  });

  it("read scope deep-linked into /settings/api-keys (hidden ≠ blocked, §1.4): reads work, Issue is disabled with the reason", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addApiKey({ id: "apikey_01SCOPE", name: "ci-key" });
    renderConsole(api, "/console/settings/api-keys");

    // The route resolves even though the sidebar hides Settings (§1.4) —
    // the backend is the enforcer, the console only presents (§6.4).
    const table = await screen.findByRole("table", { name: "API keys" });
    expect(within(table).getByText("ci-key")).toBeInTheDocument();
    const issue = screen.getByRole("button", { name: "Issue key" });
    expect(issue).toBeDisabled();
    expect(issue).toHaveAccessibleDescription(/admin/);
  });
});
