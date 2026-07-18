/**
 * Signup + first-run feature tests (WP-C3.7; console-spec §5.3/§9.6, W8,
 * DP-12): mode gating (incl. onboardingEnabled=false), the W8 happy path —
 * form → key shown exactly once behind copy-and-confirm → auto sign-in →
 * checklist — the repeat-signup no-key case, checklist step completion
 * transitions with deep links, dismissal, and the mode-gated sign-in link.
 * The API client is a collaborator (fake at the `<ApiClientProvider>` seam).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

/** Obviously fake (C§13: no real-looking credential in any fixture). */
const RAW_KEY = "pmb_live_TESTSIGNUPKEYNOTASECRET";

function saasFake(): FakeConsoleApi {
  const api = new FakeConsoleApi();
  api.config = { mode: "saas", onboardingEnabled: true };
  return api;
}

/** First sign-up: the fake issues RAW_KEY once and accepts it for sign-in. */
function withIssuedKey(api: FakeConsoleApi): FakeConsoleApi {
  api.signupResult = {
    ...api.signupResult,
    apiKey: {
      id: "apikey_01SIGNUPADMIN",
      name: "tenant-admin",
      key: RAW_KEY,
      scopes: ["admin"],
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  };
  api.acceptKey(RAW_KEY, ["admin"]);
  return api;
}

function signedInSaas(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["admin"]);
  api.config = { mode: "saas", onboardingEnabled: true };
  return api;
}

/** Completes checklist step 1: an active model_provider_key credential. */
function seedModelKey(api: FakeConsoleApi): void {
  api.addVault({ id: "vault_01MAIN" });
  api.addCredential("vault_01MAIN", {
    key: "anthropic",
    category: "model_provider_key",
  });
}

describe("/signup mode gating (§5.3, §9.6)", () => {
  it("renders gated-off outside saas without asking for the console session", async () => {
    const api = new FakeConsoleApi(); // signed out; solo mode by default
    renderConsole(api, "/console/signup");
    await screen.findByRole("heading", { name: "Sign up" });
    expect(
      screen.getByText(/Self-service sign-up is not enabled/),
    ).toBeInTheDocument();
    // The gated-off page is fully public — it never even asks for a session.
    expect(
      api.calls.filter((c) => c.path === "/console/session"),
    ).toHaveLength(0);
  });

  it("renders gated-off in saas mode when onboarding is DISABLED", async () => {
    const api = new FakeConsoleApi();
    api.config = { mode: "saas", onboardingEnabled: false };
    renderConsole(api, "/console/signup");
    await screen.findByRole("heading", { name: "Sign up" });
    expect(
      screen.getByText(/Self-service sign-up is not enabled/),
    ).toBeInTheDocument();
  });

  it("renders the signup form signed-out in saas mode with onboarding enabled", async () => {
    renderConsole(saasFake(), "/console/signup");
    expect(
      await screen.findByRole("button", { name: "Create tenant" }),
    ).toBeInTheDocument();
    // §9.6: MUST NOT ask for payment details — the form is exactly tenant
    // name + admin email.
    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(2);
    expect(screen.getByLabelText("Tenant name")).toBeInTheDocument();
    expect(screen.getByLabelText("Admin email")).toBeInTheDocument();
  });
});

describe("W8 signup flow: key shown once, copy-and-confirm", () => {
  async function submitSignup(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Tenant name"), "Acme Corp");
    await user.type(screen.getByLabelText("Admin email"), "admin@acme.test");
    await user.click(screen.getByRole("button", { name: "Create tenant" }));
  }

  it("cannot proceed without confirming; the disabled reason is visible (§6.1)", async () => {
    const user = userEvent.setup();
    renderConsole(withIssuedKey(saasFake()), "/console/signup");
    await screen.findByLabelText("Tenant name");
    await submitSignup(user);

    // The key is on screen, once, with a copy affordance.
    expect(await screen.findByText(RAW_KEY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy admin API key" }),
    ).toBeInTheDocument();

    const cont = screen.getByRole("button", { name: "Continue to the console" });
    expect(cont).toBeDisabled();
    expect(
      screen.getByText(/Confirm you stored the key to continue/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("checkbox", {
        name: /I copied the key and stored it somewhere safe/,
      }),
    );
    expect(cont).toBeEnabled();
  });

  it("confirming signs in via the real session flow and lands on the checklist; the key is gone (§9.6)", async () => {
    const user = userEvent.setup();
    const api = withIssuedKey(saasFake());
    renderConsole(api, "/console/signup");
    await screen.findByLabelText("Tenant name");
    await submitSignup(user);
    await screen.findByText(RAW_KEY);

    await user.click(
      screen.getByRole("checkbox", {
        name: /I copied the key and stored it somewhere safe/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Continue to the console" }),
    );

    // Auto sign-in exchanged the NEW key through POST /console/session (W8).
    await screen.findByRole("list", { name: "First-run checklist" });
    const signIns = api.calls.filter(
      (c) => c.method === "POST" && c.path === "/console/session",
    );
    expect(signIns).toHaveLength(1);
    expect(signIns[0]!.body).toEqual({ apiKey: RAW_KEY });

    // Shown EXACTLY once: after continuing, the raw key is nowhere in the DOM.
    expect(screen.queryByText(RAW_KEY)).not.toBeInTheDocument();
  });

  it("never mentions credits or trials before phase 5 (§9.6)", async () => {
    const user = userEvent.setup();
    renderConsole(withIssuedKey(saasFake()), "/console/signup");
    await screen.findByLabelText("Tenant name");
    expect(document.body.textContent).not.toMatch(/trial|credit/i);
    await submitSignup(user);
    await screen.findByText(RAW_KEY);
    expect(document.body.textContent).not.toMatch(/trial|credit/i);
  });

  it("repeat sign-up (no key in the response) renders the check-with-your-admin case", async () => {
    const user = userEvent.setup();
    renderConsole(saasFake(), "/console/signup"); // default result has NO apiKey
    await screen.findByLabelText("Tenant name");
    await submitSignup(user);
    await screen.findByRole("heading", {
      name: "This email is already signed up",
    });
    expect(screen.getByText(/no new key was issued/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue to the console" }),
    ).not.toBeInTheDocument();
  });
});

describe("first-run checklist (DP-12, W8 §2)", () => {
  it("shows all steps to-do on a fresh tenant, with deep links to the real surfaces", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(signedInSaas(), "/console/signup");
    const list = await screen.findByRole("list", {
      name: "First-run checklist",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(within(item).getByText("To do")).toBeInTheDocument();
    }
    expect(screen.getByText("0 of 3 steps done")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open vaults" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open sessions" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Open agents" }));
    expect(router.state.location.pathname).toBe("/agents");
  });

  it("marks steps done as the real APIs report progress", async () => {
    const api = signedInSaas();
    seedModelKey(api);
    api.addAgent({ id: "agent_01FIRST", name: "reviewer" });
    renderConsole(api, "/console/signup");

    const list = await screen.findByRole("list", {
      name: "First-run checklist",
    });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0]!).getByText("Done")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Done")).toBeInTheDocument();
    expect(within(items[2]!).getByText("To do")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 steps done")).toBeInTheDocument();
    // Completed steps drop their deep link; the remaining one keeps it.
    expect(
      screen.queryByRole("link", { name: "Open vaults" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open sessions" }),
    ).toBeInTheDocument();
  });

  it("an archived model key does not count (fail-closed, DP-6)", async () => {
    const api = signedInSaas();
    api.addVault({ id: "vault_01MAIN" });
    api.addCredential("vault_01MAIN", {
      key: "anthropic",
      category: "model_provider_key",
      status: "archived",
    });
    renderConsole(api, "/console/signup");
    const list = await screen.findByRole("list", {
      name: "First-run checklist",
    });
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(within(first).getByText("To do")).toBeInTheDocument();
  });

  it("completes into the all-set state once every step is detected", async () => {
    const api = signedInSaas();
    seedModelKey(api);
    api.addAgent({ id: "agent_01FIRST", name: "reviewer" });
    api.addSession({ id: "sess_01FIRST" });
    renderConsole(api, "/console/signup");
    await screen.findByRole("heading", { name: "You're all set" });
    expect(screen.getByText("3 of 3 steps done")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Go to the console" }),
    ).toBeInTheDocument();
  });

  it("is dismissible: Skip for now navigates home (still reachable at /signup)", async () => {
    const user = userEvent.setup();
    const { router } = renderConsole(signedInSaas(), "/console/signup");
    await screen.findByRole("list", { name: "First-run checklist" });
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("sign-in page signup link (§5.3)", () => {
  it("offers Create a tenant only in saas mode with onboarding enabled", async () => {
    const user = userEvent.setup();
    renderConsole(saasFake(), "/console/");
    await screen.findByRole("heading", { name: "Pi Console" });
    await user.click(screen.getByRole("link", { name: "Create a tenant" }));
    expect(
      await screen.findByRole("button", { name: "Create tenant" }),
    ).toBeInTheDocument();
  });

  it("is absent outside saas mode", async () => {
    renderConsole(new FakeConsoleApi(), "/console/"); // solo
    await screen.findByRole("heading", { name: "Pi Console" });
    expect(
      screen.queryByRole("link", { name: "Create a tenant" }),
    ).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("signup form is axe-clean", async () => {
    const { view } = renderConsole(saasFake(), "/console/signup");
    await screen.findByLabelText("Tenant name");
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("key-once screen is axe-clean", async () => {
    const user = userEvent.setup();
    const { view } = renderConsole(withIssuedKey(saasFake()), "/console/signup");
    await screen.findByLabelText("Tenant name");
    await user.type(screen.getByLabelText("Tenant name"), "Acme Corp");
    await user.type(screen.getByLabelText("Admin email"), "admin@acme.test");
    await user.click(screen.getByRole("button", { name: "Create tenant" }));
    await screen.findByText(RAW_KEY);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("checklist is axe-clean", async () => {
    const { view } = renderConsole(signedInSaas(), "/console/signup");
    await screen.findByRole("list", { name: "First-run checklist" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
