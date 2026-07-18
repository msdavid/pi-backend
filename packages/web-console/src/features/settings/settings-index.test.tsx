/**
 * Settings-index feature tests: the Pi-extension install instructions are
 * reprinted in Settings (journey W8 step 3 — "reprinted in Settings any
 * time"), for every deployment mode. The command is the canonical one the
 * README documents and the saas signup response returns (`installCommand`).
 */
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsoleConfig } from "@pi-managed/contracts";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

const INSTALL_COMMAND = "pi install npm:@pi-managed/client";

beforeEach(() => {
  window.localStorage.clear();
});

async function expectInstallCard() {
  const card = await screen.findByRole("region", {
    name: "Install the Pi extension",
  });
  expect(within(card).getByText(INSTALL_COMMAND)).toBeInTheDocument();
  // The connect step: /remote:config + an API key from the API keys section.
  expect(card.textContent).toContain("/remote:config");
  expect(
    within(card).getByRole("link", { name: /issue one under API keys/ }),
  ).toBeInTheDocument();
  return card;
}

function adminApi(config: ConsoleConfig): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = config;
  return api;
}

describe("Settings index — install instructions (W8 step 3)", () => {
  it("reprints the install instructions for admin in saas mode", async () => {
    renderConsole(
      adminApi({ mode: "saas", onboardingEnabled: true }),
      "/console/settings",
    );
    await expectInstallCard();
  });

  it("reprints the install instructions for admin in solo mode", async () => {
    renderConsole(
      adminApi({ mode: "solo", onboardingEnabled: false }),
      "/console/settings",
    );
    await expectInstallCard();
  });

  it("reprints the install instructions for admin in team mode", async () => {
    renderConsole(
      adminApi({ mode: "team", onboardingEnabled: false }),
      "/console/settings",
    );
    await expectInstallCard();
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(
      adminApi({ mode: "team", onboardingEnabled: false }),
      "/console/settings",
    );
    await expectInstallCard();
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
