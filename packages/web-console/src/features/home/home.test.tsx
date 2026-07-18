/**
 * Home feature tests (WP-C1.7 + WP-C2.2; console-spec §7.2, W1 step 3):
 * headline strip (DP-14 ≤ 5 metrics), requires_action section (Home half of
 * §7.5, served by the server-side `?stopReason=` filter since WP-C2.2 — the
 * sidebar-badge half lives in `src/app/shell.test.tsx`), active sessions,
 * and the per-browser recents + favorites. The API client is a collaborator
 * (fake at the `<ApiClientProvider>` seam).
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithHomeData(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read"]);
  api.addSession({
    id: "sess_01RUN1",
    title: "deploy pipeline",
    status: "running",
    createdAt: "2026-07-03T10:00:00.000Z",
  });
  api.addSession({
    id: "sess_01RUN2",
    status: "running",
    createdAt: "2026-07-03T09:00:00.000Z",
  });
  api.addSession({
    id: "sess_01WAIT",
    title: "needs a tool confirmation",
    status: "idle",
    stopReason: "requires_action",
    createdAt: "2026-07-02T10:00:00.000Z",
  });
  api.addSession({
    id: "sess_01DONE",
    status: "idle",
    stopReason: "completed",
    createdAt: "2026-07-01T10:00:00.000Z",
  });
  return api;
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name, level: 2 });
  return heading.parentElement!;
}

describe("Home (§7.2)", () => {
  it("headline strip: ≤5 metrics with the counts the read surface computes", async () => {
    window.localStorage.setItem(
      "pi-console.favorite-sessions",
      JSON.stringify([{ id: "sess_01DONE" }]),
    );
    renderConsole(fakeWithHomeData(), "/console/");
    const strip = await screen.findByRole("region", {
      name: "Headline metrics",
    });

    const metric = (label: string) =>
      within(strip).getByText(label).parentElement!;
    expect(await within(strip).findByText("2")).toBeInTheDocument();
    expect(metric("Active sessions")).toHaveTextContent("2");
    expect(metric("Requires action")).toHaveTextContent("1");
    expect(metric("Favorites")).toHaveTextContent("1");
    // DP-14: never more than 5 metrics in the strip.
    expect(strip.children.length).toBeLessThanOrEqual(5);
    // Everything fits in one page → no truncation qualifier anywhere.
    expect(
      screen.queryByRole("link", { name: "View all in Sessions" }),
    ).not.toBeInTheDocument();
  });

  it("says so when the counts cover only the first page (truncation honesty)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    // 26 running (> the 25-limit active page) + 51 requires_action (> the
    // 50-limit server-filtered requires_action page, WP-C2.2).
    for (let i = 0; i < 26; i += 1) {
      api.addSession({
        id: `sess_01RUN${String(i).padStart(2, "0")}`,
        status: "running",
        createdAt: new Date(Date.UTC(2026, 6, 3, 10, 0, i)).toISOString(),
      });
    }
    for (let i = 0; i < 51; i += 1) {
      api.addSession({
        id: `sess_01WAI${String(i).padStart(2, "0")}`,
        status: "idle",
        stopReason: "requires_action",
        createdAt: new Date(Date.UTC(2026, 6, 2, 10, 0, i)).toISOString(),
      });
    }
    renderConsole(api, "/console/");

    // The active metric label carries the qualifier; the requires_action
    // metric says "50+" (another server page exists)…
    expect(
      await screen.findByText("Active sessions (25 most recent)"),
    ).toBeInTheDocument();
    const strip = screen.getByRole("region", { name: "Headline metrics" });
    expect(
      within(strip).getByText("Requires action").parentElement,
    ).toHaveTextContent("50+");
    // …and each truncated section links to the full list.
    const links = screen.getAllByRole("link", {
      name: "View all in Sessions",
    });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/console/sessions");
    expect(
      screen.getByText(/50 most recent sessions requiring action/),
    ).toBeInTheDocument();
  });

  it("surfaces requires_action sessions with their stop reason (§7.5 Home half)", async () => {
    const api = fakeWithHomeData();
    renderConsole(api, "/console/");
    const waiting = await section("Requires action");
    // WP-C2.2: the section rides the server-side stopReason filter (WP-C2.0),
    // not a client-side scan of an idle page.
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" && c.path.includes("stopReason=requires_action"),
      ),
    ).toBe(true);
    expect(
      await within(waiting).findByText("needs a tool confirmation"),
    ).toBeInTheDocument();
    expect(within(waiting).getByText("requires_action")).toBeInTheDocument();
    // Completed idle sessions do not qualify.
    expect(within(waiting).queryByTitle("sess_01DONE")).not.toBeInTheDocument();
    // §7.6: the id deep-links to the session.
    expect(
      within(waiting).getByRole("link", { name: /sess_01WAIT/ }),
    ).toHaveAttribute("href", "/console/sessions/sess_01WAIT");
  });

  it("lists active sessions", async () => {
    renderConsole(fakeWithHomeData(), "/console/");
    const active = await section("Active sessions");
    expect(
      await within(active).findByText("deploy pipeline"),
    ).toBeInTheDocument();
    expect(within(active).getAllByText("running")).toHaveLength(2);
  });

  it("teaches the CLI when nothing is running (DP-5)", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/");
    expect(
      await screen.findByText("No sessions running"),
    ).toBeInTheDocument();
    expect(
      screen.getByText('/remote:delegate "fix the login bug"'),
    ).toBeInTheDocument();
  });

  it("shows recents and favorites from per-browser state (no API)", async () => {
    window.localStorage.setItem(
      "pi-console.recent-sessions",
      JSON.stringify([{ id: "sess_01RUN1", title: "deploy pipeline" }]),
    );
    window.localStorage.setItem(
      "pi-console.favorite-sessions",
      JSON.stringify([{ id: "sess_01WAIT", title: "needs a tool confirmation" }]),
    );
    const api = fakeWithHomeData();
    renderConsole(api, "/console/");
    await screen.findByRole("region", { name: "Headline metrics" });

    const recents = await section("Recently viewed");
    expect(
      within(recents).getByRole("link", { name: "deploy pipeline" }),
    ).toHaveAttribute("href", "/console/sessions/sess_01RUN1");
    const favorites = await section("Favorites");
    expect(
      within(favorites).getByRole("link", { name: /sess_01WAIT/ }),
    ).toBeInTheDocument();
    // Shortcuts come from localStorage alone — no /v1 call carries their ids.
    expect(api.calls.every((c) => !c.path.includes("sess_01"))).toBe(true);
  });

  it("explains the empty shortcut sections", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/");
    expect(
      await screen.findByText("Sessions you open appear here."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Star a session on its detail page to pin it here."),
    ).toBeInTheDocument();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithHomeData(), "/console/");
    await screen.findByRole("region", { name: "Headline metrics" });
    await screen.findByText("deploy pipeline");
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("first-run card (WP-C3.8, DP-12)", () => {
  /** saas + onboarding — where the /signup checklist exists (W8). */
  function saasFake(): FakeConsoleApi {
    const api = fakeWithHomeData();
    api.config = { mode: "saas", onboardingEnabled: true };
    return api;
  }

  it("links the incomplete checklist from Home (saas + onboarding)", async () => {
    const api = saasFake(); // sessions exist, no model key, no agent: 1/3
    renderConsole(api, "/console/");
    const card = await screen.findByRole("region", {
      name: "Finish setting up",
    });
    expect(card).toHaveTextContent("1 of 3 first-run steps done");
    expect(
      within(card).getByRole("link", { name: "Resume the setup checklist" }),
    ).toHaveAttribute("href", "/console/signup");
  });

  it("disappears once every step is done", async () => {
    const api = saasFake();
    api.addVault({ id: "vault_01SET" });
    api.addCredential("vault_01SET", {
      key: "anthropic",
      category: "model_provider_key",
    });
    api.addAgent({ id: "agent_01SET" });
    renderConsole(api, "/console/");
    await screen.findByRole("region", { name: "Headline metrics" });
    await screen.findByText("deploy pipeline");
    expect(
      screen.queryByRole("region", { name: "Finish setting up" }),
    ).not.toBeInTheDocument();
  });

  it("outside saas+onboarding it neither renders nor probes", async () => {
    const api = fakeWithHomeData(); // default config: solo
    renderConsole(api, "/console/");
    await screen.findByRole("region", { name: "Headline metrics" });
    expect(
      screen.queryByRole("region", { name: "Finish setting up" }),
    ).not.toBeInTheDocument();
    // The cross-family probe never fired (no vault/agent reads from Home).
    expect(api.calls.some((c) => c.path.startsWith("/v1/vaults"))).toBe(false);
    expect(api.calls.some((c) => c.path.startsWith("/v1/agents"))).toBe(false);
  });
});
