/**
 * Webhook-emitting billing sink (WP-5.3, §29.6).
 *
 * Posts each aggregated {@link MeteringEvent} (§11.4: time-bucketed) to an
 * operator-configured billing webhook endpoint over **HTTPS**, signed with the same
 * `X-Webhook-Signature` scheme as the webhook dispatcher (§23.4 —
 * `t=<unix-ms>,v1=<hmac>` over `${t}.${rawBody}`). Delivery is **at-least-once**: a
 * non-2xx or network failure is retried with exponential backoff up to
 * `maxAttempts`; recipients MUST dedup via the event's `idempotencyKey` (stable per
 * `(tenant, bucket)`), also surfaced in the `X-Metering-Id` header.
 *
 * The billing endpoint is **operator-configured** (config/env, not tenant input),
 * but the *payload* is agent-influenced (model id, token counts) and the endpoint
 * is still a URL this process connects to — so egress goes through the SAME
 * SSRF-pinned transport as every other egress surface ({@link safeFetchPinned},
 * `domain/net/ssrf-pin.ts`): resolve → assert public → connect to the *validated*
 * IP (no DNS-rebind window) with the hostname preserved for SNI/cert validation,
 * ports restricted to 80/443, redirects not followed. On top of that the endpoint
 * MUST be `https:` (the signing secret would otherwise travel in cleartext, §25.5).
 *
 * Note: `safeFetchPinned` strips inherited `Authorization`/`Cookie` headers, so
 * {@link WebhookBillingSinkOptions.headers} cannot carry bearer credentials —
 * recipients authenticate the delivery via `X-Webhook-Signature` (HMAC).
 *
 * `recordMetering` never throws: exhausted retries are logged and dropped so
 * metering never blocks usage recording (§29.6). A blocked-egress (SSRF) result is
 * terminal — retrying a private-IP endpoint cannot succeed — so it is logged and
 * dropped immediately. No new deps.
 */

import type { Logger } from "pino";
import type { BillingSink, MeteringEvent } from "./sink.js";
import { signWebhookPayload } from "../webhook/index.js";
import {
  safeFetchPinned,
  type PinnedDnsResolver,
} from "../net/ssrf-pin.js";

/**
 * Egress to the billing endpoint was blocked by the SSRF guard (non-public IP,
 * disallowed port/scheme, redirect chain). Terminal — never retried.
 */
export class BillingSsrfError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "BillingSsrfError";
  }
}

/** Default cap on delivery attempts per metering event. */
export const DEFAULT_BILLING_MAX_ATTEMPTS = 5;

/** Default exponential backoff (ms) for attempt N (1-based), capped at 10 min. */
export function defaultBillingBackoff(attempt: number): number {
  const base = 5_000; // 5 s
  const cap = 10 * 60 * 1000; // 10 min
  return Math.min(cap, base * 2 ** (attempt - 1));
}

/** Options for {@link WebhookBillingSink}. */
export interface WebhookBillingSinkOptions {
  /** Billing webhook endpoint. MUST be `https:`. */
  endpoint: string;
  /** HMAC signing secret (`whsec_…`, shared with the billing recipient). */
  signingSecret: string;
  logger?: Logger;
  maxAttempts?: number;
  backoff?: (attempt: number) => number;
  /**
   * Injectable fetch (tests). When set, {@link safeFetchPinned} calls it instead of
   * the pinned transport — the public-IP assertion still runs first. Defaults to the
   * pinned Node transport.
   */
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver for the SSRF assertion (tests). */
  dnsResolver?: PinnedDnsResolver;
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Optional extra headers. `authorization`/`cookie` are stripped by the pinned
   * transport — the delivery is authenticated by `X-Webhook-Signature`, not a bearer.
   */
  headers?: Record<string, string>;
}

/**
 * Posts metering events to a billing webhook endpoint (HTTPS, signed,
 * at-least-once). One instance per service (stateless beyond config); safe to
 * share across requests.
 */
export class WebhookBillingSink implements BillingSink {
  private readonly endpoint: string;
  private readonly secret: string;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly dnsResolver: PinnedDnsResolver | undefined;
  private readonly now: () => Date;
  private readonly headers: Record<string, string>;

  constructor(opts: WebhookBillingSinkOptions) {
    const url = parseHttps(opts.endpoint);
    this.endpoint = url.toString();
    this.secret = opts.signingSecret;
    this.logger = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_BILLING_MAX_ATTEMPTS;
    this.backoff = opts.backoff ?? defaultBillingBackoff;
    this.fetchImpl = opts.fetchImpl;
    this.dnsResolver = opts.dnsResolver;
    this.now = opts.now ?? (() => new Date());
    this.headers = { "content-type": "application/json", ...opts.headers };
  }

  async recordMetering(event: MeteringEvent): Promise<void> {
    // The event's `idempotencyKey` (stable per tenant+bucket) is the dedup id;
    // surfaced in the header too so recipients can dedup without parsing the body.
    const meteringId = event.idempotencyKey;
    const rawBody = JSON.stringify(event);
    const headers = { ...this.headers, "x-metering-id": meteringId };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const outcome = await this.tryOnce(rawBody, headers);
      if (outcome === "ack") return;
      if (outcome === "abort") {
        // Blocked egress (SSRF) — terminal, retrying cannot succeed.
        this.logger?.error(
          { endpoint: this.endpoint, meteringId, tenantId: event.tenantId },
          "billing metering delivery blocked by SSRF guard (dropped)",
        );
        return;
      }

      if (attempt < this.maxAttempts) {
        await sleep(this.backoff(attempt));
      }
    }
    // Exhausted retries — log and drop. Metering must not throw (§29.6).
    this.logger?.warn(
      { endpoint: this.endpoint, meteringId, tenantId: event.tenantId },
      "billing metering delivery exhausted retries (dropped)",
    );
  }

  /**
   * One delivery attempt over the SSRF-pinned transport.
   * `ack` — 2xx; `retry` — network error / non-2xx / redirect; `abort` — blocked
   * by the SSRF guard (terminal).
   */
  private async tryOnce(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<"ack" | "retry" | "abort"> {
    const signature = signWebhookPayload(rawBody, this.secret, this.now());
    let res: Response;
    try {
      const { response } = await safeFetchPinned(
        this.endpoint,
        {
          method: "POST",
          headers: { ...headers, "x-webhook-signature": signature },
          body: rawBody,
          redirect: "manual", // redirects NOT followed (defensive; §23.5)
        },
        this.dnsResolver,
        {
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          errorFactory: (message, reason) => new BillingSsrfError(message, reason),
        },
      );
      res = response;
    } catch (err) {
      if (err instanceof BillingSsrfError) {
        this.logger?.warn(
          { endpoint: this.endpoint, reason: err.reason },
          "billing metering endpoint blocked by SSRF guard",
        );
        return "abort";
      }
      // Network error / refused → retry (at-least-once).
      this.logger?.debug(
        { err: String(err), endpoint: this.endpoint },
        "billing metering delivery network error (will retry)",
      );
      return "retry";
    }

    const code = res.type === "opaqueredirect" ? 0 : res.status;
    if (res.type === "opaqueredirect" || (code >= 300 && code < 400)) {
      // Redirects are not a successful ack — retry once, then drop.
      return "retry";
    }
    if (code >= 200 && code < 300) {
      return "ack";
    }
    // 4xx/5xx → retry (at-least-once).
    return "retry";
  }
}

/** Parse + assert `https:` (the secret must never travel in cleartext, §25.5). */
function parseHttps(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`WebhookBillingSink: invalid endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `WebhookBillingSink: endpoint MUST be https: (got ${url.protocol}) — billing signing secret cannot travel in cleartext (§25.5)`,
    );
  }
  return url;
}

/** Promise-based sleep (no deps). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
