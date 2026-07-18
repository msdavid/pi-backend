/**
 * DP-9 error copy (console-spec §6.4): failures render the API's machine
 * `code` and the server-correlated `requestId` alongside the message — never
 * a bare string — plus a "docs" link into the api-reference error envelope.
 * Feature screens render this via `src/ui/error-alert.tsx`; the sign-in
 * screen keeps its own 401-specific variant
 * (`src/features/auth/sign-in.tsx`).
 */
import { ConsoleApiError } from "../api/client.js";

/** One-line rendering of any query error: `message (code · requestId)`. */
export function errorSummary(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    const facts = [error.code, error.requestId].filter(Boolean).join(" · ");
    return facts ? `${error.message} (${facts})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the rendered `code`/`requestId` are explained: the api-reference
 * "Error envelope" section. DP-9 asks error copy to link the docs; every
 * error render site shows this as a "docs" link (`src/ui/error-alert.tsx`,
 * sign-in). Navigating there is allowed under the §3.4 CSP —
 * `default-src 'self'` restricts resource loads, not link navigation.
 */
export function errorDocsUrl(): string {
  return "https://github.com/msdavid/pi-backend/blob/main/docs/api-reference.md#error-envelope";
}
