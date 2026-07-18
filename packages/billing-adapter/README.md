# @pi-managed/billing-adapter

The payment-engine adapter for the prepaid dollar ledger (console spec **§11.7**,
WP-C5.3). Stripe is the reference implementation.

> **The Stripe SDK is imported in exactly one file here** (`src/stripe-engine.ts`)
> and appears in **no other package** in the repo (grep-asserted in CI). Everything
> else is engine-neutral, so a different engine (Paddle, a merchant-of-record, …) is
> a drop-in second implementation of the same seam.

## What it is (and is not)

This adapter is a **separate process** from the backend. The backend request path
never imports a payment SDK; money enters the ledger **only** through the backend's
machine credit-surface (`POST /internal/billing/credit`), and the ledger — not any
payment engine — is the source of truth for balance (§11.3). The adapter is:

1. a **webhook receiver** — verifies a payment webhook's signature, then credits the
   tenant's ledger through the machine credit-surface;
2. a **`tenant.balance_low` subscriber** — the opt-in auto-charge engine; and
3. an **internal HTTP surface** (`createAdapterInternalServer`, `src/internal-api.ts`)
   the backend's SDK-free `/v1` link-out proxy calls for checkout / portal / auto-charge —
   the reverse of the credit-surface, same machine-bearer auth (§11.7–11.8).

It talks to the backend as a **machine actor** (host-agent bearer secret, NOT a
tenant API key) and to Stripe through the SDK. Nothing here computes money
client-side; the console displays what the ledger reports (§11.9).

## Public interface

```ts
import { BillingAdapter, loadAdapterConfig } from "@pi-managed/billing-adapter";

const adapter = new BillingAdapter(loadAdapterConfig(process.env), { store, notifier });

// Hosted URLs the console links out to (the console never sees a card):
await adapter.createCheckoutUrl(tenantId, amountMicros); // → hosted checkout URL
await adapter.createPortalUrl(tenantId, customerRef);    // → hosted portal URL

// Webhook receiver → verified event → idempotent ledger credit:
await adapter.handleWebhook(rawBody, stripeSignatureHeader);

// tenant.balance_low subscriber → auto-charge (opt-in, caps, auto-disable):
await adapter.onLowBalance(tenantBalanceEventData);
```

The engine-agnostic seam is `PaymentEngine` (`createCheckoutUrl`, `createPortalUrl`,
`verifyWebhook`, `chargeOffSession`); the Stripe SDK lives behind
`StripeEngine`/`createStripeEngine` only.

### Money invariant (idempotency)

Both the webhook consumer and the auto-charge engine derive their **ledger**
idempotency key from the payment id through one function —
`creditKeyForPayment(paymentRef) → "stripe:<id>"`. Because the key is identical
across every path, the backend ledger's `UNIQUE (tenant_id, idempotency_key)`
constraint credits a payment **exactly once** — under Stripe's at-least-once webhook
re-delivery (§13) **and** when an off-session auto-charge's own webhook also arrives.

### Auto-charge safety rails (non-negotiable, §11.7)

- Opt-in, **off by default**.
- **Hard caps per day and per month** — a charge that would push either rolling
  window over its cap is skipped entirely; the cap is never exceeded.
- **Auto-disable + notify after N consecutive failures** (`AUTO_CHARGE_MAX_FAILURES`,
  default 3) — no silent retry loops; the user falls back to manual top-up.
- Every auto-charge appears in the ledger like any top-up.
- **One charge per crossing under redelivery** — the engine charge idempotency key is
  the crossing's stable ledger `entryId` (`autocharge:<entryId>`), so a redelivered
  `tenant.balance_low` for the same crossing charges the card and credits the ledger
  exactly once. `onLowBalance` is serialized per tenant (a keyed in-process mutex) so
  concurrent crossings never race the cap; a multi-process store must also enforce the
  reservation transactionally (see `AutoChargeStore`).

The saved-payment-method + off-session charge are adapter-internal (Stripe:
SetupIntent to save, off-session PaymentIntent to charge). Auto-charge config, cap
accounting, and the failure counter live behind the `AutoChargeStore` interface;
`InMemoryAutoChargeStore` is the reference/default — a production deployment backs
the same interface with a durable store, and supplies a real `AutoChargeNotifier`
(email/console).

## Configuration (env, fail-closed)

All secrets are read from the environment at runtime, exactly like the host-agent
token: never hardcoded, never logged, and a missing/blank required value **fails
closed** (the adapter refuses to start). See `docs/deploy.md` §"Billing adapter" for
the full table.

| Var | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Stripe secret key (`sk_…`). |
| `STRIPE_WEBHOOK_SECRET` | yes | Webhook signing secret (`whsec_…`). |
| `PI_BACKEND_URL` | yes | Backend base URL (machine credit-surface). |
| `BILLING_PROVISION_TOKEN` | yes | Machine bearer secret; must match the backend's. |
| `BILLING_CHECKOUT_SUCCESS_URL` / `BILLING_CHECKOUT_CANCEL_URL` | yes | Console checkout return URLs. |
| `BILLING_PORTAL_RETURN_URL` | yes | Console portal return URL. |
| `AUTO_CHARGE_MAX_FAILURES` | no (3) | Consecutive failures that auto-disable auto-charge. |

### No credentials ship

**No real Stripe key or webhook secret exists in this package** — not in code, env,
tests, or fixtures. Tests never hold a provider credential: the security-critical
webhook-signature path is exercised with a **locally generated, obviously test-only**
signing secret (`whsec_test_…`) and Stripe's real HMAC crypto; the network-touching
paths (checkout/portal/charge) inject a fake Stripe client at the SDK seam. A real
deployment supplies the real keys via env only.

## How the console links out (WP-C5.4)

Checkout and portal URLs are **issued on request** by the adapter. The console's
Billing screen calls out to obtain a URL and then redirects the browser to Stripe's
hosted page; the card is entered on Stripe, never in the console (§11.9). On return,
the ledger has already been credited by the webhook (idempotently), so the balance
the console reads is authoritative. With no adapter configured, the money buttons are
simply absent and everything else works (§11.8).

## Testing

`pnpm --filter @pi-managed/billing-adapter test` (integration suites need a container
runtime — `PI_REQUIRE_INTEGRATION=containers` in CI). The suites, per CONVENTIONS
*fakes at the seam*:

- **Webhook signature** (`src/webhook-signature.test.ts`) — real Stripe crypto both
  sides, hermetic; accepts a valid signature, rejects a tampered body / wrong secret
  / stale timestamp.
- **Ledger credit idempotency** (`src/__tests__/webhook-ledger.integration.test.ts`)
  — a replayed webhook against the **real backend** (in-process listening Fastify app
  + testcontainers Postgres) credits the ledger exactly once.
- **Auto-charge** (`src/__tests__/auto-charge.integration.test.ts`) — real ledger +
  fake Stripe: caps never exceeded, N-failure auto-disable + notify, and a successful
  auto-charge credits the ledger idempotently (its own webhook does not double-credit).
- **Checkout/portal/charge translation** (`src/checkout-portal-charge.test.ts`) —
  fake Stripe client at the SDK seam (a collaborator): request → Stripe params → URL.
