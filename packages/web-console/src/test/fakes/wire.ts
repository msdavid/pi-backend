/**
 * Shared wire helpers for the per-family fake modules under `src/test/fakes/`
 * (WP-C3-prep: `fake-console-api.ts` split per-family at the ~600-line
 * limit; the public `FakeConsoleApi` surface is unchanged — state lives on
 * the main class, these modules hold the route matching + wire shaping).
 */
import { ConsoleApiError } from "../../api/client.js";

export function unauthorized(): ConsoleApiError {
  return new ConsoleApiError("Missing or invalid credentials.", {
    status: 401,
    code: "unauthorized",
    type: "authentication_error",
    requestId: "req_01TESTREQUEST",
  });
}

export function notFound(id: string): ConsoleApiError {
  return new ConsoleApiError(`Resource ${id} not found.`, {
    status: 404,
    code: "not_found",
    type: "request_error",
    requestId: "req_01TESTREQUEST",
  });
}

export function invalidRequest(message: string): ConsoleApiError {
  return new ConsoleApiError(message, {
    status: 422,
    code: "invalid_request",
    type: "request_error",
    requestId: "req_01TESTREQUEST",
  });
}

export function forbidden(message: string): ConsoleApiError {
  return new ConsoleApiError(message, {
    status: 403,
    code: "forbidden",
    type: "request_error",
    requestId: "req_01TESTREQUEST",
  });
}

/** Outputs are idle-only (api-reference §"GET /v1/sessions/:id/outputs"). */
export function sessionNotIdle(status: string): ConsoleApiError {
  return new ConsoleApiError(
    `session must be idle to read outputs (current status: ${status})`,
    {
      status: 409,
      code: "session_not_idle",
      type: "request_error",
      requestId: "req_01TESTREQUEST",
    },
  );
}

/** Offset-"cursor" page over an already-filtered array (opaque to the UI). */
export function pageOf<T>(
  items: T[],
  params: URLSearchParams,
  defaultLimit = 50,
): { data: T[]; nextCursor: string | null } {
  const limit = Number(params.get("limit") ?? String(defaultLimit));
  const offset = Number(params.get("cursor") ?? "0");
  const data = items.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < items.length ? String(offset + limit) : null;
  return { data, nextCursor };
}

/** Small bounded collections don't page (api-reference §"Cursor pagination"). */
export function fullSet<T>(items: T[]): { data: T[]; nextCursor: null } {
  return { data: items, nextCursor: null };
}
