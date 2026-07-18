/**
 * Onboarding routes (WP-5.2, §29.6).
 *
 * `POST /v1/onboarding/signup` is the **public, unauthenticated** sign-up
 * endpoint for the SaaS tenant-onboarding flow. On a first sign-up it creates a
 * tenant + an admin API key (shown once) and returns the `pi install` command +
 * backend URL the client needs (§29.6, §24.3).
 *
 * On a repeat sign-up for an existing `adminEmail` the response omits `apiKey`
 * (no credential is re-issued to a public caller — R0.3). The response shape is
 * otherwise identical, so it never leaks which admin emails already exist.
 *
 * The route is gated by `onboarding.enabled` (config `ONBOARDING_ENABLED`) so
 * self-hosted deployments can disable open tenant creation; disabled → `403`.
 *
 * WP-C5.1 (console spec §11.1): in a billing-enabled deployment a fresh sign-up
 * also provisions the $5 trial (a PENDING grant + a verification token) and sends
 * the verification email. `POST /v1/onboarding/verify-email` (also public — the
 * emailed token is the bearer of authority) activates that grant EXACTLY once and
 * moves the tenant `trial → active`.
 *
 * Auth bypass: the path is in {@link PUBLIC_PATHS} (`api/middleware/auth.ts`)
 * so the global bearer-auth hook skips it. It is registered in `server.ts`
 * before the auth hook (per WP-5.2) so the order is explicit even though the
 * allowlist is what actually grants the bypass.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { VerifyEmailRequest } from "@pi-managed/contracts";
import { type Pool } from "../infra/db/index.js";
import { ApiError } from "../domain/errors.js";
import { SignupInputSchema, signup } from "../domain/onboarding/signup.js";
import { provisionTrial, verifyEmail } from "../domain/billing/index.js";
import type { EmailSender } from "../domain/ports.js";

export interface OnboardingRoutesOptions {
  pool: Pool;
  /** When `false`, the sign-up route returns `403 forbidden` (§29.6). */
  enabled: boolean;
  /**
   * WP-C5.1: when `true` (saas, config `BILLING_ENABLED`), a fresh sign-up also
   * provisions the $5 trial as a PENDING grant + verification token and sends the
   * verification email through {@link emailSender} (console spec §11.1). Solo/team
   * leave this `false` and get no balance mechanics.
   */
  billingEnabled?: boolean;
  /** Email seam for the trial verification message (default no-op recorder). */
  emailSender?: EmailSender;
}

export const onboardingRoutes: FastifyPluginAsync<OnboardingRoutesOptions> = async (
  app,
  opts,
) => {
  // POST /v1/onboarding/signup — public sign-up (unauthenticated). Creates a
  // tenant + admin key and returns the install instructions (§29.6, §24.3). A
  // repeat sign-up for an existing email reuses the tenant and omits `apiKey`
  // (no re-issuance to an unauthenticated caller — R0.3); the send below
  // tolerates the absent field (JSON drops the undefined key).
  app.post(
    "/v1/onboarding/signup",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!opts.enabled) {
        throw new ApiError(403, "forbidden", "onboarding is disabled");
      }
      const parsed = SignupInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "invalid_request",
          `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const result = await signup(opts.pool, parsed.data);
      // WP-C5.1: on a FRESH sign-up (a key was issued) in a billing-enabled
      // deployment, provision the $5 trial as a PENDING grant + verification
      // token and send the verification email. Best-effort: a mail hiccup must
      // not fail the sign-up (the tenant can resend). No balance mechanics at all
      // when billing is disabled (solo/team).
      if (opts.billingEnabled && opts.emailSender && result.apiKey) {
        try {
          await provisionTrial(
            opts.pool,
            result.tenantId,
            parsed.data.adminEmail,
            opts.emailSender,
          );
        } catch {
          /* best-effort: trial provisioning must never fail sign-up */
        }
      }
      return reply.status(201).send(result);
    },
  );

  // POST /v1/onboarding/verify-email — public: activate the pending trial grant
  // from the emailed single-use token (console spec §11.1). Idempotent — a replay
  // (already-verified token) still returns `verified:true` and never re-grants.
  // Public path (the link is clicked by an unauthenticated browser); on
  // PUBLIC_PATHS so the bearer-auth hook skips it.
  app.post(
    "/v1/onboarding/verify-email",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = VerifyEmailRequest.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(
          422,
          "invalid_request",
          `invalid request body: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      const result = await verifyEmail(opts.pool, parsed.data.token);
      return reply.status(200).send(result);
    },
  );
};
