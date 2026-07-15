/**
 * Cursor-pagination helpers (WP-P0.5).
 *
 * Implements api-reference.md §"Cursor pagination": every list endpoint accepts
 * `limit` (default 50, max 200, clamped) and an opaque base64url `cursor`; the
 * response wraps rows in `{ data, nextCursor }`. Cursors are opaque — clients
 * must not construct or parse them. Internally a cursor is base64url-encoded
 * JSON of a position marker, so resource families can encode whatever position
 * they need (e.g. `{ createdAt, id }`).
 *
 * The {@link parseListParams} and {@link paginate} helpers match the
 * `@pi-managed/contracts` {@link ListParams}/{@link Cursor} types.
 */

import type { FastifyRequest } from "fastify";
import type { Cursor, ListParams } from "@pi-managed/contracts";

/** Default page size when `limit` is omitted (§"Cursor pagination"). */
export const DEFAULT_LIMIT = 50;
/** Maximum page size; larger values are clamped (§"Cursor pagination"). */
export const MAX_LIMIT = 200;

/** Parsed list parameters: a clamped `limit` and an optional opaque `cursor`. */
export interface ParsedListParams {
  limit: number;
  cursor?: string;
}

/**
 * Parse list query params from a Fastify request.
 *
 * - `limit`: integer; default {@link DEFAULT_LIMIT}, clamped to [1, {@link MAX_LIMIT}].
 *   Non-integer / out-of-range values are clamped (not rejected) to keep list
 *   endpoints forgiving, matching "clamped if larger" in the spec.
 * - `cursor`: opaque string, passed through verbatim when present.
 */
export function parseListParams(request: FastifyRequest): ParsedListParams {
  const raw = (request.query ?? {}) as Partial<ListParams>;
  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    const n = typeof raw.limit === "number" ? raw.limit : Number(raw.limit);
    if (Number.isFinite(n)) {
      limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
    }
  }
  const cursor = typeof raw.cursor === "string" && raw.cursor.length > 0 ? raw.cursor : undefined;
  return { limit, cursor };
}

/**
 * Encode an opaque position marker as a base64url cursor string.
 *
 * The marker is JSON-serialized then base64url-encoded; clients must treat the
 * result as opaque (§"Cursor pagination"). Any JSON-serializable position is
 * accepted — typically `{ createdAt, id }` for the default createdAt-desc sort.
 */
export function encodeCursor(marker: Record<string, unknown>): string {
  const json = JSON.stringify(marker);
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode a base64url cursor back into its position marker. Throws on malformed
 * cursors (callers map this to `400 invalid_request`); resource families that
 * accept cursors should validate the decoded shape.
 */
export function decodeCursor<T = Record<string, unknown>>(cursor: string): T {
  const json = Buffer.from(cursor, "base64url").toString("utf8");
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("cursor does not encode a position object");
  }
  return parsed as T;
}

/**
 * Wrap a page of rows in the list-response envelope. `nextCursor` should be the
 * cursor for the next page (computed by the caller from the last row), or
 * `undefined`/omitted when the end of the result set has been reached.
 */
export function paginate<T>(rows: T[], nextCursor?: string): Cursor<T> {
  return {
    data: rows,
    nextCursor: nextCursor ?? null,
  };
}
