/**
 * Shared helpers for the phase-1 conformance gate (console-spec §13),
 * mirroring the backend's `test/phase1-gate/` pattern: filesystem walking for
 * the static scans and a real `pnpm build` for the suites that assert over
 * the built `dist/` the backend actually serves.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const pkgRoot = resolve(import.meta.dirname, "../..");
export const distDir = join(pkgRoot, "dist");
export const srcDir = join(pkgRoot, "src");

/**
 * Run the package build (`vite build` + `scripts/check-budget.mjs`) and
 * return its combined stdout. Throws (failing the calling test) when either
 * step exits non-zero. `NODE_ENV=production` is forced: vitest sets
 * `NODE_ENV=test`, which Vite would otherwise inherit and bundle the
 * *development* React build — not what ships.
 */
export function buildConsole(): string {
  return execSync("pnpm build", {
    cwd: pkgRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
}

/** Build once if `dist/` is absent, so gate files can run in any order. */
export function ensureConsoleDist(): void {
  if (!existsSync(join(distDir, "index.html"))) buildConsole();
}

/** Basenames of every built JS chunk under `dist/`. */
export function distJsAssetNames(): string[] {
  return walkFiles(distDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.split("/").pop()!);
}

/**
 * The initial JS set, read off `dist/index.html` the way a browser (and
 * `scripts/check-budget.mjs`) would: the module entry + modulepreloads.
 * Anything NOT in this list is a lazy chunk and does not count against the
 * §12.1 budget.
 */
export function initialJsUrls(): string[] {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  return [
    ...html.matchAll(
      /<(?:script[^>]*type="module"[^>]*src|link[^>]*rel="modulepreload"[^>]*href)="([^"]+)"/g,
    ),
  ].map((m) => m[1]!);
}

/** All file paths under `dir`, recursively. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Production source files of the SPA: everything under `src/` except tests
 * and the test-only helpers in `src/test/` (which never enter the Vite
 * build — the dist scans cover what actually ships).
 */
export function productionSourceFiles(): string[] {
  return walkFiles(srcDir).filter(
    (path) =>
      /\.(ts|tsx)$/.test(path) &&
      !/\.test\.(ts|tsx)$/.test(path) &&
      !path.includes("__tests__") &&
      !path.startsWith(join(srcDir, "test") + "/"),
  );
}

/** Rough comment stripper so doc-comment prose can't trip literal scans. */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
