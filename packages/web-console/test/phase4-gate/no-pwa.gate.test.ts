// @vitest-environment node
/**
 * Phase-4 gate — console-spec §10.5, the RESPONSIVE-ONLY decision
 * (`console.md` §10.5): the console ships NO PWA surface. A service worker
 * interacts with the §3.4 CSP and the §4 cookie auth, and the option was
 * deliberately declined for phase 4 — so this gate pins its absence in the
 * artifact the backend actually serves:
 *
 *  - no web-app manifest in `dist/` and no `<link rel="manifest">` in the
 *    served index.html;
 *  - no `navigator.serviceWorker` registration in any built chunk or in any
 *    production source file;
 *  - the phone-width prerequisite is present instead: the §10.5 viewport
 *    meta on the served index.html.
 *
 * Also carries the static half of the horizontal-overflow smoke (§10.5
 * "usable on a phone-width viewport"): jsdom performs no layout, so what IS
 * honestly assertable offline is that no stylesheet the build ships forces
 * a fixed element width beyond a 375-px viewport — every `width`/`min-width`
 * declaration with an absolute value must stay ≤ 375 px (fluid `%`/`vw`
 * values and `max-width` caps cannot force overflow and are exempt). The
 * live-layout half (real reflow at 375 px) is the manual check in this
 * gate's README.
 */
import { basename } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  distDir,
  distJsAssetNames,
  ensureConsoleDist,
  productionSourceFiles,
  readText,
  stripComments,
  walkFiles,
} from "../phase1-gate/helpers.js";

/** Absolute-length `width:`/`min-width:` declarations (px or rem). */
const FIXED_WIDTH_RE = /(?<!max-)(?:^|[{;\s])(width|min-width)\s*:\s*([0-9.]+)(px|rem)/g;

/** Root font size the rem values resolve against (styles/global.css). */
const REM_PX = 16;

const PHONE_VIEWPORT_PX = 375;

describe("§10.5 — responsive-only: no PWA surface ships", () => {
  let distFiles: string[];

  beforeAll(() => {
    ensureConsoleDist();
    distFiles = walkFiles(distDir);
  });

  it("dist/ contains no web-app manifest and no service-worker file", () => {
    const suspicious = distFiles.filter((path) => {
      const name = basename(path).toLowerCase();
      return (
        name.endsWith(".webmanifest") ||
        name === "manifest.json" ||
        /(^|[.-])(service-?worker|sw)\.js$/.test(name)
      );
    });
    expect(suspicious).toEqual([]);
  });

  it("the served index.html links no manifest and keeps the §10.5 viewport meta", () => {
    const html = readText(`${distDir}/index.html`);
    expect(html).not.toMatch(/rel=["']manifest["']/i);
    expect(html).toMatch(
      /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1["']/,
    );
  });

  it("no built chunk registers a service worker", () => {
    expect(distJsAssetNames().length).toBeGreaterThan(0);
    for (const path of distFiles.filter((f) => f.endsWith(".js"))) {
      expect(
        readText(path).includes("serviceWorker"),
        `${basename(path)} references navigator.serviceWorker — §10.5 decided against a PWA`,
      ).toBe(false);
    }
  });

  it("no production source references a service worker or manifest", () => {
    for (const path of productionSourceFiles()) {
      const code = stripComments(readText(path));
      expect(
        /serviceWorker|webmanifest/i.test(code),
        `${path} references a PWA surface — §10.5 decided against one`,
      ).toBe(false);
    }
  });
});

describe("§10.5 — static overflow smoke: no stylesheet forces a width beyond 375 px", () => {
  it("every absolute width/min-width in the built CSS is ≤ the phone viewport", () => {
    ensureConsoleDist();
    const cssFiles = walkFiles(distDir).filter((f) => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of cssFiles) {
      const css = readText(path);
      for (const match of css.matchAll(FIXED_WIDTH_RE)) {
        const [, prop, value, unit] = match;
        const px = Number(value) * (unit === "rem" ? REM_PX : 1);
        if (px > PHONE_VIEWPORT_PX) {
          offenders.push(`${basename(path)}: ${prop}: ${value}${unit} (${px}px)`);
        }
      }
    }
    expect(
      offenders,
      "fixed widths wider than a phone viewport force horizontal page scroll — " +
        "use max-width (a cap) or a scroll container instead",
    ).toEqual([]);
  });
});
