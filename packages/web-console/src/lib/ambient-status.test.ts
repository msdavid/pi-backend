/**
 * WP-C2.5 (console-spec §8.3, DP-11): status → title/favicon mapping and the
 * page-default capture/restore cycle. jsdom covers the DOM wiring; whether a
 * browser actually repaints the tab icon is checked manually (noted in the
 * WP report).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ambientFavicon,
  ambientStatusOf,
  ambientTitle,
  applyAmbientStatus,
  restoreAmbientDefaults,
  type AmbientStatus,
} from "./ambient-status.js";

const AMBIENT_STATUSES: AmbientStatus[] = [
  "running",
  "completed",
  "failed",
  "requires_action",
];

afterEach(() => {
  restoreAmbientDefaults();
  document.querySelector('link[rel="icon"]')?.remove();
  document.title = "";
});

describe("ambientStatusOf", () => {
  it("a live status is 'running', whatever the last stop reason", () => {
    expect(ambientStatusOf({ status: "running", stopReason: null })).toBe(
      "running",
    );
    expect(
      ambientStatusOf({ status: "rescheduling", stopReason: "error" }),
    ).toBe("running");
  });

  it("otherwise the stop reason decides; 'error' reads as 'failed'", () => {
    expect(
      ambientStatusOf({ status: "idle", stopReason: "requires_action" }),
    ).toBe("requires_action");
    expect(ambientStatusOf({ status: "idle", stopReason: "completed" })).toBe(
      "completed",
    );
    expect(
      ambientStatusOf({ status: "terminated", stopReason: "completed" }),
    ).toBe("completed");
    expect(ambientStatusOf({ status: "idle", stopReason: "error" })).toBe(
      "failed",
    );
    expect(
      ambientStatusOf({ status: "terminated", stopReason: "error" }),
    ).toBe("failed");
  });

  it("everything outside the DP-11 four maps to null (page defaults)", () => {
    expect(ambientStatusOf({ status: "idle", stopReason: null })).toBeNull();
    expect(
      ambientStatusOf({ status: "idle", stopReason: "budget_exhausted" }),
    ).toBeNull();
    expect(
      ambientStatusOf({ status: "terminated", stopReason: "user_interrupt" }),
    ).toBeNull();
  });
});

describe("ambientTitle", () => {
  it("prefixes the verbatim status token to the base title", () => {
    expect(ambientTitle("running", "Pi Console")).toBe("running — Pi Console");
    expect(ambientTitle("requires_action", "Pi Console")).toBe(
      "requires_action — Pi Console",
    );
  });
});

describe("ambientFavicon", () => {
  it("every status yields a distinct self-contained SVG data: URI", () => {
    const uris = AMBIENT_STATUSES.map((status) => ambientFavicon(status));
    for (const uri of uris) {
      expect(uri).toMatch(/^data:image\/svg\+xml,/);
      expect(decodeURIComponent(uri.split(",")[1]!)).toContain("<svg");
    }
    expect(new Set(uris).size).toBe(AMBIENT_STATUSES.length);
  });

  // Pin the DP-13 shape+color semantics per status against LITERAL expected
  // values (#4459d4 is the tokens.css --color-accent; #d4a72c its
  // --status-warning-fg; the green/red are fixed mid-tones of the
  // success/danger chip colors, legible on light and dark tab strips) —
  // swapping two glyphs or two colors between statuses must fail here, so
  // no re-reading the implementation's palette constants.
  const svgOf = (status: AmbientStatus): string =>
    decodeURIComponent(
      ambientFavicon(status).slice("data:image/svg+xml,".length),
    );

  it("running: a blue dot (the accent color)", () => {
    const svg = svgOf("running");
    expect(svg).toContain('<circle cx="8" cy="8" r="6" fill="#4459d4"/>');
    expect(svg).not.toContain("<path");
  });

  it("completed: a green check mark", () => {
    const svg = svgOf("completed");
    expect(svg).toContain('d="M3.5 8.5l3 3L12.5 5"'); // the check stroke
    expect(svg).toContain('stroke="#2f9e57"');
  });

  it("failed: a red cross", () => {
    const svg = svgOf("failed");
    expect(svg).toContain('d="M4.5 4.5l7 7m0-7l-7 7"'); // the X stroke
    expect(svg).toContain('stroke="#d8433c"');
  });

  it("requires_action: an amber exclamation mark", () => {
    const svg = svgOf("requires_action");
    expect(svg).toContain('d="M8 2v7.5"'); // the exclamation bar …
    expect(svg).toContain('stroke="#d4a72c"');
    expect(svg).toContain('<circle cx="8" cy="13.5" r="1.75" fill="#d4a72c"/>'); // … and its dot
  });
});

describe("apply / restore", () => {
  it("apply stamps the title and creates the favicon link when absent", () => {
    document.title = "Pi Console";
    applyAmbientStatus("running");
    expect(document.title).toBe("running — Pi Console");
    expect(
      document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    ).toBe(ambientFavicon("running"));
  });

  it("a second apply replaces, never stacks, the status prefix", () => {
    document.title = "Pi Console";
    applyAmbientStatus("running");
    applyAmbientStatus("completed");
    expect(document.title).toBe("completed — Pi Console");
    expect(
      document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    ).toBe(ambientFavicon("completed"));
  });

  it("restore puts back the pre-apply title and favicon href", () => {
    document.title = "Pi Console";
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("href", "/console/favicon.svg");
    document.head.append(link);

    applyAmbientStatus("failed");
    restoreAmbientDefaults();
    expect(document.title).toBe("Pi Console");
    expect(
      document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    ).toBe("/console/favicon.svg");
  });

  it("restore removes the link it created when the page had none", () => {
    document.title = "Pi Console";
    applyAmbientStatus("requires_action");
    restoreAmbientDefaults();
    expect(document.title).toBe("Pi Console");
    expect(document.querySelector('link[rel="icon"]')).toBeNull();
  });

  it("restore is a no-op when nothing was applied", () => {
    document.title = "Untouched";
    restoreAmbientDefaults();
    expect(document.title).toBe("Untouched");
  });
});
