/**
 * No-op email sender (console spec §11.1, WP-C5.1) — the dev/test default.
 *
 * The default {@link EmailSender}: it delivers NOTHING to a real inbox and instead
 * records each {@link OutgoingEmail} in memory, so a dev flow or an integration
 * test can read the verification token from the "sent" message rather than a real
 * mailbox. A production deployment swaps in a real sender (SES / Postmark / SMTP)
 * — the provider SDK and credential live only inside that impl.
 *
 * Mirrors `NOOP_BILLING_SINK` (domain/billing/noop-sink.ts): a benign default
 * that keeps the seam live without integrating a provider.
 */

import type { EmailSender, OutgoingEmail } from "../ports.js";

/** An {@link EmailSender} that records messages instead of delivering them. */
export class NoopEmailSender implements EmailSender {
  /** Every email "sent", in order — read by dev flows and tests. */
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }

  /** The most recent email sent to `to`, or `undefined`. */
  lastTo(to: string): OutgoingEmail | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to === to) return this.sent[i];
    }
    return undefined;
  }
}

/** Shared no-op sender instance (a benign default; billing disabled or dev). */
export const NOOP_EMAIL_SENDER = new NoopEmailSender();
