/**
 * Webhooks feature tests (WP-C3.4; console-spec §9.8, journey W13). The API
 * client is a collaborator (fake at the `<ApiClientProvider>` seam); the wire
 * behavior is contract-tested in `src/api/__tests__/`.
 *
 * Proven here: the event-type picker enumerates the contracts enum, the
 * `whsec_` secret exists in the DOM only between registration and the
 * copy-and-confirm Done (DP-8 DOM-absence proof), test-delivery state renders
 * inline, and an auto-disabled endpoint is surfaced prominently with the only
 * re-enable path the API offers (delete + re-register → NEW secret).
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { WebhookEventType } from "@pi-managed/contracts";

import { FakeConsoleApi } from "../../test/fake-console-api.js";
import { renderConsole } from "../../test/render-console.js";
import { axe } from "../../ui/test-utils.js";

/** The obviously-fake signing secret the fake's register response carries. */
const FAKE_SECRET = "whsec_TESTSECRETNOTASECRET";

beforeEach(() => {
  window.localStorage.clear();
});

function fakeWithWebhooks(scopes: string[] = ["admin"]): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(scopes);
  api.addWebhook({
    id: "wh_01ACTIVE",
    url: "https://hooks.example.com/pi-managed",
    eventTypes: ["session.status_idle", "job.run_failed"],
  });
  return api;
}

describe("webhooks list (§9.8, W13)", () => {
  it("renders endpoint, subscribed events, and delivery status", async () => {
    renderConsole(fakeWithWebhooks(), "/console/settings/webhooks");
    const table = await screen.findByRole("table", { name: "Webhooks" });

    const row = within(table).getAllByRole("row")[1]!;
    expect(
      within(row).getByText("https://hooks.example.com/pi-managed"),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("session.status_idle, job.run_failed"),
    ).toBeInTheDocument();
    expect(within(row).getByText("active")).toBeInTheDocument();
    // Never a signing secret in a list read (the DP-6 microcopy mentions the
    // `whsec_` prefix, so the absence proof targets the secret value).
    expect(document.body.textContent).not.toContain(FAKE_SECRET);
  });

  it("surfaces an auto-disabled endpoint prominently, with the delete + re-register path (§9.8)", async () => {
    const api = fakeWithWebhooks();
    api.addWebhook({
      id: "wh_01DEAD",
      url: "https://dead.example.com/hook",
      eventTypes: ["session.status_terminated"],
      status: "disabled",
      disabledReason: "20 consecutive delivery failures",
    });
    renderConsole(api, "/console/settings/webhooks");
    await screen.findByRole("table", { name: "Webhooks" });

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("One endpoint is auto-disabled");
    expect(banner.textContent).toContain("https://dead.example.com/hook");
    expect(banner.textContent).toContain("20 consecutive delivery failures");
    // The re-enable path — the only one the API offers — is stated exactly.
    expect(banner.textContent).toContain(
      "delete the endpoint and register it again",
    );
    expect(banner.textContent).toContain("whsec_");

    // The row itself also shows the state, and its test button explains
    // why it is disabled (§6.1).
    const table = screen.getByRole("table", { name: "Webhooks" });
    const deadRow = within(table).getAllByRole("row")[2]!;
    expect(within(deadRow).getByText("disabled")).toBeInTheDocument();
    const test = within(deadRow).getByRole("button", { name: "Send test" });
    expect(test).toBeDisabled();
    expect(test).toHaveAccessibleDescription(
      "disabled endpoints receive no deliveries",
    );
  });

  it("teaching empty state carries the API command (DP-5)", async () => {
    renderConsole(
      FakeConsoleApi.signedIn(["admin"]),
      "/console/settings/webhooks",
    );
    expect(
      await screen.findByText("No webhook endpoints yet"),
    ).toBeInTheDocument();
    // A WORKING command: bearer + Idempotency-Key + JSON content type — the
    // backend hard-requires all three for POST /v1/webhooks.
    const taught = screen.getByText(/curl -X POST .*\/v1\/webhooks/);
    expect(taught.textContent).toContain("Authorization: Bearer");
    expect(taught.textContent).toContain("Idempotency-Key:");
    expect(taught.textContent).toContain("Content-Type: application/json");
  });

  it("is axe-clean", async () => {
    const { view } = renderConsole(fakeWithWebhooks(), "/console/settings/webhooks");
    await screen.findByRole("table", { name: "Webhooks" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("test delivery (W13: send test before trusting it)", () => {
  it("reports an acknowledged delivery inline", async () => {
    const user = userEvent.setup();
    const api = fakeWithWebhooks();
    renderConsole(api, "/console/settings/webhooks");
    const table = await screen.findByRole("table", { name: "Webhooks" });

    await user.click(
      within(table).getByRole("button", { name: "Send test" }),
    );
    expect(await screen.findByText("delivered (HTTP 200)")).toBeInTheDocument();
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/webhooks/wh_01ACTIVE/test",
      body: {},
    });
  });

  it("reports a refused delivery with the response code", async () => {
    const user = userEvent.setup();
    const api = fakeWithWebhooks();
    api.webhookTestResult = { delivered: false, responseCode: 503 };
    renderConsole(api, "/console/settings/webhooks");
    const table = await screen.findByRole("table", { name: "Webhooks" });

    await user.click(within(table).getByRole("button", { name: "Send test" }));
    expect(
      await screen.findByText("not delivered (HTTP 503)"),
    ).toBeInTheDocument();
  });
});

describe("register flow (§9.8: event-type picker, show-once whsec_)", () => {
  it("enumerates every contracts event type in the picker", async () => {
    const user = userEvent.setup();
    renderConsole(fakeWithWebhooks(), "/console/settings/webhooks");
    await screen.findByRole("table", { name: "Webhooks" });

    await user.click(screen.getByRole("button", { name: "Register endpoint" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Register webhook endpoint",
    });
    const checkboxes = within(dialog).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(WebhookEventType.options.length);
    for (const type of WebhookEventType.options) {
      expect(
        within(dialog).getByRole("checkbox", { name: type }),
      ).not.toBeChecked();
    }
  });

  it("registers, reveals the whsec_ secret exactly once, and forgets it after copy-and-confirm (DP-8 DOM-absence)", async () => {
    const user = userEvent.setup();
    const api = fakeWithWebhooks();
    renderConsole(api, "/console/settings/webhooks");
    await screen.findByRole("table", { name: "Webhooks" });

    await user.click(screen.getByRole("button", { name: "Register endpoint" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Register webhook endpoint",
    });

    // Submit is gated with a reason until URL + at least one event type.
    const submit = within(dialog).getByRole("button", { name: "Register" });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription("enter the endpoint URL");

    await user.type(
      within(dialog).getByLabelText("Endpoint URL"),
      "https://new.example.com/hook",
    );
    expect(submit).toHaveAccessibleDescription(
      "select at least one event type",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "session.status_idle" }),
    );
    await user.click(submit);

    // The signing secret renders once, in the reveal.
    expect(await screen.findByText(FAKE_SECRET)).toBeInTheDocument();
    expect(api.calls).toContainEqual({
      method: "POST",
      path: "/v1/webhooks",
      body: {
        url: "https://new.example.com/hook",
        eventTypes: ["session.status_idle"],
      },
    });

    // Copy-and-confirm gates Done; afterwards the secret exists nowhere.
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I have stored this signing secret/,
      }),
    );
    await user.click(done);

    const table = await screen.findByRole("table", { name: "Webhooks" });
    expect(
      await within(table).findByText("https://new.example.com/hook"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FAKE_SECRET);
  });
});

describe("delete (DP-7)", () => {
  it("typed confirmation names the consequences — secret discarded, re-register mints a NEW one", async () => {
    const user = userEvent.setup();
    const api = fakeWithWebhooks();
    renderConsole(api, "/console/settings/webhooks");
    const table = await screen.findByRole("table", { name: "Webhooks" });

    await user.click(within(table).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete webhook endpoint",
    });
    expect(dialog.textContent).toContain("signing secret is discarded");
    expect(dialog.textContent).toContain("NEW signing secret");

    const confirm = within(dialog).getByRole("button", {
      name: "Delete endpoint",
    });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type "hooks.example.com" to confirm'),
      "hooks.example.com",
    );
    await user.click(confirm);

    expect(api.calls).toContainEqual({
      method: "DELETE",
      path: "/v1/webhooks/wh_01ACTIVE",
    });
    expect(
      await screen.findByText("No webhook endpoints yet"),
    ).toBeInTheDocument();
  });

  it("read-only keys see register/delete/send-test disabled with the reason (§6.1)", async () => {
    renderConsole(fakeWithWebhooks(["read"]), "/console/settings/webhooks");
    await screen.findByRole("table", { name: "Webhooks" });

    const register = screen.getByRole("button", { name: "Register endpoint" });
    expect(register).toBeDisabled();
    // §6.2: the reason names the scope the backend ACTUALLY requires.
    expect(register).toHaveAccessibleDescription("requires the write scope");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    // Send-test is a mutation like the rest (POST /v1/webhooks/:id/test).
    const test = screen.getByRole("button", { name: "Send test" });
    expect(test).toBeDisabled();
    expect(test).toHaveAccessibleDescription("requires the write scope");
  });

  it("write scope: register/delete/send-test are enabled (§6.2 — write, not admin)", async () => {
    renderConsole(
      fakeWithWebhooks(["read", "write"]),
      "/console/settings/webhooks",
    );
    await screen.findByRole("table", { name: "Webhooks" });
    expect(
      screen.getByRole("button", { name: "Register endpoint" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send test" })).toBeEnabled();
  });
});
