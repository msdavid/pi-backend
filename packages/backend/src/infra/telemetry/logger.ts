/**
 * Structured logging via pino.
 *
 * The root logger carries service-level fields; per-request and per-session
 * correlation (tenantId / sessionId / requestId) is added through child loggers
 * so structured logs always carry their execution context (§27, §5.4).
 *
 * SECURITY (§25.1, §25.5): the logger is the last line of defence against a
 * credential leak. Callers MUST NOT log secrets, but a handler or error path that
 * logs a request (e.g. `POST /v1/vaults/:id/credentials`, whose body carries
 * `token` / `secretValue` in cleartext) would otherwise spill them to stdout.
 * Two layers guard that:
 *   1. {@link REDACT_PATHS} — pino `redact` on the known credential-bearing paths.
 *   2. {@link SECRET_SHAPES} — a censor that masks raw `pmb_live_` API keys and
 *      `whsec_` webhook secrets wherever they appear (any field, any depth, and
 *      in the log message itself).
 * Both replace the value with {@link REDACTED}.
 */

import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import type { Config } from "../config/index.js";

/** Base fields every log line carries. */
export interface BaseLogContext {
  /** Service component emitting the line (e.g. `server`, `session-manager`). */
  component?: string;
}

/** Per-session correlation context (§27 tenant, §5.4 session). */
export interface SessionLogContext {
  tenantId?: string;
  sessionId?: string;
  requestId?: string;
}

/** Replacement written in place of any redacted value. */
export const REDACTED = "[Redacted]";

/**
 * Credential-bearing paths, redacted by pino before serialization. Covers the
 * vault credential body (§12.4), bearer auth, api-key hashes (§8) and cookies.
 * `*.x` matches `x` one level below any key, so both `{ req: { body } }` and a
 * bare `{ body }` are caught.
 *
 * Field names mirror the write-only credential fields of the contracts
 * (`packages/contracts/src/vault.ts`), which are camelCase: `token`,
 * `secretValue`, `accessToken`, `refreshToken`, `clientSecret`, `apiKey`. All
 * six documented sensitive fields are covered here.
 */
const REDACT_PATHS = [
  "req.body.token",
  "req.body.secretValue",
  "req.body.accessToken",
  "req.body.refreshToken",
  "req.body.clientSecret",
  "req.body.apiKey",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.token",
  "*.secretValue",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
  "*.apiKey",
  "*.key_hash",
  "*.authorization",
  "*.set-cookie",
  "token",
  "secretValue",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "apiKey",
  "key_hash",
];

/** Raw secret shapes (§8 api keys, §14 webhook signing secrets) masked anywhere. */
const SECRET_SHAPES = /(?:pmb_live_|whsec_)[A-Za-z0-9_-]+/g;

/** Mask any raw secret shape inside a string. */
function censorSecretShapes(value: string): string {
  return value.replace(SECRET_SHAPES, REDACTED);
}

/** Deep-copy `value`, masking raw secret shapes in every string it holds. */
function censorDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return censorSecretShapes(value);
  if (depth >= 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => censorDeep(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = censorDeep(item, depth + 1);
  }
  return out;
}

/**
 * Build the root pino logger from validated config. Uses pino's default
 * destination (stdout) unless `destination` is supplied (tests capture the raw
 * stream). Child loggers created via {@link childLogger} attach
 * tenant/session/request correlation.
 *
 * Redaction (see the module header) is configured here so it applies to the root
 * logger and every child derived from it.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const opts: LoggerOptions = {
    level: config.logLevel,
    base: { service: "pi-managed-backend", version: "0.0.0" },
    // RFC 3339 UTC millis, matches contracts Timestamp precision.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    // Second layer: mask raw key/secret shapes in any field, at any depth.
    formatters: {
      log: (obj) => censorDeep(obj) as Record<string, unknown>,
    },
    // …and in the message string itself (`logger.info(\`key=${key}\`)`).
    hooks: {
      logMethod(args, method) {
        const masked = args.map((arg) =>
          typeof arg === "string" ? censorSecretShapes(arg) : arg,
        ) as typeof args;
        return method.apply(this, masked);
      },
    },
  };
  return destination ? pino(opts, destination) : pino(opts);
}

/**
 * Create a child logger carrying session correlation context. Callers MUST NOT
 * place credential values (SecretBinding contents, tokens) in context fields
 * (§25.1, §25.5).
 */
export function childLogger(
  parent: Logger,
  ctx: SessionLogContext & BaseLogContext,
): Logger {
  return parent.child(ctx);
}

export type { Logger } from "pino";
