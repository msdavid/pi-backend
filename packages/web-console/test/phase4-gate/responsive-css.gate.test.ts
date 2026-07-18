// @vitest-environment node
/**
 * Phase-4 gate — console-spec §10.5, the CSS half of the phone-width story
 * (companion to `phone-viewport.gate.test.ts`, whose jsdom render can only
 * prove DOM structure + JS behavior — jsdom applies no stylesheet cascade).
 * Two static pins:
 *
 *  1. **THE breakpoint is singular.** 720 px is the console's one phone
 *     breakpoint (documented in `src/styles/tokens.css` — CSS cannot
 *     `var()` inside a media query, so the value is written literally in
 *     each module). Any `max-width` media query in the source CSS or the
 *     built CSS using a different value is drift and fails here.
 *
 *  2. **The phone rules actually ship.** The key phone-width modules —
 *     shell drawer, conversation composer, interact panel, dialog — each
 *     carry a 720-px block in their source, and the built CSS the backend
 *     serves still contains those blocks with the modules' scoped class
 *     names inside them (CSS-module scoping keeps the local name in the
 *     emitted class, `_<local>_<hash>`). The minifier rewrites
 *     `(max-width: 720px)` to `(width<=720px)`; both forms pass, any other
 *     width value does not.
 */
import { relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  distDir,
  ensureConsoleDist,
  pkgRoot,
  readText,
  srcDir,
  walkFiles,
} from "../phase1-gate/helpers.js";

/** THE phone breakpoint (px) — see src/styles/tokens.css. */
const PHONE_BREAKPOINT_PX = 720;

/**
 * Width-capped media conditions in either spelling: authored
 * `(max-width: 720px)` or the minifier's range form `(width<=720px)`.
 */
const WIDTH_CAP_MEDIA_RE =
  /@media[^{]*\(\s*(?:max-)?width\s*(?::|<=)\s*([0-9.]+)px\s*\)/g;

/** Source modules that MUST carry a phone-breakpoint block (WP-C4.3). */
const PHONE_MODULES = [
  "src/app/shell.module.css",
  "src/features/sessions/conversation.module.css",
  "src/features/sessions/interact-panel.module.css",
  "src/ui/dialog.module.css",
];

/**
 * `@media` blocks of a stylesheet, brace-matched (minified CSS nests rule
 * braces inside the media block, so a regex alone cannot delimit it).
 */
function mediaBlocks(css: string): { condition: string; body: string }[] {
  const out: { condition: string; body: string }[] = [];
  const open = /@media([^{]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(css)) !== null) {
    let depth = 1;
    let i = open.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({
      condition: match[1]!.trim(),
      body: css.slice(open.lastIndex, i - 1),
    });
    open.lastIndex = i;
  }
  return out;
}

/** Width caps (px) found in `text`, with a source label per offender. */
function widthCapOffenders(text: string, label: string): string[] {
  const offenders: string[] = [];
  for (const m of text.matchAll(WIDTH_CAP_MEDIA_RE)) {
    if (Number(m[1]) !== PHONE_BREAKPOINT_PX) {
      offenders.push(`${label}: @media …${m[0].slice(m[0].indexOf("("))}`);
    }
  }
  return offenders;
}

describe("§10.5 — one phone breakpoint (720 px), no drift", () => {
  it("every max-width media query in the source CSS uses exactly 720px", () => {
    const cssFiles = walkFiles(srcDir).filter((f) => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);

    const offenders = cssFiles.flatMap((path) =>
      widthCapOffenders(readText(path), relative(pkgRoot, path)),
    );
    expect(
      offenders,
      `${PHONE_BREAKPOINT_PX}px is THE phone breakpoint (src/styles/tokens.css) — ` +
        "a second width value forks the responsive behavior",
    ).toEqual([]);
  });

  it("each key phone-width module carries the 720px block in its source", () => {
    const missing = PHONE_MODULES.filter(
      (rel) =>
        !new RegExp(
          `@media\\s*\\(\\s*max-width:\\s*${PHONE_BREAKPOINT_PX}px\\s*\\)`,
        ).test(readText(`${pkgRoot}/${rel}`)),
    );
    expect(missing, "phone-breakpoint rules dropped from source").toEqual([]);
  });
});

describe("§10.5 — the phone rules ship in the built CSS", () => {
  let builtCss: { path: string; css: string }[];

  beforeAll(() => {
    ensureConsoleDist();
    builtCss = walkFiles(distDir)
      .filter((f) => f.endsWith(".css"))
      .map((path) => ({ path: relative(distDir, path), css: readText(path) }));
    expect(builtCss.length).toBeGreaterThan(0);
  });

  it("every width-capped media query the build ships is the 720px breakpoint", () => {
    const offenders = builtCss.flatMap(({ path, css }) =>
      widthCapOffenders(css, path),
    );
    expect(offenders).toEqual([]);
  });

  it("the key modules' phone blocks survive the build, scoped classes intact", () => {
    // Phone-breakpoint media blocks across every shipped stylesheet.
    const phoneBlocks = builtCss.flatMap(({ css }) =>
      mediaBlocks(css).filter((b) =>
        new RegExp(
          `\\(\\s*(?:max-)?width\\s*(?::|<=)\\s*${PHONE_BREAKPOINT_PX}px\\s*\\)`,
        ).test(`(${b.condition})`),
      ),
    );
    expect(phoneBlocks.length).toBeGreaterThan(0);

    // One entry per key module, identified by CSS-module locals unique to
    // its phone block (`_<local>_<hash>` scoping keeps the local name):
    //  - shell: the drawer the Menu disclosure toggles
    //    (phone-viewport.gate.test.ts proves the JS flips `drawerOpen`);
    //  - conversation composer / interact panel: full-width message field;
    //  - dialog: viewport-capped panel.
    const expectations: { module: string; locals: string[] }[] = [
      { module: "shell drawer", locals: ["menuToggle", "drawer", "drawerOpen"] },
      { module: "conversation composer", locals: ["composerArea"] },
      { module: "interact panel", locals: ["composerInput", "panel"] },
      { module: "dialog", locals: ["backdrop"] },
    ];
    const unmet = expectations.filter(
      ({ locals }) =>
        !phoneBlocks.some((block) =>
          locals.every((local) => block.body.includes(`_${local}_`)),
        ),
    );
    expect(
      unmet.map((u) => u.module),
      "no shipped 720px media block styles these modules' scoped classes — " +
        "the phone layout regressed in the artifact the backend serves",
    ).toEqual([]);
  });
});
