/**
 * Build script: copies the static SPA sources in `src/` to `dist/`.
 *
 * The console is a dependency-free vanilla-JS SPA (no bundler, no framework),
 * so "building" is a plain file copy. `dist/` is what the backend serves at
 * `/console` (see `packages/backend/src/api/console.ts`).
 */
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");
const dist = resolve(here, "../dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

let count = 0;
for (const name of readdirSync(src)) {
  cpSync(resolve(src, name), resolve(dist, name));
  count++;
}
console.log(`web-console: copied ${count} asset(s) to dist/`);
