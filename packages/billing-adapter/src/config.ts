/**
 * Adapter configuration — sourced from the environment at RUNTIME and fail-closed
 * (console spec §11.7, host-agent posture).
 *
 * The two credentials the adapter holds — the payment-engine secret key and the
 * webhook signing secret — are read from env exactly like the host-agent token:
 * never hardcoded, never logged, and a **missing/blank value fails closed** (the
 * adapter refuses to start rather than issuing checkout URLs it can't complete or
 * accepting webhooks it can't verify). No real credential ships in this package;
 * tests never supply one (they inject a fake engine or generate an obviously
 * test-only signing secret locally).
 */

/** Env-like map (string | undefined), matching the backend's `infra/config`. */
export type EnvLike = Record<string, string | undefined>;

/** Resolved adapter configuration. */
export interface AdapterConfig {
  /** Payment-engine secret key (`STRIPE_SECRET_KEY`, `sk_…`). Never logged. */
  stripeSecretKey: string;
  /** Webhook signing secret (`STRIPE_WEBHOOK_SECRET`, `whsec_…`). Never logged. */
  stripeWebhookSecret: string;
  /** Backend base URL the machine credit-surface lives on (`PI_BACKEND_URL`). */
  backendBaseUrl: string;
  /** Machine credit-surface bearer secret (`BILLING_PROVISION_TOKEN`); NOT a tenant key. */
  provisionToken: string;
  /** Where hosted checkout returns on success (`BILLING_CHECKOUT_SUCCESS_URL`). */
  checkoutSuccessUrl: string;
  /** Where hosted checkout returns on cancel (`BILLING_CHECKOUT_CANCEL_URL`). */
  checkoutCancelUrl: string;
  /** Where the hosted portal returns (`BILLING_PORTAL_RETURN_URL`). */
  portalReturnUrl: string;
  /** Consecutive-failure count that auto-disables auto-charge (`AUTO_CHARGE_MAX_FAILURES`). */
  maxConsecutiveFailures: number;
}

/** Thrown when a required config value is missing/blank (fail-closed). */
export class AdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigError";
  }
}

/** Default consecutive-failure threshold before auto-charge auto-disables (§11.7). */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new AdapterConfigError(`missing required config: ${name}`);
  }
  return value;
}

/**
 * Load {@link AdapterConfig} from an env map, failing closed on any missing
 * required secret or URL. Optional knobs fall back to documented defaults.
 */
export function loadAdapterConfig(env: EnvLike): AdapterConfig {
  const maxRaw = env.AUTO_CHARGE_MAX_FAILURES?.trim();
  const maxConsecutiveFailures = maxRaw ? Number(maxRaw) : DEFAULT_MAX_CONSECUTIVE_FAILURES;
  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
    throw new AdapterConfigError(
      `AUTO_CHARGE_MAX_FAILURES must be a positive integer, got ${maxRaw}`,
    );
  }
  return {
    stripeSecretKey: required(env, "STRIPE_SECRET_KEY"),
    stripeWebhookSecret: required(env, "STRIPE_WEBHOOK_SECRET"),
    backendBaseUrl: required(env, "PI_BACKEND_URL"),
    provisionToken: required(env, "BILLING_PROVISION_TOKEN"),
    checkoutSuccessUrl: required(env, "BILLING_CHECKOUT_SUCCESS_URL"),
    checkoutCancelUrl: required(env, "BILLING_CHECKOUT_CANCEL_URL"),
    portalReturnUrl: required(env, "BILLING_PORTAL_RETURN_URL"),
    maxConsecutiveFailures,
  };
}
