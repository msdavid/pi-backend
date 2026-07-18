/**
 * API-key scope semantics, mirrored from the backend's scope middleware
 * (`packages/backend/src/api/middleware/scope.ts`, documented in
 * docs/api-reference.md §"Authorization scopes"):
 *
 *   - `read`  → GET/HEAD (all browsing/observation surfaces);
 *   - `write` → mutations (matching is EXACT: `write` alone does not grant
 *     `read` — issue keys as `["read", "write"]`);
 *   - `admin` → a wildcard that satisfies every requirement (and the only
 *     scope that unlocks API-key management, backend `requireScope("admin")`).
 *
 * The UI derives capability purely from the scopes the console session
 * returns (console-spec §6.1); the backend remains the sole enforcer (§6.4).
 */

/** True when the key can mutate (`write`, or the `admin` wildcard). */
export function canWrite(scopes: readonly string[]): boolean {
  return scopes.includes("write") || isAdmin(scopes);
}

/** True when the key carries the `admin` wildcard scope. */
export function isAdmin(scopes: readonly string[]): boolean {
  return scopes.includes("admin");
}

/** True when the key can only browse — drives the §6.3 read-only badge. */
export function isReadOnly(scopes: readonly string[]): boolean {
  return !canWrite(scopes);
}
