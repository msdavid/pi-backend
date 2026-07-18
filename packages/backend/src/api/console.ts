/**
 * WP-4.5 — web console serving (spec §26.6; console spec §3).
 *
 * Serves the built SPA (from `@pi-managed/web-console`'s `dist/`) at
 * `/console` and `/console/*`. Since WP-C1.3–C1.7 the SPA is a Vite + React
 * app over the public `/v1` API; it authenticates via a cookie-backed console
 * session (`api/console-session.ts`, console spec §4) — the API key is
 * exchanged once at sign-in for an `HttpOnly` cookie and never lives in
 * JS-readable storage. (The original WP-4.5 app was a read-only vanilla-JS
 * page carrying a bearer key from localStorage; it was retired in WP-C1.8.)
 *
 * Auth bypass: the console's HTML/JS/CSS must load *before* the user signs in
 * (sign-in is a page in the SPA). This hook is therefore registered at the
 * Fastify root **before** the bearer-auth hook (see `server.ts`); calling
 * `reply.send()` inside an `onRequest` hook short-circuits the request, so the
 * subsequent auth `onRequest` hook is skipped for `/console*` while every other
 * `/v1/*` route stays authenticated.
 *
 * WP-C1.1 (console spec §3): the hook additionally
 *   - answers `GET /console/config` (public, unauthenticated) with exactly
 *     `{mode, onboardingEnabled}` (§3.2), and
 *   - stamps the §3.4 security headers on EVERY `/console*` response (assets,
 *     SPA fallbacks, the config endpoint, and 404s alike).
 *
 * WP-C1.2 (console spec §4): `/console/session` is NOT swallowed — the hook
 * stamps the headers and passes the request through to the real routes in
 * `api/console-session.ts` (cookie auth; on the auth-hook allowlist).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleConfig } from "@pi-managed/contracts";
import type { Config } from "../infra/config/index.js";

/** Path prefix the console is served under. */
const CONSOLE_PREFIX = "/console";

/**
 * CSP for `/console*` responses (console spec §3.4): everything bundled,
 * same-origin only — no inline script/style, no CDN, never framed. Stricter
 * than the API-wide CSP in `server.ts`, whose `onSend` hook defers to a CSP
 * that is already set.
 */
export const CONSOLE_CSP = "default-src 'self'; frame-ancestors 'none'";

/**
 * Resolve the `GET /console/config` values from service config (console spec
 * §3.2): `CONSOLE_MODE` env wins when set; otherwise the mode is derived —
 * onboarding enabled → `saas`, else `solo`.
 */
export function resolveConsoleConfig(
  config: Pick<Config, "consoleMode" | "onboardingEnabled">,
): ConsoleConfig {
  return {
    mode: config.consoleMode ?? (config.onboardingEnabled ? "saas" : "solo"),
    onboardingEnabled: config.onboardingEnabled,
  };
}

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
  /**
   * Values served by `GET /console/config` (console spec §3.2). `server.ts`
   * always passes {@link resolveConsoleConfig} output; the default mirrors the
   * config-schema defaults (onboarding off → `solo`).
   */
  config?: ConsoleConfig;
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
  // Exactly the two spec fields (console spec §3.2), regardless of what extra
  // properties a caller-supplied object might structurally carry. Serialized
  // once — the body is constant for the process lifetime.
  const consoleConfig = opts.config ?? { mode: "solo", onboardingEnabled: false };
  const configBody = JSON.stringify({
    mode: consoleConfig.mode,
    onboardingEnabled: consoleConfig.onboardingEnabled,
  });

  /**
   * Send a 404 in the backend's error-envelope shape. `requestId` is required
   * by the contracts `ErrorEnvelope`; `req.id` is the same value the global
   * handler's `envelope()` in `server.ts` stamps.
   */
  function notFound(req: FastifyRequest, reply: FastifyReply, message: string): void {
    reply.status(404).send({
      error: { type: "request_error", code: "not_found", message, requestId: req.id },
    });
  }

  return async function consoleServeHook(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const url = req.url.split("?")[0];
    if (url !== CONSOLE_PREFIX && !url.startsWith(`${CONSOLE_PREFIX}/`)) {
      return; // not a console path — let auth + route handlers proceed.
    }

    // Security headers on EVERY /console* response (console spec §3.4) —
    // assets, the config endpoint, SPA fallbacks and 404s alike. Set before
    // any send() below; the API-wide onSend hook in server.ts defers to a
    // Content-Security-Policy that is already present.
    reply.header("Content-Security-Policy", CONSOLE_CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");

    // WP-C1.2: /console/session is a real API resource (api/console-session.ts),
    // not a static asset — pass it through (headers above already stamped; the
    // path is on the auth allowlist and self-authenticates via its cookie).
    if (url === `${CONSOLE_PREFIX}/session`) {
      return;
    }

    // GET /console/config — public, unauthenticated (console spec §3.2).
    // Non-GET methods fall through to the static path like any other URL.
    if (url === `${CONSOLE_PREFIX}/config` && req.method === "GET") {
      reply.type("application/json; charset=utf-8").send(configBody);
      return;
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
      notFound(req, reply, "console asset not found");
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
        notFound(req, reply, "console assets not built (run pnpm --filter @pi-managed/web-console build)");
      }
    }
  };
}
