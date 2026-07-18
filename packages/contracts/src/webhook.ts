/**
 * @pi-managed/contracts — Webhooks.
 *
 * Mirrors docs/api-reference.md §"Webhooks". Notify of major state changes without
 * polling. The `whsec_` signing secret is returned ONLY on create (write-only on
 * retrieve).
 */

import { z } from "zod";
import { Timestamp } from "./common.js";
import { whId, whsecSecret } from "./ids.js";

// --- Event types (§23.1 + vault/credential/job events) ----------------------

export const WebhookEventType = z.enum([
  // session.* (§23.1). NOTE: the §23.1 source list uses "session.status_idled"
  // (past tense) while the POST /v1/webhooks example uses the persisted event
  // type "session.status_idle". Both are accepted pending doc reconciliation.
  "session.status_run_started",
  "session.status_idle",
  "session.status_idled",
  "session.status_rescheduled",
  "session.status_terminated",
  "session.thread_created",
  "session.thread_idled",
  "session.thread_terminated",
  "session.outcome_evaluation_ended",
  "session.updated",
  "session.deleted",
  // vault / credential lifecycle
  "vault.archived",
  "vault.deleted",
  "vault_credential.archived",
  "vault_credential.deleted",
  "vault_credential.refresh_failed",
  // job / run events
  "job.run_failed",
  "job.run_succeeded",
  "job.paused",
  "job.archived",
  // tenant balance thresholds (saas; console spec §11.6, WP-C5.2). Fired once when a
  // ledger debit CROSSES the configured low threshold / hits ≤ 0 — never re-fired on a
  // debit already below the line. Consumed alike by the console banner, email, and the
  // auto-charge engine, so these two carry a `data` payload (below) — the exception to
  // the otherwise-thin delivery, since the at-crossing balance is not recoverable by a
  // later GET (the balance keeps moving).
  "tenant.balance_low",
  "tenant.balance_exhausted",
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

// --- Create -----------------------------------------------------------------

export const WebhookCreate = z.object({
  /** HTTPS on port 443, publicly resolvable hostname (§23.3). */
  url: z.string().url(),
  eventTypes: z.array(WebhookEventType),
});
export type WebhookCreate = z.infer<typeof WebhookCreate>;

// --- Resource (retrieve — NO signingSecret) --------------------------------

/**
 * Webhook lifecycle (§23.5; backend `domain/webhook/webhook.ts`
 * `WebhookStatus`): `active` until auto-disabled — webhooks are deleted, not
 * archived, so the shared `ResourceStatus` enum does not apply here.
 */
export const WebhookStatus = z.enum(["active", "disabled"]);
export type WebhookStatus = z.infer<typeof WebhookStatus>;

export const Webhook = z.object({
  id: whId,
  url: z.string().url(),
  eventTypes: z.array(WebhookEventType),
  status: WebhookStatus,
  /** Machine-readable auto-disable reason (§23.5). The wire sends `null`
   * while the endpoint is active (backend `domain/webhook/webhook.ts`). */
  disabledReason: z.string().nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Webhook = z.infer<typeof Webhook>;

/** Create response — signing secret shown ONCE here, never again (§23.3). */
export const WebhookCreateResponse = Webhook.extend({
  signingSecret: whsecSecret,
});
export type WebhookCreateResponse = z.infer<typeof WebhookCreateResponse>;

// --- Test delivery (§23.5) --------------------------------------------------

export const WebhookTestResponse = z.object({
  delivered: z.boolean(),
  responseCode: z.number().int().optional(),
});
export type WebhookTestResponse = z.infer<typeof WebhookTestResponse>;

// --- Delivery payload (§23.2) -----------------------------------------------

/**
 * Thin payload — event `type` and `id`, NOT the full object. Fetch with a GET.
 *
 * `data` is normally absent (the thin default). A small set of event types whose
 * defining fact is not recoverable by a later GET carry a self-contained `data`
 * object instead: the tenant-balance thresholds (`tenant.balance_low` /
 * `tenant.balance_exhausted`, §11.6) carry a {@link TenantBalanceEventData} so a
 * consumer (email, auto-charge) has the AT-CROSSING balance + threshold without a
 * round-trip (the live balance keeps moving). See `billing.ts`.
 */
export const WebhookPayload = z.object({
  type: z.string(),
  id: z.string(),
  createdAt: Timestamp,
  data: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
