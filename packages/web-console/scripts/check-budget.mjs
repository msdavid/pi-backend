/**
 * Performance-budget check (console-spec §12.1, CI-enforced from phase 1):
 * the INITIAL JS — the entry chunk plus every chunk it statically imports —
 * must be ≤ 200 KB gzipped. Lazy route chunks don't count; they load on
 * navigation.
 *
 * Runs after `vite build` (wired into the package `build` script). Initial
 * chunks are read off dist/index.html exactly as a browser would: the
 * `<script type="module">` entry plus the `<link rel="modulepreload">` hints
 * Vite emits for the entry's static import graph.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BUDGET_BYTES = 200 * 1024;
const BASE = "/console/";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");
const html = readFileSync(resolve(dist, "index.html"), "utf8");

/** Parse `name="value"` attributes off a single HTML tag. */
function attrsOf(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

const urls = [];
for (const m of html.matchAll(/<(script|link)\b[^>]*>/g)) {
  const attrs = attrsOf(m[0]);
  if (m[1] === "script" && attrs.type === "module" && attrs.src) {
    urls.push(attrs.src);
  }
  if (m[1] === "link" && attrs.rel === "modulepreload" && attrs.href) {
    urls.push(attrs.href);
  }
}

if (urls.length === 0) {
  console.error(
    "check-budget: no module scripts found in dist/index.html — did the Vite build change shape?",
  );
  process.exit(1);
}

let total = 0;
for (const url of urls) {
  if (!url.startsWith(BASE)) {
    console.error(
      `check-budget: initial chunk "${url}" is not under the ${BASE} base — the backend cannot serve it (vite.config.ts must keep base "${BASE}").`,
    );
    process.exit(1);
  }
  const file = resolve(dist, url.slice(BASE.length));
  const gzipped = gzipSync(readFileSync(file)).length;
  total += gzipped;
  console.log(`  ${(gzipped / 1024).toFixed(1).padStart(7)} KB gz  ${url}`);
}

const totalKb = (total / 1024).toFixed(1);
const budgetKb = (BUDGET_BYTES / 1024).toFixed(0);
if (total > BUDGET_BYTES) {
  console.error(
    `check-budget: FAIL — initial JS ${totalKb} KB gzipped exceeds the ${budgetKb} KB budget (console-spec §12.1). Split routes or trim the entry.`,
  );
  process.exit(1);
}
console.log(
  `check-budget: OK — initial JS ${totalKb} KB gzipped ≤ ${budgetKb} KB budget (${urls.length} chunk(s)).`,
);
