/**
 * WP-4.5 — read-only web console (spec §26.6).
 *
 * Serves the built static SPA (from `@pi-managed/web-console`'s `dist/`) at
 * `/console` and `/console/*`. The SPA is a dependency-free vanilla-JS app that
 * browses sessions, traces events, and shows token usage; it performs only
 * `GET` requests and carries a user-supplied API key as
 * `Authorization: Bearer <key>` on every `/v1/*` call.
 *
 * Auth bypass: the console's HTML/JS/CSS must load *before* a key is entered
 * (the key is typed into the page). This hook is therefore registered at the
 * Fastify root **before** the bearer-auth hook (see `server.ts`); calling
 * `reply.send()` inside an `onRequest` hook short-circuits the request, so the
 * subsequent auth `onRequest` hook is skipped for `/console*` while every other
 * `/v1/*` route stays authenticated. `api/middleware/auth.ts` is NOT modified.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Path prefix the console is served under. */
const CONSOLE_PREFIX = "/console";

/** Content-types for the (small, known) set of console asset extensions. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Default console asset root. Resolves to `packages/web-console/dist` relative
 * to this module, which lives at `packages/backend/{src,dist}/api/console.{ts,js}`
 * — the same three `..` hops land on `packages/web-console/dist` in both the
 * compiled and vitest-run layouts.
 */
export function defaultConsoleDistPath(): string {
  return resolve(
    fileURLToPath(new URL("../../../web-console/dist", import.meta.url)),
  );
}

/** Options for {@link createConsoleServeHook}. */
export interface ConsoleServeOptions {
  /** Override the console asset root (defaults to {@link defaultConsoleDistPath}). */
  distPath?: string;
}

/**
 * Build a root-level `onRequest` hook that serves the console SPA. Returns a
 * Fastify hook; the caller attaches it via `app.addHook("onRequest", …)`
 * before the auth hook.
 */
export function createConsoleServeHook(
  opts: ConsoleServeOptions = {},
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const root = normalize(opts.distPath ?? defaultConsoleDistPath());
  const indexHtml = join(root, "index.html");

  /** Send a 404 in the backend's error-envelope shape. */
  function notFound(reply: FastifyReply, message: string): void {
    reply
      .status(404)
      .send({ error: { type: "request_error", code: "not_found", message } });
  }

  return async function consoleServeHook(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const url = req.url.split("?")[0];
    if (url !== CONSOLE_PREFIX && !url.startsWith(`${CONSOLE_PREFIX}/`)) {
      return; // not a console path — let auth + route handlers proceed.
    }

    // Map the URL to a file under the asset root; "/" → index.html (SPA).
    let rel =
      url === CONSOLE_PREFIX || url === `${CONSOLE_PREFIX}/`
        ? "index.html"
        : url.slice(CONSOLE_PREFIX.length + 1);
    if (rel === "") rel = "index.html";

    const filePath = normalize(join(root, rel));
    // Path-traversal guard: the resolved path must be the root itself or lie
    // strictly *under* it. A bare `startsWith(root)` would also admit a sibling
    // directory sharing the prefix (e.g. `<root>-backup/x`), which this hook
    // serves over the unauthenticated pre-auth path — so require a trailing
    // separator (SEC-11).
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      notFound(reply, "console asset not found");
      return;
    }

    const contentType = MIME[extname(filePath)] ?? "application/octet-stream";
    try {
      const body = await readFile(filePath);
      reply.type(contentType).send(body);
    } catch {
      // Unknown sub-path → fall back to index.html (SPA client-side routing),
      // or 404 if the console assets were never built.
      try {
        const index = await readFile(indexHtml);
        reply.type("text/html; charset=utf-8").send(index);
      } catch {
        notFound(reply, "console assets not built (run pnpm --filter @pi-managed/web-console build)");
      }
    }
  };
}
