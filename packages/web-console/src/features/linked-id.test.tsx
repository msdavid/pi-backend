/**
 * The shared parameterized id link (console-spec §7.6): every id family
 * renders mono, one-click-copyable, and deep-linked to ITS detail route.
 * Pinned per family so a `to`/`params` mix-up in any call site of
 * `LinkedId` (or the `SessionId` thin wrapper) fails here.
 */
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../test/fake-console-api.js";
import { renderConsole } from "../test/render-console.js";
import "../ui/test-utils.js"; // afterEach(cleanup)

function seeded(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read", "write", "admin"]);
  api.addSession({
    id: "sess_01LINKED",
    title: "fix the login bug",
    status: "idle",
    stopReason: "completed",
    agentId: "agent_01LINKED",
    agentVersion: 1,
    environmentId: "env_01LINKED",
  });
  api.addVault({ id: "vault_01LINKED", name: "team-secrets" });
  api.addEnvironment({ id: "env_01LINKED", name: "cloud-default", type: "cloud" });
  api.addMemoryStore({ id: "mem_01LINKED", displayTitle: "conventions" });
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("LinkedId — one component, every family's detail route", () => {
  const CASES = [
    {
      family: "sessions",
      route: "/console/sessions",
      id: "sess_01LINKED",
      href: "/console/sessions/sess_01LINKED",
    },
    {
      family: "vaults",
      route: "/console/resources/vaults",
      id: "vault_01LINKED",
      href: "/console/resources/vaults/vault_01LINKED",
    },
    {
      family: "environments",
      route: "/console/resources/environments",
      id: "env_01LINKED",
      href: "/console/resources/environments/env_01LINKED",
    },
    {
      family: "memory stores",
      route: "/console/resources/memory-stores",
      id: "mem_01LINKED",
      href: "/console/resources/memory-stores/mem_01LINKED",
    },
  ] as const;

  for (const { family, route, id, href } of CASES) {
    it(`${family}: the id links to its detail route and copies whole`, async () => {
      renderConsole(seeded(), route);
      const link = await screen.findByRole("link", { name: new RegExp(id) });
      expect(link).toHaveAttribute("href", href);
      // The copy affordance sits next to the link and targets the FULL id.
      expect(
        screen.getByRole("button", { name: `Copy ${id}` }),
      ).toBeInTheDocument();
    });
  }
});
