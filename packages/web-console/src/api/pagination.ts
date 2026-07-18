/**
 * Cursor-pagination helpers (api-reference §"Cursor pagination").
 *
 * List endpoints accept `limit` (default 50, max 200) and an opaque base64url
 * `cursor`, and respond `{data, nextCursor}` where `nextCursor: null` means
 * the end of the result set. The cursor is opaque — never constructed or
 * parsed client-side; it is passed back verbatim as `?cursor=`.
 */

import type { Cursor } from "@pi-managed/contracts";

export type QueryParamValue = string | number | boolean | undefined;

/**
 * Append query params to a path, skipping `undefined` values. Used for the
 * pagination params (`limit`, `cursor`) and resource-family filters
 * (`?status=`, `?agentId=`, …) alike — filters do not change the pagination
 * contract.
 */
export function withQuery(
  path: string,
  params?: Record<string, QueryParamValue>,
): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * TanStack `useInfiniteQuery` wiring for a cursor-paginated endpoint: spread
 * into `infiniteQueryOptions`. The page param is the opaque cursor —
 * `undefined` for the first page; `nextCursor: null` (end reached) maps to
 * `undefined` so the query reports no further pages.
 */
export const cursorPageParams = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: <T>(lastPage: Cursor<T>): string | undefined =>
    lastPage.nextCursor ?? undefined,
};
