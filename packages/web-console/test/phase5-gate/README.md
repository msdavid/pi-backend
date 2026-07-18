# Phase-5 conformance gate (commercialization — console-spec §11, journey W15)

Runs in the single `conformance-gate` vitest project (extended per phase, never
trimmed). What phase 5 pins, beyond the earlier gates:

| File | Pins |
|---|---|
| `w15-journey.gate.test.ts` | W15 end-to-end: balance + burn + "lasts ~N days" on Home; top-up link-out **present with an adapter, absent without** (§11.8); auto-charge toggle with visible daily/monthly caps (§11.7); suspended is fail-soft with exactly one fixing action (DP-9). |
| `no-client-money-math.gate.test.ts` | §11.9. A sentinel `balanceUsd` round-trips byte-identical through the Billing screen; a static scan asserts the money-DISPLAY components (`billing.lazy.tsx`, `auto-charge-form.tsx`, `widgets.tsx`) contain no money arithmetic (no `1_000_000` / `MICROS_PER_USD` / `*`·`/` on a `*Usd`/`*Micros` field). The runway day-count projection (`src/lib/runway.ts`) is the one sanctioned derivation and is deliberately excluded. |
| `mode-gating.gate.test.ts` | Billing is saas-ONLY: the Settings submenu link appears only in saas; `/settings/billing` resolves in every mode but out of saas states why and fires zero billing probes (self-hosters are never balance-gated). |
| `verification.gate.test.ts` | §11.1 unverified-trial surfacing + resend (Home); verification gates "start a first session" in the first-run checklist; the verify-email landing activates the trial and reports the grant. |
| `perf-budget.gate.test.ts` | §12.1: `billing.lazy` is its own chunk, out of the initial JS set; the billing money surface never ships in an initial chunk (the ≤ 200 KB gz budget is enforced on every fresh build by the phase-1 gate). |

## No-adapter / deferred-wire note

The checkout / portal / auto-charge routes are the console↔payment-engine
link-out surface (api-reference §"Adapter-integration routes"). They are served
only when a deployment fronts `packages/billing-adapter` with a thin, SDK-free
`/v1` proxy — a wire decision WP-C5.3 deliberately deferred. **Absent that proxy
every route `404`s and the console renders the no-adapter state (§11.8).** The
real-backend seam (`src/api/__tests__/billing.contract.test.ts`) pins exactly
that degradation (getBilling → 404 "no billing"; getAutoCharge → `null` "no
adapter"); the WITH-adapter money paths, which have no real backend to drive,
are exercised here through the collaborator `FakeConsoleApi` (legitimate — the
adapter is a collaborator, not the subject).
