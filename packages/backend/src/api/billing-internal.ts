/**
 * Machine credit-surface (console spec §11.7, WP-C5.1) — the narrow, MACHINE-
 * authenticated seam the billing adapter (WP-C5.3, a separate package/process)
 * calls to credit a tenant's ledger after a payment webhook.
 *
 * **This is an internal channel, not a public `/v1` route.** It is mounted under
 * `/internal/*` and authenticated with a per-deployment shared secret in the
 * host-agent pattern (`infra/sandbox-host-pool/auth.ts`): `Authorization: Bearer
 * <token>`, constant-time compared, env-sourced (`BILLING_PROVISION_TOKEN`), and
 * fail-closed — a missing/blank secret rejects EVERY request. It is emphatically
 * NOT a tenant API key: it can credit any tenant, so it never rides the tenant
 * auth path (the path is on `PUBLIC_PATHS`, and this plugin does its own machine
 * auth in a preHandler).
 *
 * The credit is idempotent under webhook replay (console spec §13): the same
 * `idempotencyKey` credits the ledger EXACTLY ONCE — the ledger's UNIQUE
 * constraint is the gate (see `domain/billing/ledger.ts`).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { appendEntry, microsToUsd } from "../domain/billing/index.js";

/** Path the billing adapter POSTs to. On `PUBLIC_PATHS` (machine-authed here). */
export const BILLING_CREDIT_PATH = "/internal/billing/credit";

export interface BillingInternalRoutesOptions {
  pool: Pool;
  /**
   * The machine shared secret (config `BILLING_PROVISION_TOKEN`). When absent or
   * blank the surface is fail-closed: every request is rejected 401.
   */
  provisionToken?: string;
}

/** Request body for `POST /internal/billing/credit`. Amount is integer micro-dollars. */
const CreditRequest = z.object({
  tenantId: z.string().min(1),
  /** Positive integer micro-dollars to credit (1 USD = 1_000_000). */
  amountMicros: z.number().int().positive(),
  /** Idempotency key (per tenant) — a replay credits exactly once. */
  idempotencyKey: z.string().min(1),
  /** Provenance label recorded on the entry (e.g. `stripe`). Never a secret. */
  source: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Constant-time bearer check against the machine secret (host-agent pattern).
 * Both sides are SHA-256 digested before {@link timingSafeEqual} so neither the
 * token value nor its length leaks via timing. Fail-closed on a blank expected
 * secret.
 */
function isValidMachineToken(authorization: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false; // fail closed: no secret configured ⇒ reject all.
  if (!authorization) return false;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const presented = match[1];
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const billingInternalRoutes: FastifyPluginAsync<BillingInternalRoutesOptions> = async (
  app,
  opts,
) => {
  // Machine auth on every route in this plugin. Rejecting here (preHandler) keeps
  // the tenant-auth path untouched — a tenant API key must NOT authenticate this.
  app.addHook("preHandler", async (req: FastifyRequest) => {
    if (!isValidMachineToken(req.headers.authorization, opts.provisionToken)) {
      throw new ApiError(401, "unauthorized", "invalid or missing machine credential");
    }
  });

  // POST /internal/billing/credit — credit a tenant's ledger idempotently.
  app.post(BILLING_CREDIT_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreditRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "invalid_request",
        `invalid credit request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const { tenantId, amountMicros, idempotencyKey, source, metadata } = parsed.data;
    const result = await appendEntry(opts.pool, {
      tenantId,
      kind: "topup",
      amountMicros,
      idempotencyKey,
      source: source ?? "machine-credit",
      ...(metadata ? { metadata } : {}),
    });
    // 200 (not 201): a replay returns the existing entry unchanged (`applied:false`).
    return reply.status(200).send({
      entryId: result.entry.id,
      applied: result.applied,
      lifecycle: result.lifecycle,
      balanceMicros: result.balanceMicros,
      balanceUsd: microsToUsd(result.balanceMicros),
    });
  });
};
