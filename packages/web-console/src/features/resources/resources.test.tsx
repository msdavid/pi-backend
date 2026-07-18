/**
 * Resources section-layout feature tests (WP-C3-prep; console-spec §7.1:
 * contextual submenu — persistent sub-navigation over the family screens,
 * family overview on the index route).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

beforeEach(() => {
  window.localStorage.clear();
});

const SECTIONS = [
  ["Environments", "/console/resources/environments"],
  ["Vaults", "/console/resources/vaults"],
  ["Memory stores", "/console/resources/memory-stores"],
  ["Files", "/console/resources/files"],
  ["Skills", "/console/resources/skills"],
] as const;

describe("resources section layout (§7.1)", () => {
  it("renders the sub-navigation with every family and the index overview", async () => {
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/resources");
    await screen.findByRole("heading", { name: "Resources" });

    const subnav = screen.getByRole("navigation", {
      name: "Resources sections",
    });
    for (const [label, href] of SECTIONS) {
      expect(within(subnav).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href,
      );
    }
    // The index overview carries a DP-6 line per family.
    expect(
      screen.getByText(/secret values are write-only/),
    ).toBeInTheDocument();
  });

  it("navigates into a family; the sub-navigation stays mounted", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(
      FakeConsoleApi.signedIn(["read"]),
      "/console/resources",
    );
    const subnav = await screen.findByRole("navigation", {
      name: "Resources sections",
    });
    await user.click(
      within(subnav).getByRole("link", { name: "Memory stores" }),
    );
    expect(router.state.location.pathname).toBe("/resources/memory-stores");
    // Layout persists around the child screen (§7.1 submenu, not a page swap).
    expect(
      screen.getByRole("navigation", { name: "Resources sections" }),
    ).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Memory stores" });
  });

  it("reaches the vaults family through the sub-navigation (WP-C3.3)", async () => {
    const user = userEvent.setup();
    renderConsole(FakeConsoleApi.signedIn(["read"]), "/console/resources");
    const subnav = await screen.findByRole("navigation", {
      name: "Resources sections",
    });
    await user.click(within(subnav).getByRole("link", { name: "Vaults" }));
    await screen.findByRole("heading", { name: "Vaults" });
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(
      FakeConsoleApi.signedIn(["read"]),
      "/console/resources",
    );
    await screen.findByRole("heading", { name: "Resources" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
