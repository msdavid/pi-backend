/**
 * @pi-managed/contracts — Webhooks.
 *
 * Mirrors docs/api-reference.md §"Webhooks". Notify of major state changes without
 * polling. The `whsec_` signing secret is returned ONLY on create (write-only on
 * retrieve).
 */

import { z } from "zod";
import { ResourceStatus, Timestamp } from "./common.js";
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

export const Webhook = z.object({
  id: whId,
  url: z.string().url(),
  eventTypes: z.array(WebhookEventType),
  status: ResourceStatus,
  disabledReason: z.string().optional(),
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

/** Thin payload — event `type` and `id`, NOT the full object. Fetch with a GET. */
export const WebhookPayload = z.object({
  type: z.string(),
  id: z.string(),
  createdAt: Timestamp,
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
