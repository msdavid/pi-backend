// @vitest-environment node
/**
 * Phase-1 gate — console-spec §13 items §1.2 and the static half of §3.4.
 *
 * §1.2 (parity rule): the console calls only the public `/v1` API plus the
 * two console-support endpoints, `/console/config` and `/console/session`.
 * Enforced structurally over the production source: (a) the ONLY places the
 * SPA touches the network are the two sanctioned transports — the typed
 * client in `src/api/client.ts` (request/response) and the SSE stream
 * client in `src/api/stream.ts` (fetch streaming, WP-C2.1 — §8.1 mandates
 * fetch over `EventSource`); (b) every endpoint-shaped string literal is
 * `/v1/*` or a §3–§4 endpoint; (c) no side-channel transports
 * (`XMLHttpRequest`/`WebSocket`/`EventSource`).
 *
 * §3.4 static half: the built `dist/` (what the backend actually serves)
 * references no external host anywhere a resource request could originate —
 * no external `src=`/`href=` in `index.html`, no `url(http…)`/`@import`/
 * `@font-face` in CSS, and every `https?://` occurrence in the JS bundles is
 * one of the pinned INERT string patterns: strings baked into our
 * dependencies (namespace identifiers, error-doc links) that are never
 * dereferenced, plus our own deliberate navigation hrefs (the DP-9 docs
 * link) — navigation is not a resource load and is not restricted by the
 * `default-src 'self'` CSP. Any new external URL — a CDN import, a font, a
 * telemetry beacon — fails the gate.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildConsole,
  distDir,
  pkgRoot,
  productionSourceFiles,
  readText,
  stripComments,
  walkFiles,
} from "./helpers.js";

/** §1.2 — the complete allowed endpoint surface (console-spec §3–§4). */
function isAllowedPathLiteral(lit: string): boolean {
  if (lit.startsWith("/v1/")) return true; // public API (parity rule)
  if (lit === "/console/config" || lit === "/console/session") return true;
  // The router's own basepath — a client-side URL prefix, not a request.
  if (lit === "/console") return true;
  // C§5.1 (WP-C3.6): the solo/team Settings health widget reads the two
  // PUBLIC probes. Exact literals only; their sole fetch site is the
  // sanctioned `src/api/health.ts` transport below.
  if (lit === "/healthz" || lit === "/readyz") return true;
  return false;
}

/**
 * §3.4 — `https?://` strings that legitimately exist inside our (bundled,
 * pinned) dependencies but can never cause a network request. Each pattern
 * is deliberately narrow; anything else is a gate failure.
 */
const INERT_URL_PATTERNS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /^http:\/\/www\.w3\.org\//,
    why: "XML/SVG/MathML namespace identifiers (react-dom) — attribute namespaces, never fetched",
  },
  {
    pattern: /^https:\/\/react\.dev\/errors\//,
    why: "react-dom's minified-error decoder link — message text, never fetched",
  },
  {
    pattern: /^https?:\/\/json-schema\.org\//,
    why: "JSON-schema `$schema` identifiers (zod, via contracts) — inert ids",
  },
  {
    pattern: /^http:\/\/localhost/,
    why: "URL-parser scaffolding in a dependency; localhost is not an external host",
  },
  {
    pattern: /^http:\/\/\[\$\{/,
    why: "IPv6-host formatting template in a validator's message — not a URL",
  },
  {
    pattern:
      /^https:\/\/github\.com\/msdavid\/pi-backend\/blob\/main\/docs\/api-reference\.md/,
    why:
      "the DP-9 'docs' link rendered next to error code/requestId " +
      "(src/lib/errors.ts errorDocsUrl) — a user-clicked navigation href, " +
      "never fetched as a resource; CSP default-src 'self' governs resource " +
      "loads, not link navigation",
  },
];

describe("§1.2 — the console calls only /v1 + the §3–§4 endpoints", () => {
  it("the only fetch call sites in production source are the sanctioned transports", () => {
    // The complete list of modules allowed to touch the network. client.ts
    // is the request/response transport (WP-C1.5); stream.ts is the SSE
    // streaming transport (WP-C2.1 — console-spec §8.1 requires fetch
    // streaming, not EventSource). Anything else calling fetch is a
    // side-channel and fails the gate.
    const sanctionedTransports = [
      join(pkgRoot, "src/api/client.ts"),
      join(pkgRoot, "src/api/stream.ts"),
      // C§5.1 health probes (WP-C3.6): /readyz answers 503 WITH a readable
      // body (per-component checks), which the JSON client's throw-on-non-2xx
      // contract cannot surface — so the health module carries its own probe
      // fetch, restricted to the two /healthz + /readyz literals pinned in
      // isAllowedPathLiteral above.
      join(pkgRoot, "src/api/health.ts"),
    ];
    const offenders: string[] = [];
    for (const file of productionSourceFiles()) {
      if (sanctionedTransports.includes(file)) continue;
      const code = stripComments(readText(file));
      // `fetch(` not preceded by an identifier char (excludes `.refetch(`).
      if (/(^|[^A-Za-z0-9_$.])fetch\s*\(/.test(code)) {
        offenders.push(relative(pkgRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every endpoint-shaped string literal is /v1/*, /console/{config,session}, or a C§5.1 probe", () => {
    const offenders: string[] = [];
    for (const file of productionSourceFiles()) {
      const code = stripComments(readText(file));
      // healthz|readyz added by WP-C3.6 so the C§5.1 probe literals are
      // scanned (and thus pinned) like every other endpoint shape.
      for (const m of code.matchAll(
        /(["'`])(\/(?:v1|console|healthz|readyz)(?:\/[^"'`\n]*)?)\1/g,
      )) {
        const lit = m[2]!;
        if (!isAllowedPathLiteral(lit)) {
          offenders.push(`${relative(pkgRoot, file)}: ${lit}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no side-channel transports (XMLHttpRequest / WebSocket / EventSource)", () => {
    const offenders: string[] = [];
    for (const file of productionSourceFiles()) {
      const code = stripComments(readText(file));
      for (const banned of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
        if (code.includes(banned)) {
          offenders.push(`${relative(pkgRoot, file)}: ${banned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("§3.4 (static) — zero external hosts referenced by dist/", () => {
  beforeAll(() => {
    // Always scan a FRESH production build — a stale dist/ (e.g. from an
    // aborted dev-mode build) must not decide a conformance item.
    buildConsole();
  });

  it("dist/index.html references only /console/ URLs", () => {
    const html = readFileSync(join(distDir, "index.html"), "utf8");
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `index.html references non-/console/ URL: ${ref}`).toMatch(
        /^\/console\//,
      );
    }
  });

  it("CSS contains no external url(), @import, or @font-face", () => {
    const cssFiles = walkFiles(distDir).filter((f) => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(0);
    for (const file of cssFiles) {
      const css = readText(file);
      expect(css).not.toMatch(/url\(\s*["']?https?:/i);
      expect(css).not.toMatch(/url\(\s*["']?\/\//i);
      expect(css).not.toMatch(/@import\b/i);
      expect(css).not.toMatch(/@font-face\b/i);
    }
  });

  it("every https?:// occurrence in the bundles matches a pinned inert pattern", () => {
    const offenders: string[] = [];
    for (const file of walkFiles(distDir)) {
      const text = readText(file);
      for (const m of text.matchAll(/https?:\/\/[^\s"'`\\)<>]+/g)) {
        const url = m[0];
        if (!INERT_URL_PATTERNS.some(({ pattern }) => pattern.test(url))) {
          offenders.push(`${relative(distDir, file)}: ${url}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no fetch/import/WebSocket of an absolute http URL in the bundles", () => {
    for (const file of walkFiles(distDir).filter((f) => f.endsWith(".js"))) {
      const text = readText(file);
      expect(text).not.toMatch(/fetch\(\s*["'`]https?:/);
      expect(text).not.toMatch(/import\(\s*["'`]https?:/);
      expect(text).not.toMatch(/new\s+WebSocket\(\s*["'`]/);
    }
  });
});
