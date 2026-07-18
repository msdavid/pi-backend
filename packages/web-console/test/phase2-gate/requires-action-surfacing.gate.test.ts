/**
 * Phase-2 gate — console-spec §7.5: sessions in `requires_action` MUST
 * surface globally — a count badge on the sidebar's Sessions item AND a Home
 * section, not only on their own page. Gate-level pin of what
 * `src/app/shell.test.tsx` (badge half) and
 * `src/features/home/home.test.tsx` (Home half) cover during development,
 * asserted here on ONE render so the two surfaces can never drift apart —
 * both fed by the same server-side `?stopReason=requires_action` filter
 * (WP-C2.0/C2.2), never a client-side scan.
 *
 * The API client is a collaborator (fake at the `<ApiClientProvider>` seam);
 * the rendered app tree is the real one.
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§7.5 — requires_action surfaces globally: sidebar badge AND Home", () => {
  it("both surfaces show the waiting sessions from one server-filtered query", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({
      id: "sess_01GATEWAIT1",
      title: "waiting on a tool confirmation",
      status: "idle",
      stopReason: "requires_action",
    });
    api.addSession({
      id: "sess_01GATEWAIT2",
      status: "idle",
      stopReason: "requires_action",
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    api.addSession({ id: "sess_01GATERUN", status: "running" });
    renderConsole(api, "/console/");

    // Sidebar half: the Sessions nav item carries the count badge.
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const sessionsLink = await within(nav).findByRole("link", {
      name: (name) =>
        /Sessions/.test(name) && /2\s*sessions require action/.test(name),
    });
    expect(sessionsLink).toHaveAttribute("href", "/console/sessions");

    // Home half: the "Requires action" section lists the waiting sessions.
    const heading = await screen.findByRole("heading", {
      name: "Requires action",
      level: 2,
    });
    const section = heading.parentElement!;
    expect(
      await within(section).findByText("waiting on a tool confirmation"),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("link", { name: /sess_01GATEWAIT2/ }),
    ).toBeInTheDocument();
    // Running-but-not-blocked sessions do not qualify.
    expect(
      within(section).queryByText(/sess_01GATERUN/),
    ).not.toBeInTheDocument();

    // Both surfaces ride the server-side filter (§7.5 via WP-C2.0) — the
    // fake saw the filtered read, so neither surface can be a client scan.
    expect(
      api.calls.some(
        (c) =>
          c.method === "GET" && c.path.includes("stopReason=requires_action"),
      ),
    ).toBe(true);
  });

  it("stays silent when nothing requires action (badge hidden, section empty)", async () => {
    const api = FakeConsoleApi.signedIn(["read"]);
    api.addSession({ id: "sess_01GATERUN", status: "running" });
    renderConsole(api, "/console/");

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await within(nav).findByRole("link", { name: "Sessions" });
    expect(within(nav).queryByText(/require action/)).not.toBeInTheDocument();

    const heading = await screen.findByRole("heading", {
      name: "Requires action",
      level: 2,
    });
    expect(heading.parentElement!).toHaveTextContent(/Nothing is waiting/i);
  });
});
