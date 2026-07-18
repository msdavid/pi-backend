/**
 * Phase-3 gate — console-spec §13 item §9.3: no secret value appears in any
 * response fixture or DOM snapshot.
 *
 * Two halves:
 *
 * 1. DOM flows — the four places a secret legitimately touches the console
 *    (vault credential add [request-side, write-only], API-key issue,
 *    webhook register, saas signup [response-side, shown once]) are driven
 *    end-to-end on the real app tree with sentinel values, and after each
 *    flow completes the ENTIRE document (`innerHTML` + retained input
 *    values) is asserted free of the sentinel. The per-feature suites prove
 *    the same during development; this gate keeps it a release item.
 *
 * 2. Static fixture scan — every secret-shaped literal (`pmb_live_…`,
 *    `whsec_…`, `sk-…`) anywhere in the package sources must be obviously
 *    fake: either self-describing (TEST/NOTASECRET/placeholder) or one of
 *    the pinned request-side sentinels whose own suites assert they never
 *    persist (`key-storage.gate.test.ts`). A real-looking credential in a
 *    fixture fails the gate.
 */
import { relative } from "node:path";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import "../../src/ui/test-utils.js"; // afterEach(cleanup)
import { pkgRoot, readText, stripComments, walkFiles } from "../phase1-gate/helpers.js";

/** Obviously fake (this very gate enforces that property). */
const TYPED_SECRET = "sk-TESTGATESENTINELNOTASECRET";
/** What the fake's create responses reveal exactly once (fakes/settings.ts). */
const ISSUED_KEY = "pmb_live_TESTISSUEDKEYNOTASECRET";
const SIGNING_SECRET = "whsec_TESTSECRETNOTASECRET";
const SIGNUP_KEY = "pmb_live_TESTSIGNUPKEYNOTASECRET";

/** The whole document — rendered text, attributes, AND live input values. */
function documentHolds(sentinel: string): boolean {
  if (document.body.innerHTML.includes(sentinel)) return true;
  return [...document.querySelectorAll("input, textarea")].some(
    (el) => (el as HTMLInputElement).value.includes(sentinel),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§9.3 — no secret survives its flow in the DOM", () => {
  it("vault credential: the typed secret is gone after submit", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read", "write", "admin"]);
    api.addVault({ id: "vault_01GATE", name: "team-secrets" });
    renderConsole(api, "/console/resources/vaults/vault_01GATE");

    const section = await screen.findByRole("region", {
      name: "Model provider keys",
    });
    await user.click(within(section).getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Add: Model provider keys",
    });
    await user.type(within(dialog).getByLabelText("Provider id"), "anthropic");
    await user.type(within(dialog).getByLabelText("API key"), TYPED_SECRET);
    await user.click(
      within(dialog).getByRole("button", { name: "Add credential" }),
    );
    await within(section).findByText("anthropic");

    expect(documentHolds(TYPED_SECRET)).toBe(false);
    // Response-fixture half: the stored credential records carry no secret.
    expect(JSON.stringify([...api.credentials.values()])).not.toContain(
      TYPED_SECRET,
    );
  });

  it("API-key issue: the revealed key is gone after copy-and-confirm", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read", "write", "admin"]);
    renderConsole(api, "/console/settings/api-keys");

    await user.click(
      await screen.findByRole("button", { name: "Issue key" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Issue API key" });
    await user.type(within(dialog).getByLabelText("Name"), "gate-key");
    await user.click(within(dialog).getByRole("button", { name: "Issue key" }));

    // Shown exactly once…
    expect(await screen.findByText(ISSUED_KEY)).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: /I have stored this API key/ }),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    // …then nowhere: not in the DOM, not in the stored key records.
    await within(
      await screen.findByRole("table", { name: "API keys" }),
    ).findByText("gate-key");
    expect(documentHolds(ISSUED_KEY)).toBe(false);
    expect(JSON.stringify(api.apiKeys)).not.toContain(ISSUED_KEY);
  });

  it("webhook register: the whsec_ secret is gone after copy-and-confirm", async () => {
    const user = userEvent.setup();
    const api = FakeConsoleApi.signedIn(["read", "write", "admin"]);
    renderConsole(api, "/console/settings/webhooks");

    await user.click(
      await screen.findByRole("button", { name: "Register endpoint" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Register webhook endpoint",
    });
    await user.type(
      within(dialog).getByLabelText("Endpoint URL"),
      "https://gate.example.com/hook",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "session.status_idle" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Register" }));

    expect(await screen.findByText(SIGNING_SECRET)).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: /I have stored this signing secret/ }),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));

    await within(
      await screen.findByRole("table", { name: "Webhooks" }),
    ).findByText("https://gate.example.com/hook");
    expect(documentHolds(SIGNING_SECRET)).toBe(false);
    expect(JSON.stringify(api.webhooks)).not.toContain(SIGNING_SECRET);
  });

  it("saas signup: the admin key is gone after continue (shown exactly once)", async () => {
    const user = userEvent.setup();
    const api = new FakeConsoleApi();
    api.config = { mode: "saas", onboardingEnabled: true };
    api.signupResult = {
      ...api.signupResult,
      apiKey: {
        id: "apikey_01GATESIGNUP",
        name: "tenant-admin",
        key: SIGNUP_KEY,
        scopes: ["admin"],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    };
    api.acceptKey(SIGNUP_KEY, ["admin"]);
    renderConsole(api, "/console/signup");

    await user.type(
      await screen.findByLabelText("Tenant name"),
      "Gate Corp",
    );
    await user.type(screen.getByLabelText("Admin email"), "admin@gate.test");
    await user.click(screen.getByRole("button", { name: "Create tenant" }));

    expect(await screen.findByText(SIGNUP_KEY)).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I copied the key and stored it somewhere safe/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Continue to the console" }),
    );

    await screen.findByRole("list", { name: "First-run checklist" });
    expect(documentHolds(SIGNUP_KEY)).toBe(false);
  });
});

describe("§9.3 — static scan: every secret-shaped literal is obviously fake", () => {
  /**
   * Request-side sentinels pinned by name: they LOOK meaningful on purpose
   * (the §4.1 key-storage gate types them into the sign-in form and then
   * proves no storage retains them), so they cannot self-describe as fake.
   */
  const PINNED_SENTINELS = new Set([
    "pmb_live_supersecretkeymaterial", // sign-in tests + key-storage gate
    "pmb_live_gate41supersecretkeymaterial", // key-storage gate (§4.1)
    "pmb_live_valid", // auth-flow tests
    "pmb_live_nope", // auth-flow tests (rejected key)
  ]);

  function obviouslyFake(literal: string): boolean {
    if (PINNED_SENTINELS.has(literal)) return true;
    return /TEST|NOTASECRET|not-a-secret|placeholder|example/i.test(literal);
  }

  it("src/ and test/ carry no real-looking pmb_live_/whsec_/sk- literal", () => {
    const offenders: string[] = [];
    const files = [
      ...walkFiles(`${pkgRoot}/src`),
      ...walkFiles(`${pkgRoot}/test`),
    ].filter((f) => /\.(ts|tsx)$/.test(f));
    for (const file of files) {
      const code = stripComments(readText(file));
      for (const m of code.matchAll(
        /\b(?:pmb_live_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|sk-[A-Za-z0-9_]{6,})\b/g,
      )) {
        if (!obviouslyFake(m[0])) {
          offenders.push(`${relative(pkgRoot, file)}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
