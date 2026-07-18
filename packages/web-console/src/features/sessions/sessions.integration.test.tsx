/**
 * Integration-flavored feature test (WP-C1.7 acceptance): the sessions read
 * surface rendered as the REAL app tree over the REAL backend — real
 * Postgres (testcontainer), real Fastify app on an ephemeral port, real
 * global `fetch`, real console-session cookie (console-spec §4) — with
 * sessions seeded through the public API exactly like
 * `src/api/__tests__/contract.test.ts` does (the backend exposes no
 * session-seeding domain factory beyond tenant/api-key; `POST /v1/sessions`
 * IS the seeding path).
 *
 * The only substitution is the client *instance*: `renderConsole` injects a
 * `ConsoleApiClient` pointed at the backend's base URL and carrying the
 * signed-in cookie header (an init override, not a transport fake — jsdom's
 * document is not same-origin with the ephemeral port, so the cookie rides
 * an explicit header exactly as in `console-session.contract.test.ts`).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, Environment, Session } from "@pi-managed/contracts";

import { ConsoleApiClient } from "../../api/client.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "../../api/__tests__/harness.js";
import { renderConsole } from "../../test/render-console.js";
import "../../ui/test-utils.js"; // afterEach(cleanup)

const RUNTIME = requireContainers("web-console sessions read integration suite");

describe.skipIf(!RUNTIME)("sessions read surface ↔ real backend", () => {
  let backend: TestBackend;
  /** The app's client: cookie console session against the real backend. */
  let cookieClient: ConsoleApiClient;
  let seeded: Session;

  beforeAll(async () => {
    backend = await startTestBackend();

    // Seed through the public API (admin bearer key).
    const admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    const agent = await admin.post(
      "/v1/agents",
      {
        name: "console-read-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      Agent,
    );
    const env = await admin.post(
      "/v1/environments",
      { name: "console-read-env", type: "cloud" },
      Environment,
    );
    seeded = await admin.post(
      "/v1/sessions",
      { agent: agent.id, environmentId: env.id, title: "integration session" },
      Session,
    );

    // Real sign-in: exchange the read key for the console-session cookie.
    const res = await new ConsoleApiClient({
      baseUrl: backend.baseUrl,
    }).request("POST", "/console/session", {
      body: { apiKey: backend.readKey },
    });
    const setCookie = res.headers
      .getSetCookie()
      .find((c) => /httponly/i.test(c));
    if (!setCookie) throw new Error("no console-session cookie issued");
    cookieClient = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: setCookie.split(";")[0]! },
    });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it(
    "W2 end-to-end: list → detail header facts → Usage tab, all over the real wire",
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      renderConsole(cookieClient, "/console/sessions");

      // The signed-in shell booted from GET /console/session (read scope).
      expect(await screen.findByText("browsing read-only")).toBeInTheDocument();

      // List: the seeded session with its real columns.
      const table = await screen.findByRole("table", { name: "Sessions" });
      const row = within(table)
        .getByText("integration session")
        .closest("tr")!;
      expect(within(row).getByTitle(seeded.id)).toBeInTheDocument();
      expect(within(row).getByText("idle")).toBeInTheDocument();
      expect(within(row).getByText("@v1")).toBeInTheDocument();

      // Detail: DP-1 facts from GET /v1/sessions/:id (+ cost from …/usage).
      await user.click(within(row).getByText("integration session"));
      expect(
        await screen.findByRole("heading", { name: "integration session" }),
      ).toBeInTheDocument();
      expect(await screen.findByText("$0.0000")).toBeInTheDocument();

      // Trace: a fresh session has no entries yet (real …/entries read).
      expect(await screen.findByText(/No events yet/)).toBeInTheDocument();

      // Usage tab: real GET /v1/sessions/:id/usage.
      await user.click(screen.getByRole("tab", { name: "Usage" }));
      const panel = screen.getByRole("tabpanel");
      expect(
        await within(panel).findByText("USD cost"),
      ).toBeInTheDocument();
      expect(within(panel).getByText("$0.0000")).toBeInTheDocument();
    },
  );
});
