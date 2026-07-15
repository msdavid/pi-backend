/**
 * Webhook event sources (WP-2.5, §23.1).
 *
 * Event sources (session/thread/outcome lifecycle, vault + credential lifecycle,
 * job/run events) emit typed events through a {@link WebhookEventSource}. The
 * source is the tenant-aware enqueue seam: it forwards a thin
 * {@link WebhookEvent} (`type` + `id` + `createdAt`) to the dispatcher, which
 * fans out to the tenant's active webhooks subscribed to that type.
 *
 * Wiring point: the composition root (`app.ts`) constructs a single
 * {@link WebhookEventSource} backed by the {@link WebhookDispatcher} and injects
 * it into the session manager / vault service / scheduler so their lifecycle
 * transitions call {@link emit}. The exact call sites live in those subsystems
 * (owned by other WPs); this module defines the contract + default impl.
 */

import type { TenantId } from "../ports.js";
import type { WebhookEventType } from "@pi-managed/contracts";
import { newId } from "../tenant/ids.js";
import type { WebhookDispatcher } from "./dispatcher.js";

/**
 * Tenant-scoped emitter for webhook lifecycle events (§23.1). `id` defaults to
 * a fresh `evt_…` id; `createdAt` defaults to now. Recipients fetch the full
 * object on receipt (§23.2) — only `type` + `id` + `createdAt` are delivered.
 */
export interface WebhookEventSource {
  emit(
    tenantId: TenantId,
    type: WebhookEventType,
    id?: string,
    createdAt?: string,
  ): Promise<void>;
}

/** Build an event source backed by a {@link WebhookDispatcher}. */
export function createWebhookEventSource(
  dispatcher: WebhookDispatcher,
): WebhookEventSource {
  return {
    async emit(tenantId, type, id, createdAt) {
      await dispatcher.enqueueForTenant(tenantId, {
        type,
        id: id ?? newId("evt_"),
        createdAt: createdAt ?? new Date().toISOString(),
      });
    },
  };
}

/** A no-op event source (default when webhooks are not wired). */
export const NOOP_EVENT_SOURCE: WebhookEventSource = {
  async emit() {
    /* no-op */
  },
};
