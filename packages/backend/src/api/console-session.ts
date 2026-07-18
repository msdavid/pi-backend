/**
 * Console-session routes (WP-C1.2, console spec §4).
 *
 * The key⇄cookie exchange behind the web console's sign-in:
 *
 * - `POST /console/session` — body `{apiKey}` (write-only, never echoed).
 *   Validates the key through the existing {@link verifyApiKey} path and, on
 *   success, stores a server-side session bound to a new random token returned
 *   as an `HttpOnly; Secure; SameSite=Strict; Path=/` cookie (§4.2).
 * - `GET /console/session` — `{scopes, tenant, expiresAt}` for the current
 *   cookie, `401` if none (app-boot bootstrap, §4.4).
 * - `DELETE /console/session` — destroys the server-side record and clears the
 *   cookie (sign-out, §4.4). As a cookie-authenticated mutation it requires
 *   the CSRF header (§4.5).
 *
 * Auth bypass: `/console/session` is on {@link PUBLIC_PATHS} — the global
 * bearer-auth hook skips it (POST is the login; GET/DELETE self-authenticate
 * via the cookie here). The console serve hook (`api/console.ts`) stamps the
 * §3.4 security headers and passes the path through instead of swallowing it.
 * Brute-force bound: `verifyApiKey`'s argon2 runs in the HANDLER — after the
 * preHandler anon rate limiter — so sign-in attempts are capped per IP by
 * `RATE_LIMIT_ANON_RPM` (unlike the bearer path, which needed its own
 * onRequest-time throttle, SEC-1).
 *
 * Cookie handling is dependency-free: one known cookie name, parsed and
 * serialized by hand (no cookie plugin).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ConsoleSessionCreate } from "@pi-managed/contracts";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { apiKeyIdFromRawKey, verifyApiKey } from "../domain/tenant/api-key.js";
import { getTenant } from "../domain/tenant/tenant.js";
import {
  CONSOLE_SESSION_TTL_DEFAULTS,
  createConsoleSession,
  deleteConsoleSession,
  resolveConsoleSession,
} from "../domain/tenant/console-session.js";
import { resolveConsoleConfig } from "./console.js";
import type { Config } from "../infra/config/index.js";

/** The console-session cookie name (the one cookie this backend sets). */
export const CONSOLE_SESSION_COOKIE = "pi_console_session";

/**
 * The CSRF custom header (console spec §4.5, lower-cased as Fastify exposes
 * headers). Cookie-authenticated mutating requests must send `X-Console-Csrf: 1`.
 */
export const CONSOLE_CSRF_HEADER = "x-console-csrf";

/** Route path shared with the serve-hook carve-out and the auth allowlist. */
export const CONSOLE_SESSION_PATH = "/console/session";

/**
 * Extract the console-session token from a `Cookie` header, or `null`. Manual
 * parse — one known cookie name, no attributes on the request side.
 */
export function consoleSessionTokenFrom(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== CONSOLE_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Resolve the effective console-session sliding TTL in seconds (console spec
 * §4.6): `CONSOLE_SESSION_TTL` overrides all; otherwise the default for the
 * same mode `GET /console/config` reports (solo 30 d, team 7 d, saas 24 h).
 */
export function resolveConsoleSessionTtlSeconds(
  config: Pick<Config, "consoleMode" | "onboardingEnabled" | "consoleSessionTtl">,
): number {
  return (
    config.consoleSessionTtl ??
    CONSOLE_SESSION_TTL_DEFAULTS[resolveConsoleConfig(config).mode]
  );
}

/** Exactly the §4.2 cookie attributes. The token is base64url — no encoding needed. */
function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    "set-cookie",
    `${CONSOLE_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
  );
}

/** Expire the cookie immediately (sign-out, §4.4). */
function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    `${CONSOLE_SESSION_COOKIE}=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/`,
  );
}

export interface ConsoleSessionRoutesOptions {
  pool: Pool;
  /** Sliding TTL in seconds ({@link resolveConsoleSessionTtlSeconds}). */
  ttlSeconds: number;
}

export const consoleSessionRoutes: FastifyPluginAsync<
  ConsoleSessionRoutesOptions
> = async (app, opts) => {
  // POST /console/session — sign-in: API key → cookie (§4.2). Public (it IS
  // the login) and CSRF-exempt; the response never echoes the key.
  app.post(
    CONSOLE_SESSION_PATH,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ConsoleSessionCreate.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "invalid_request",
          `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const ctx = await verifyApiKey(opts.pool, parsed.data.apiKey);
      if (!ctx) {
        throw new ApiError(401, "unauthorized", "invalid or revoked API key");
      }
      // verifyApiKey accepted the key, so its embedded id is well-formed.
      const apiKeyId = apiKeyIdFromRawKey(parsed.data.apiKey);
      const tenant = await getTenant(opts.pool, ctx.tenantId);
      if (!apiKeyId || !tenant) {
        throw new ApiError(401, "unauthorized", "invalid or revoked API key");
      }
      const session = await createConsoleSession(opts.pool, {
        apiKeyId,
        tenantId: ctx.tenantId,
        ttlSeconds: opts.ttlSeconds,
      });
      setSessionCookie(reply, session.token);
      return reply.status(201).send({
        scopes: ctx.scopes ?? [],
        tenant: { id: tenant.id, name: tenant.name },
      });
    },
  );

  // GET /console/session — session info for the current cookie (§4.4); used on
  // app boot. Self-authenticates via the cookie (the global auth hook skips
  // this path). Resolution slides the TTL, so `expiresAt` reflects the bump.
  app.get(
    CONSOLE_SESSION_PATH,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = consoleSessionTokenFrom(req.headers.cookie);
      if (!token) {
        throw new ApiError(401, "unauthorized", "no console session");
      }
      const session = await resolveConsoleSession(
        opts.pool,
        token,
        opts.ttlSeconds,
      );
      if (!session) {
        throw new ApiError(
          401,
          "unauthorized",
          "invalid or expired console session",
        );
      }
      const tenant = await getTenant(opts.pool, session.tenantId);
      if (!tenant) {
        throw new ApiError(
          401,
          "unauthorized",
          "invalid or expired console session",
        );
      }
      return reply.status(200).send({
        scopes: session.scopes,
        tenant: { id: tenant.id, name: tenant.name },
        expiresAt: session.expiresAt.toISOString(),
      });
    },
  );

  // DELETE /console/session — sign-out (§4.4): destroy the server-side record
  // and clear the cookie. A cookie-authenticated mutation, so the CSRF header
  // is required (§4.5 — only the login POST is exempt). Deleting an already
  // dead session still succeeds (idempotent sign-out).
  app.delete(
    CONSOLE_SESSION_PATH,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = consoleSessionTokenFrom(req.headers.cookie);
      if (!token) {
        throw new ApiError(401, "unauthorized", "no console session");
      }
      if (req.headers[CONSOLE_CSRF_HEADER] !== "1") {
        throw new ApiError(
          403,
          "forbidden",
          "cookie-authenticated mutations require the X-Console-Csrf: 1 header",
        );
      }
      await deleteConsoleSession(opts.pool, token);
      clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );
};
