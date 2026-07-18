/**
 * `/v1/tenant/billing` family — fetchers + hooks (WP-C5.4; console-spec
 * §11.1/§11.3/§11.7–11.9, journey W15). saas commercialization.
 *
 * Mirrors `contracts/src/billing.ts` and api-reference §"Billing (saas)". Two
 * tiers of surface, deliberately separate:
 *
 *  - **Ledger tier (always real).** `GET /v1/tenant/billing` (balance +
 *    lifecycle + verification), `GET /v1/tenant/billing/ledger` (history),
 *    `POST …/verification/resend`, `POST /v1/onboarding/verify-email`. These
 *    are the backend ledger — the SOURCE OF TRUTH for balance (§11.3). A
 *    tenant not enrolled `404`s on `GET /v1/tenant/billing`; the console reads
 *    that as "no billing".
 *
 *  - **Adapter tier (present only with a billing-adapter proxy).**
 *    auto-charge get/update + checkout/portal link-out (§11.7). Served only
 *    when a deployment fronts `packages/billing-adapter` with an SDK-free `/v1`
 *    proxy; ABSENT that, every route `404`s and the console shows the
 *    no-adapter state — money controls gone, everything else works (§11.8).
 *    {@link getAutoCharge} doubles as the adapter-presence probe: it maps
 *    `404` to `null` ("no adapter") instead of throwing, so the whole money
 *    surface keys off one signal.
 *
 * MONEY (§11.9): every figure the console shows comes from these shapes —
 * `balanceUsd`, `amountUsd`, `*CapUsd` are server-divided companions the UI
 * renders verbatim; it never multiplies/divides a money field. The only
 * arithmetic on money anywhere in the console is the runway *day-count*
 * projection (`src/lib/runway.ts`), which yields days, not dollars.
 */

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AutoChargeConfig,
  type AutoChargeUpdate,
  BillingHostedLink,
  type CheckoutSessionRequest,
  Cursor,
  LedgerEntry,
  TenantBillingState,
  VerificationResendResponse,
  VerifyEmailResponse,
  type VerifyEmailRequest,
} from "@pi-managed/contracts";
import { apiClient, ConsoleApiError, type ConsoleApi } from "./client.js";
import { billingKeys } from "./keys.js";
import { cursorPageParams, withQuery } from "./pagination.js";
import { useApiClient } from "./provider.js";

const LedgerPage = Cursor(LedgerEntry);

// --- Fetchers (ledger tier — always real) ------------------------------------

/**
 * `GET /v1/tenant/billing` — balance + lifecycle + verification state. Throws
 * a `404` {@link ConsoleApiError} when the tenant is not enrolled in the
 * ledger; callers render that as "no billing" (§11.8).
 */
export function getBilling(
  client: ConsoleApi = apiClient,
): Promise<TenantBillingState> {
  return client.get("/v1/tenant/billing", TenantBillingState);
}

/** `GET /v1/tenant/billing/ledger` — append-only history, newest first. */
export function getLedger(
  params: { limit?: number; cursor?: string } = {},
  client: ConsoleApi = apiClient,
): Promise<Cursor<LedgerEntry>> {
  return client.get(withQuery("/v1/tenant/billing/ledger", params), LedgerPage);
}

/** `POST /v1/tenant/billing/verification/resend` — re-send the trial
 * verification email (§11.1). No-op (`sent:false`) once verified; `write`. */
export function resendVerification(
  client: ConsoleApi = apiClient,
): Promise<VerificationResendResponse> {
  return client.post(
    "/v1/tenant/billing/verification/resend",
    {},
    VerificationResendResponse,
  );
}

/** `POST /v1/onboarding/verify-email` — activate the trial grant from the
 * emailed token (public; idempotent — a replay still returns `verified:true`
 * and never re-grants, §11.1). */
export function verifyEmail(
  body: VerifyEmailRequest,
  client: ConsoleApi = apiClient,
): Promise<VerifyEmailResponse> {
  return client.post("/v1/onboarding/verify-email", body, VerifyEmailResponse);
}

// --- Fetchers (adapter tier — present only with the adapter proxy) -----------

/**
 * `GET /v1/tenant/billing/auto-charge` — the auto-charge config AND the
 * adapter-presence probe. A `404` (no adapter proxy configured) resolves to
 * `null` — the single "no adapter" signal the whole money surface reads
 * (§11.8) — rather than throwing; any other error propagates.
 */
export async function getAutoCharge(
  client: ConsoleApi = apiClient,
): Promise<AutoChargeConfig | null> {
  try {
    return await client.get("/v1/tenant/billing/auto-charge", AutoChargeConfig);
  } catch (err) {
    if (err instanceof ConsoleApiError && err.status === 404) return null;
    throw err;
  }
}

/** `PATCH /v1/tenant/billing/auto-charge` — update toggle/threshold/amount
 * (USD in, the adapter converts to micros — no browser money math, §11.9). */
export function updateAutoCharge(
  body: AutoChargeUpdate,
  client: ConsoleApi = apiClient,
): Promise<AutoChargeConfig> {
  return client.patch("/v1/tenant/billing/auto-charge", body, AutoChargeConfig);
}

/** `POST /v1/tenant/billing/checkout` — issue a hosted top-up URL to redirect
 * to (the card is entered on the payment engine's page, never here, §11.9). */
export function createCheckout(
  body: CheckoutSessionRequest = {},
  client: ConsoleApi = apiClient,
): Promise<BillingHostedLink> {
  return client.post("/v1/tenant/billing/checkout", body, BillingHostedLink);
}

/** `POST /v1/tenant/billing/portal` — issue a hosted receipts / payment-method
 * portal URL to redirect to (§11.8 receipts link-out). */
export function createPortal(
  client: ConsoleApi = apiClient,
): Promise<BillingHostedLink> {
  return client.post("/v1/tenant/billing/portal", {}, BillingHostedLink);
}

// --- Query options + hooks ---------------------------------------------------

export function billingOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: billingKeys.state(),
    queryFn: () => getBilling(client),
    // Not-enrolled (404) is a stable "no billing" answer, not a transient
    // failure — don't hammer the endpoint retrying it.
    retry: (count, err) =>
      !(err instanceof ConsoleApiError && err.status === 404) && count < 2,
  });
}

/** Balance + lifecycle + verification (§11.1). 404 ⇒ "no billing". `enabled`
 * lets a caller withhold the query out of saas mode (billing is saas-only) so
 * solo/team never even probe the ledger. */
export function useBilling(opts: { enabled?: boolean } = {}) {
  return useQuery({ ...billingOptions(useApiClient()), enabled: opts.enabled ?? true });
}

export function ledgerOptions(
  params: { limit?: number } = {},
  client: ConsoleApi = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: billingKeys.ledger(params),
    queryFn: ({ pageParam }) =>
      getLedger({ ...params, cursor: pageParam }, client),
    ...cursorPageParams,
  });
}

/** Ledger history — grants / top-ups / debits / auto-charges (§11.3). */
export function useLedger(params: { limit?: number } = {}) {
  return useInfiniteQuery(ledgerOptions(params, useApiClient()));
}

export function autoChargeOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: billingKeys.autoCharge(),
    queryFn: () => getAutoCharge(client),
  });
}

/** Auto-charge config, or `null` when no adapter is configured (§11.8). The
 * whole money surface (top-up, portal, auto-charge) keys off this being
 * non-null. */
export function useAutoCharge() {
  return useQuery(autoChargeOptions(useApiClient()));
}

/** Re-send the trial verification email (§11.1). */
export function useResendVerification() {
  const client = useApiClient();
  return useMutation({
    mutationFn: () => resendVerification(client),
  });
}

/** Verify the emailed token; on success the $5 grant activates and the
 * billing state flips to `verified` (§11.1) — refresh it. */
export function useVerifyEmail() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: VerifyEmailRequest) => verifyEmail(body, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}

/** Update auto-charge; a change to threshold/amount/enabled can move the
 * balance-protection posture — refresh the config + balance. */
export function useUpdateAutoCharge() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AutoChargeUpdate) => updateAutoCharge(body, client),
    onSuccess: (config) => {
      queryClient.setQueryData(billingKeys.autoCharge(), config);
      void queryClient.invalidateQueries({ queryKey: billingKeys.state() });
    },
  });
}

/** Issue a hosted checkout URL. The caller redirects the browser to it; the
 * webhook credits the ledger idempotently, so the balance we read on return is
 * authoritative (§11.7). */
export function useCreateCheckout() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: CheckoutSessionRequest = {}) =>
      createCheckout(body, client),
  });
}

/** Issue a hosted receipts / payment-method portal URL to redirect to. */
export function useCreatePortal() {
  const client = useApiClient();
  return useMutation({
    mutationFn: () => createPortal(client),
  });
}
