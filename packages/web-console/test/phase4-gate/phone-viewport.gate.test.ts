/**
 * Phase-4 gate — console-spec §10.5, the DOM + JS half of the W5 phone
 * story.
 *
 * **Honesty note (what this file does NOT claim).** jsdom applies no
 * stylesheet cascade and computes no layout, and no production code reads
 * `window.innerWidth` — phone visibility is pure CSS. An earlier revision
 * faked a 375-px window here; every assertion passed identically at desktop
 * width, so the fake was theater and is gone. Nothing in this file renders
 * "at" any viewport. What it honestly proves, width-independent:
 *
 *  - **Drawer chrome (the JS half of the §10.5 collapse):** the Menu
 *    disclosure (`aria-expanded`/`aria-controls`) toggles the drawer
 *    element's `drawerOpen` CSS-module class — the same local class the
 *    shipped 720-px rules target (`responsive-css.gate.test.ts` proves
 *    those rules exist in the built CSS) — and following a nav link closes
 *    it again.
 *  - **W5 flow wiring:** session → Conversation tab → composer send puts
 *    `user.message` on the wire with the honest §10.1 waking note, and the
 *    surface is axe-clean.
 *  - **DOM-structural overflow half:** no element carries an inline fixed
 *    width past the 375-px phone budget, and every data table sits inside
 *    its focusable scroll container (the §10.5 mechanism that keeps the
 *    page from scrolling sideways).
 *
 * What it cannot prove: that the phone media queries exist and ship (static
 * scans in `responsive-css.gate.test.ts` + `no-pwa.gate.test.ts`) or real
 * reflow at 375 px (the manual check in this gate's README).
 *
 * The API client is a collaborator (fake at the `<ApiClientProvider>`
 * seam); the rendered tree is the real app.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import shellStyles from "../../src/app/shell.module.css";
import { FakeConsoleApi } from "../../src/test/fake-console-api.js";
import { renderConsole } from "../../src/test/render-console.js";
import { axe } from "../../src/ui/test-utils.js";

const SESSION = "sess_01PHONE";
const EVENTS_PATH = `/v1/sessions/${SESSION}/events`;

/** The §10.5 phone budget inline styles are scanned against (px). */
const PHONE_VIEWPORT_PX = 375;

/** Write-scoped fake with an idle session carrying one turn's messages. */
function seededFake(): FakeConsoleApi {
  const api = FakeConsoleApi.signedIn(["read", "write"]);
  api.addSession({ id: SESSION, title: "phone continue", status: "idle" });
  api.messages.set(SESSION, [
    { role: "user", content: "Fix the login bug" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Patched auth.ts — tests pass." }],
    },
  ]);
  return api;
}

/** Inline `width:`/`min-width:` styles wider than the phone budget. */
function inlineOverflowOffenders(root: HTMLElement): string[] {
  const offenders: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[style]")) {
    for (const prop of ["width", "min-width"] as const) {
      const value = el.style.getPropertyValue(prop);
      const px = /^([0-9.]+)px$/.exec(value);
      if (px && Number(px[1]) > PHONE_VIEWPORT_PX) {
        offenders.push(`<${el.tagName.toLowerCase()}> ${prop}: ${value}`);
      }
    }
  }
  return offenders;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("§10.5 — W5 drawer chrome + flow wiring (DOM/JS half; jsdom applies no CSS)", () => {
  it("Menu disclosure toggles aria-expanded AND the drawerOpen module class; navigating closes it", async () => {
    const user = userEvent.setup();
    renderConsole(seededFake());
    await screen.findByRole("navigation", { name: "Primary" });

    // The disclosure logic is JS and honestly assertable here. That the
    // class flip VISUALLY collapses/opens anything is CSS — pinned as a
    // built-CSS rule targeting this same `drawerOpen` local in
    // responsive-css.gate.test.ts.
    const toggle = screen.getByRole("button", { name: "Menu" });
    const drawer = document.getElementById("shell-drawer");
    expect(drawer).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-controls", "shell-drawer");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(drawer!.classList.contains(shellStyles["drawerOpen"]!)).toBe(false);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(drawer!.classList.contains(shellStyles["drawerOpen"]!)).toBe(true);

    // W5 step 1: Sessions from the drawer; the drawer closes behind it.
    await user.click(screen.getByRole("link", { name: /Sessions/ }));
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    );
    expect(drawer!.classList.contains(shellStyles["drawerOpen"]!)).toBe(false);
    await screen.findByRole("table", { name: /sessions/i });
  });

  it("W5 steps 1–2: session → Conversation tab → composer sends (wiring, not layout)", async () => {
    const api = seededFake();
    const user = userEvent.setup();
    const { view } = renderConsole(api, `/console/sessions/${SESSION}`);

    // The session page is up; open the Conversation lens.
    await screen.findByRole("tablist", { name: "Session detail" });
    await user.click(screen.getByRole("tab", { name: "Conversation" }));

    // The transcript renders (seed from /messages)…
    const list = await screen.findByRole("list", { name: "Conversation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    // …and the composer is usable: type + Send → user.message on the wire,
    // with the honest §10.1 waking note (202 ≠ reply). Scoped to the §10.2
    // composer section — the W4 steering panel above the tabs also sends.
    const composer = within(screen.getByRole("region", { name: "Composer" }));
    await user.type(
      composer.getByLabelText("Message"),
      "ship it from the phone",
    );
    await user.click(composer.getByRole("button", { name: "Send" }));
    await screen.findByText(/Message accepted — waking the session/);
    const sent = api.calls.filter(
      (c) => c.method === "POST" && c.path === EVENTS_PATH,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      type: "user.message",
      content: "ship it from the phone",
    });

    // Nothing on the W5 screen forces an inline width past the phone budget.
    expect(inlineOverflowOffenders(view.container)).toEqual([]);

    // The W5 surface (drawer chrome + conversation + composer) is axe-clean
    // as rendered.
    expect(await axe(view.container)).toHaveNoViolations();
  });
});

describe("§10.5 — DOM-structural overflow smoke on the key routes", () => {
  // The routes W1–W5 walk; deeper admin screens are covered by the same
  // Table primitive + the static CSS scans (responsive-css.gate.test.ts,
  // no-pwa.gate.test.ts).
  const ROUTES = ["/", "/sessions", `/sessions/${SESSION}`, "/agents", "/jobs"];

  for (const route of ROUTES) {
    it(`${route}: no inline fixed widths > ${PHONE_VIEWPORT_PX}px; tables scroll in their own container`, async () => {
      const api = seededFake();
      const { queryClient, view } = renderConsole(api, `/console${route}`);
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
        expect(view.container.textContent).not.toBe("");
      });

      expect(inlineOverflowOffenders(view.container)).toEqual([]);

      // Every data table rides inside the §10.5 focusable scroll container
      // — the page body itself never scrolls horizontally.
      for (const table of view.container.querySelectorAll("table")) {
        const wrapper = table.parentElement;
        expect(wrapper?.getAttribute("role")).toBe("group");
        expect(wrapper?.getAttribute("tabindex")).toBe("0");
      }
    });
  }
});
