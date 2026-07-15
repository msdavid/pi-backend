import type { WebhookEvent, WebhookSink } from "@pi-managed/backend";

/**
 * In-memory fake `WebhookSink` (spec §23). Records dispatched payloads; the real
 * dispatcher (retries, signatures, auto-disable) lands in Phase 2 (WP-2.5).
 */
export class FakeWebhookSink implements WebhookSink {
  readonly dispatched: WebhookEvent[] = [];

  async dispatch(event: WebhookEvent): Promise<void> {
    this.dispatched.push(event);
  }
}
