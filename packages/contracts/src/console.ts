/**
 * @pi-managed/contracts — Console support endpoints (non-`/v1`).
 *
 * Mirrors docs/api-reference.md §"Console support (non-`/v1`)" (console spec §3–§4).
 * These are the ONLY non-`/v1` endpoints the web console may call (parity rule,
 * console spec §1.2). The config endpoint is served by WP-C1.1; the console-session
 * endpoints are served by WP-C1.2 against the shapes pinned here.
 *
 * Security invariant: the console-session `apiKey` is write-only — present only in
 * `ConsoleSessionCreate`, never in any response schema (the browser holds an opaque
 * HttpOnly cookie instead, console spec §4.1).
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { tenantId } from "./ids.js";

// --- Console config (console spec §3.2) --------------------------------------

/** Deployment presentation mode. A presentation concern only — no `/v1` behavior differs. */
export const ConsoleMode = z.enum(["solo", "team", "saas"]);
export type ConsoleMode = z.infer<typeof ConsoleMode>;

/** `GET /console/config` response — exactly these two fields, nothing else. */
export const ConsoleConfig = z.object({
  mode: ConsoleMode,
  onboardingEnabled: z.boolean(),
});
export type ConsoleConfig = z.infer<typeof ConsoleConfig>;

// --- Console sessions (console spec §4; served by WP-C1.2) -------------------

/** `POST /console/session` request body. `apiKey` is write-only (never echoed). */
export const ConsoleSessionCreate = z.object({
  apiKey: z.string().min(1),
});
export type ConsoleSessionCreate = z.infer<typeof ConsoleSessionCreate>;

/** Tenant summary returned on console-session responses. */
export const ConsoleTenant = z.object({
  id: tenantId,
  name: z.string(),
});
export type ConsoleTenant = z.infer<typeof ConsoleTenant>;

/** `POST /console/session` response (console spec §4.2). */
export const ConsoleSessionCreateResponse = z.object({
  scopes: z.array(z.string()),
  tenant: ConsoleTenant,
});
export type ConsoleSessionCreateResponse = z.infer<typeof ConsoleSessionCreateResponse>;

/** `GET /console/session` response (console spec §4.4) — adds `expiresAt`. */
export const ConsoleSessionInfo = ConsoleSessionCreateResponse.extend({
  expiresAt: Timestamp,
});
export type ConsoleSessionInfo = z.infer<typeof ConsoleSessionInfo>;
