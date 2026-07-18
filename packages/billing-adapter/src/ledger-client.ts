/**
 * HTTP client for the backend machine credit-surface (`POST /internal/billing/
 * credit`, console spec §11.7, WP-C5.1).
 *
 * The adapter is a MACHINE actor: it authenticates with the shared
 * `BILLING_PROVISION_TOKEN` in the host-agent bearer pattern — NOT a tenant API
 * key — and can credit any tenant. This is the sole path a payment reaches the
 * ledger. Idempotency is the backend's UNIQUE key (`creditKeyForPayment`); this
 * client just forwards a stable key and reads back `applied`.
 */

import type { LedgerClient, LedgerCreditInput, LedgerCreditResult } from "./types.js";

/** Wire path of the machine credit-surface (mirrors `BILLING_CREDIT_PATH`). */
export const CREDIT_PATH = "/internal/billing/credit";

/** Minimal `fetch` shape so a real listening backend (integration tests) drives the seam. */
export type FetchLike = typeof fetch;

export interface HttpLedgerClientOptions {
  /** Backend base URL, e.g. `https://api.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** The machine bearer secret (`BILLING_PROVISION_TOKEN`). Fail-closed when blank. */
  provisionToken: string;
  /** `fetch` impl; defaults to the global. Real HTTP in production and in seam tests. */
  fetchImpl?: FetchLike;
}

/** Thrown when the credit-surface responds with a non-2xx status. */
export class LedgerCreditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LedgerCreditError";
  }
}

/** The production {@link LedgerClient}: a Bearer-authed POST to the credit-surface. */
export class HttpLedgerClient implements LedgerClient {
  private readonly baseUrl: string;
  private readonly provisionToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: HttpLedgerClientOptions) {
    if (!opts.provisionToken?.trim()) {
      // Fail-closed: without the machine secret the adapter cannot credit anything.
      throw new Error("HttpLedgerClient requires a non-blank provisionToken");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.provisionToken = opts.provisionToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async credit(input: LedgerCreditInput): Promise<LedgerCreditResult> {
    const res = await this.fetchImpl(`${this.baseUrl}${CREDIT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.provisionToken}`,
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        amountMicros: input.amountMicros,
        idempotencyKey: input.idempotencyKey,
        ...(input.source ? { source: input.source } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    });
    if (!res.ok) {
      throw new LedgerCreditError(
        `credit-surface responded ${res.status}`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      entryId: string;
      applied: boolean;
      balanceMicros: number;
    };
    return { entryId: body.entryId, applied: body.applied, balanceMicros: body.balanceMicros };
  }
}
