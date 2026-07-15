/**
 * Webhook subsystem barrel (WP-2.5, §23).
 *
 * Endpoint registration, signature, persisted at-least-once retry queue,
 * auto-disable, SSRF guard, and the tenant-aware event-source seam. Routes live
 * in `api/webhooks.ts`; the dispatcher retry loop is started by `server.ts`.
 */

export {
  sign as signWebhookPayload,
  verify as verifyWebhookSignature,
  DEFAULT_SIGNATURE_MAX_AGE_MS,
  type VerifyResult,
} from "./signature.js";

export {
  isPrivateAddress,
  resolveAndAssertPublic,
  defaultWebhookDnsResolver,
  WebhookSsrfError,
  type WebhookDnsResolver,
} from "./ssrf.js";

export {
  createWebhook,
  listWebhooks,
  getWebhook,
  getWebhookWithSecret,
  deleteWebhook,
  testDelivery,
  decryptStoredSecret,
  isWebhookSecret,
  EndpointValidationError,
  type WebhookStatus,
  type WebhookRow,
  type CreatedWebhook,
  type WebhookWithSecret,
  type TestDeliveryResult,
  type TestDeliveryDeps,
} from "./webhook.js";

export {
  disableWebhook,
  shouldDisableForStreak,
  DISABLE_STREAK_THRESHOLD,
  DISABLE_REASON,
} from "./auto-disable.js";

export {
  WebhookDispatcher,
  startDispatcherLoop,
  defaultBackoff,
  DEFAULT_DISPATCHER_INTERVAL_MS,
  DEFAULT_DISPATCHER_BATCH,
  DEFAULT_MAX_ATTEMPTS,
  type DispatcherOptions,
  type DispatcherHandle,
} from "./dispatcher.js";

export {
  createWebhookEventSource,
  NOOP_EVENT_SOURCE,
  type WebhookEventSource,
} from "./event-source.js";
