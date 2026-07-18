/**
 * Composition root for the billing adapter (console spec §11.7, WP-C5.3).
 *
 * Wires the four pieces from {@link AdapterConfig}: the Stripe {@link StripeEngine}
 * (the only SDK holder), the {@link HttpLedgerClient} (machine credit-surface),
 * the payment-webhook consumer, and the {@link AutoChargeEngine}. Everything above
 * the engine seam is engine-neutral, so this is the one place Stripe is named.
 *
 * The adapter runs as a SEPARATE concern from the backend request path: a webhook
 * receiver (calls {@link BillingAdapter.handleWebhook}) plus a `tenant.balance_low`
 * subscriber that calls {@link BillingAdapter.onLowBalance}. The Stripe SDK is
 * never imported into `packages/backend`.
 */

import type { AdapterConfig } from "./config.js";
import { createStripeEngine } from "./stripe-engine.js";
import { HttpLedgerClient, type FetchLike } from "./ledger-client.js";
import { handleWebhook, type HandleWebhookResult } from "./webhook-consumer.js";
import {
  AutoChargeEngine,
  type AutoChargeStore,
  type AutoChargeNotifier,
  type AutoChargeResult,
} from "./auto-charge.js";
import type { PaymentEngine, LedgerClient } from "./types.js";
import type { TenantBalanceEventData } from "@pi-managed/contracts";

/** Collaborators a production deployment supplies (durable store + real notifier). */
export interface BillingAdapterDeps {
  store: AutoChargeStore;
  notifier: AutoChargeNotifier;
  /** Override the payment engine (tests inject a fake Stripe client here). */
  engine?: PaymentEngine;
  /** Override the ledger client (defaults to {@link HttpLedgerClient}). */
  ledger?: LedgerClient;
  /** Override `fetch` for the default ledger client (real HTTP by default). */
  fetchImpl?: FetchLike;
  /** Injectable clock for auto-charge cap windows (tests). */
  now?: () => Date;
}

/** The wired adapter surface a receiver/subscriber process drives. */
export class BillingAdapter {
  readonly engine: PaymentEngine;
  readonly ledger: LedgerClient;
  readonly autoCharge: AutoChargeEngine;
  private readonly config: AdapterConfig;

  constructor(config: AdapterConfig, deps: BillingAdapterDeps) {
    this.config = config;
    this.engine =
      deps.engine ??
      createStripeEngine({
        secretKey: config.stripeSecretKey,
        webhookSecret: config.stripeWebhookSecret,
      });
    this.ledger =
      deps.ledger ??
      new HttpLedgerClient({
        baseUrl: config.backendBaseUrl,
        provisionToken: config.provisionToken,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    this.autoCharge = new AutoChargeEngine({
      engine: this.engine,
      ledger: this.ledger,
      store: deps.store,
      notifier: deps.notifier,
      maxConsecutiveFailures: config.maxConsecutiveFailures,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  /** Issue a hosted checkout URL for a one-time top-up (the console links out to it). */
  createCheckoutUrl(tenantId: string, amountMicros: number): Promise<string> {
    return this.engine.createCheckoutUrl({
      tenantId,
      amountMicros,
      successUrl: this.config.checkoutSuccessUrl,
      cancelUrl: this.config.checkoutCancelUrl,
    });
  }

  /** Issue a hosted customer/billing portal URL (receipts, saved cards; console links out). */
  createPortalUrl(tenantId: string, customerRef: string): Promise<string> {
    return this.engine.createPortalUrl({
      tenantId,
      customerRef,
      returnUrl: this.config.portalReturnUrl,
    });
  }

  /** Verify + process one payment webhook, crediting the ledger idempotently. */
  handleWebhook(rawBody: string | Buffer, signatureHeader: string): Promise<HandleWebhookResult> {
    return handleWebhook({ engine: this.engine, ledger: this.ledger }, rawBody, signatureHeader);
  }

  /** React to a `tenant.balance_low` event by auto-charging (subject to opt-in + caps). */
  onLowBalance(event: TenantBalanceEventData): Promise<AutoChargeResult> {
    return this.autoCharge.onLowBalance(event);
  }
}
