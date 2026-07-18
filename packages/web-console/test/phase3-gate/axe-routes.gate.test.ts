/**
 * Phase-3 gate — console-spec §13 item §12.2: axe-core clean on EVERY route.
 *
 * The route list is enumerated programmatically from the REAL router
 * (`createConsoleRouter().routesById`) at collection time, so a WP that adds
 * a route cannot dodge the gate: every registered path renders here, with
 * representative fake data seeded across all `/v1` families, and must have
 * zero axe violations. Route params are substituted from PARAM_SEEDS — an
 * unknown param fails loudly, forcing the seed map to grow with the router.
 *
 * Also carries the §12.2 keyboard-navigability spot checks for the phase-3
 * admin surfaces (tables and dialogs are keyboard-first: roving tabindex +
 * Arrow/Enter on tables, focus trap + Escape + focus return on dialogs).
 * Component-level keyboard behavior is tested in `src/ui/`; these checks pin
 * the behavior on the real screens.
 *
 * The API client is a collaborator (fake at the `<ApiClientProvider>` seam);
 * the rendered app tree is the real one. Mode `team` + admin scopes render
 * the widest surface (Settings incl. the live health widget — the fake
 * subclass implements the `HealthProber` capability the hooks duck-type, so
 * no probe touches the network); /signup's saas form variant is axe-tested
 * in `src/features/onboarding/signup.test.tsx`.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { createConsoleRouter } from "../../src/app/router.js";
import { renderConsole } from "../../src/test/render-console.js";
import { axe } from "../../src/ui/test-utils.js"; // + afterEach(cleanup)
import { HealthCapableFake } from "./helpers.js";

/** One seeded id per route param; a param without a seed fails the gate. */
const PARAM_SEEDS: Record<string, string> = {
  $sessionId: "sess_01GATE",
  $agentId: "agent_01GATE",
  $jobId: "job_01GATE",
  $environmentId: "env_01GATE",
  $vaultId: "vault_01GATE",
  $storeId: "mem_01GATE",
};

/** Every registered route path, deduplicated (layout + index share a path). */
function allRoutePaths(): string[] {
  const router = createConsoleRouter();
  const paths = new Set<string>();
  for (const [id, route] of Object.entries(router.routesById)) {
    if (id === "__root__") continue;
    const fullPath = (route as { fullPath: string }).fullPath;
    paths.add(fullPath === "/" ? "/" : fullPath.replace(/\/+$/, ""));
  }
  return [...paths].sort();
}

/** Substitute PARAM_SEEDS into a route path; unknown params fail the gate. */
function concretePath(routePath: string): string {
  return routePath.replace(/\$[A-Za-z0-9]+/g, (param) => {
    const seed = PARAM_SEEDS[param];
    if (!seed) {
      throw new Error(
        `axe gate: no PARAM_SEEDS entry for ${param} (route ${routePath}) — ` +
          "seed a fixture id for the new route param",
      );
    }
    return seed;
  });
}

/** Representative data for every family a route can render. */
function seededFake(): HealthCapableFake {
  const api = new HealthCapableFake();
  api.signedIn = {
    scopes: ["read", "write", "admin"],
    tenant: { id: "tnt_01TEST", name: "Acme Corp" },
  };
  api.config = { mode: "team", onboardingEnabled: false };

  api.addSession({
    id: "sess_01GATE",
    title: "fix the login bug",
    status: "idle",
    stopReason: "completed",
    agentId: "agent_01GATE",
    agentVersion: 1,
    environmentId: "env_01GATE",
  });
  api.entries.set("sess_01GATE", [
    {
      seq: 0,
      type: "user.message",
      processedAt: "2026-07-02T10:00:01.000Z",
      content: "Fix the login bug in auth.ts",
    },
    {
      seq: 1,
      type: "agent.tool_use",
      processedAt: "2026-07-02T10:00:02.000Z",
      tool: "bash",
      input: { command: "ls" },
    },
  ]);
  api.outputs.set("sess_01GATE", ["report.md"]);

  api.addAgent({ id: "agent_01GATE", name: "code-reviewer" });
  api.addAgentVersion("agent_01GATE", {
    version: 1,
    config: { model: { provider: "anthropic", id: "claude-sonnet-4" } },
    createdAt: "2026-06-01T00:00:00.000Z",
  });

  api.addJob({ id: "job_01GATE", name: "nightly-cleanup" });
  api.addJobRun("job_01GATE", { id: "jobrun_01GATE" });

  api.addEnvironment({ id: "env_01GATE", name: "cloud-default", type: "cloud" });
  api.addVault({ id: "vault_01GATE", name: "team-secrets" });
  api.addCredential("vault_01GATE", {
    key: "anthropic",
    category: "model_provider_key",
  });
  api.addMemoryStore({ id: "mem_01GATE", displayTitle: "conventions" });
  api.addMemory("mem_01GATE", {
    path: "conventions.md",
    content: "Use absolute imports.",
  });
  api.addFile({ id: "file_01GATE" });
  api.addSkill({ id: "skill_01GATE" });
  api.addApiKey({ id: "apikey_01GATE" });
  api.addWebhook({ id: "wh_01GATE" });
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/**
 * Routes ALLOWED to settle on an error state (none today). Every other
 * route must render real content: a page whose fetch fails renders only an
 * `ErrorAlert`, which is trivially axe-clean — the actual screen would
 * never have been audited. Add a route here only when the gate is
 * deliberately exercising its error surface.
 */
const ERROR_EXPECTED_ROUTES = new Set<string>();

/** ErrorAlert (DP-9) / route-level load-error copy, by its fixed prefix. */
function errorAlertsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="alert"]')]
    .map((el) => el.textContent ?? "")
    .filter((text) => /Failed to load|Could not load/.test(text));
}

describe("§12.2 — every route renders axe-clean", () => {
  const paths = allRoutePaths();

  it("the router registers the expected number of routes (enumeration sanity)", () => {
    // Not a pin on the exact set (routes are free to grow — each new one is
    // axe-gated automatically); just proof the enumeration saw a full tree.
    expect(paths.length).toBeGreaterThanOrEqual(17);
  });

  for (const routePath of paths) {
    it(`${routePath} is axe-clean`, async () => {
      const { queryClient, view } = renderConsole(
        seededFake(),
        `/console${concretePath(routePath)}`,
      );
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
        expect(view.container.textContent).not.toBe("");
      });
      // A route that settled on an error state slipped past the seeded
      // fake (missing fixture, broken fetcher) — its real content was
      // never audited, so the gate fails instead of green-lighting it.
      if (!ERROR_EXPECTED_ROUTES.has(routePath)) {
        expect(
          errorAlertsIn(view.container),
          `${routePath} rendered an error state — the seeded fake must serve ` +
            "this route's data (or the route must be annotated in " +
            "ERROR_EXPECTED_ROUTES as deliberately error-testing)",
        ).toEqual([]);
      }
      expect(await axe(view.container)).toHaveNoViolations();
    });
  }
});

describe("§12.2 — keyboard spot checks on the phase-3 admin surfaces", () => {
  it("agents table: roving tabindex, ArrowDown + Enter activates the row", async () => {
    const api = seededFake();
    api.addAgent({ id: "agent_02GATE", name: "doc-writer" });
    const user = userEvent.setup();
    const { router } = renderConsole(api, "/console/agents");
    const rows = await screen.findAllByRole("row");
    // Header row + 2 body rows; only ONE body row is in the tab order.
    const bodyRows = rows.slice(1);
    expect(bodyRows.map((r) => r.tabIndex)).toEqual([0, -1]);

    bodyRows[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(bodyRows[1]);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/agents/agent_02GATE"),
    );
  });

  it("issue-key dialog: opens focused, Escape closes and returns focus", async () => {
    const user = userEvent.setup();
    renderConsole(seededFake(), "/console/settings/api-keys");
    const trigger = await screen.findByRole("button", { name: "Issue key" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Issue API key",
    });
    // Focus moved into the dialog (focus trap entry, DP-13)…
    expect(dialog.contains(document.activeElement)).toBe(true);
    // …Escape closes it and restores focus to the trigger.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Issue API key" }),
      ).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("archive-agent typed confirmation is keyboard-completable", async () => {
    const user = userEvent.setup();
    renderConsole(seededFake(), "/console/agents/agent_01GATE");
    await screen.findByRole("heading", { name: "code-reviewer" });
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Archive code-reviewer",
    });

    // The DP-7 name-to-confirm input is reachable by Tab alone; typing the
    // name enables the confirm button (disabled until it matches).
    const input = within(dialog).getByLabelText(
      'Type "code-reviewer" to confirm',
    );
    for (let i = 0; i < 10 && document.activeElement !== input; i += 1) {
      await user.keyboard("{Tab}");
    }
    expect(document.activeElement).toBe(input);
    const confirm = within(dialog).getByRole("button", {
      name: "Archive agent",
    });
    expect(confirm).toBeDisabled();
    await user.keyboard("code-reviewer");
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});
