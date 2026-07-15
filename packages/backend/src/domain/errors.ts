/**
 * The one error base for the whole backend (R7.2).
 *
 * This module is the **domain-level** home of the error taxonomy. It has NO
 * Fastify / HTTP / transport dependency — its only import is the machine-stable
 * {@link ErrorCode} enum from `@pi-managed/contracts`, which is the wire
 * *contract*, not the wire *layer*.
 *
 * Why it lives here: `ApiError` used to be declared in `server.ts` (the HTTP
 * composition root), so ~30 domain modules imported the HTTP layer and the HTTP
 * layer imported them back — a genuine import cycle, dodged in one place with a
 * dynamic import of the server module. Domain code must not depend on the
 * transport that happens to expose it.
 *
 * The convention (see CONVENTIONS.md → "Errors"):
 *
 * - Anything that must reach the client as a well-formed error throws
 *   {@link ApiError} — from domain services, from route handlers, from
 *   middleware. Nothing else in the repo re-declares an HTTP-facing error type.
 * - An `ApiError` carries the two halves of the published taxonomy
 *   (`docs/api-reference.md`): the HTTP `statusCode` and the machine-stable
 *   `code`, plus optional structured `details`. Status is data on the error, not
 *   a mapping inferred at the edge, because the taxonomy is not a function of
 *   `code` alone (e.g. `invalid_request` is 400 for a malformed request and 422
 *   for a well-formed but unprocessable one).
 * - Rendering — status + `ErrorEnvelope` JSON — happens exactly ONCE, in the
 *   Fastify error handler in `server.ts`. Domain code never builds an envelope,
 *   never touches a reply, and never imports `server.js`.
 * - Infrastructure-specific errors (`SsrfBlockedError`, `TenantScopeError`,
 *   `HostUnavailableError`, …) stay their own types: they are internal signals,
 *   not wire errors. Whoever handles them at a request boundary converts them to
 *   an `ApiError`; anything unconverted is a bug and surfaces as `500
 *   internal_error`.
 */

import { type ErrorCode } from "@pi-managed/contracts";

/**
 * A thrown error carrying an HTTP status + machine {@link ErrorCode}. Thrown by
 * domain services, route handlers and middleware alike; mapped to the wire
 * `ErrorEnvelope` by the global Fastify error handler in `server.ts`.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
