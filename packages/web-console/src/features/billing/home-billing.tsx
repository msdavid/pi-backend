/**
 * saas Home commercialization strip (WP-C5.4; console-spec §11.8, `console.md`
 * §2a, journey W15 steps 1 & 4). Rendered above Home's headline metrics in saas
 * mode only: balance + burn sparkline + "lasts ~N days", and — driven by the
 * billing lifecycle — the unverified / low-balance / suspended banner (DP-9:
 * one action). Home is a NUDGE surface: if billing isn't enrolled (404) or the
 * probe fails, it renders nothing and the Billing screen owns the detail/errors
 * (mirrors the first-run card's silent-on-failure rule).
 *
 * §11.9: money is the API's `balanceUsd` verbatim; only the runway day-count is
 * derived (`lib/runway.ts`).
 */
import { Link } from "@tanstack/react-router";

import {
  useAutoCharge,
  useBilling,
  useResendVerification,
  useUpdateAutoCharge,
} from "../../api/billing.js";
import { useConsoleConfig } from "../../api/console.js";
import { useTenantUsage } from "../../api/tenant.js";
import {
  BalanceHeadline,
  isLowBalance,
  LowBalanceBanner,
  SuspendedNotice,
  UnverifiedNotice,
} from "./widgets.js";

/** saas-only; renders nothing in solo/team (self-hosters are never billed). */
export function SaasBillingHome() {
  const mode = useConsoleConfig().data?.mode;
  if (mode !== "saas") return null;
  return <SaasBillingHomeInner />;
}

function SaasBillingHomeInner() {
  const billing = useBilling();
  const usage = useTenantUsage({ granularity: "day" });
  const autoCharge = useAutoCharge();
  const resend = useResendVerification();
  const updateAuto = useUpdateAutoCharge();

  // Nudge, not a surface: stay silent until (and unless) billing resolves.
  if (!billing.data) return null;
  const state = billing.data;
  const adapter = autoCharge.data ?? null;

  const resendOutcome = resend.isError
    ? ("error" as const)
    : resend.isSuccess
      ? resend.data.sent
        ? ("sent" as const)
        : ("noop" as const)
      : null;

  return (
    <div>
      <BalanceHeadline state={state} usage={usage.data} />

      {state.verificationRequired ? (
        <UnverifiedNotice
          onResend={() => resend.mutate()}
          pending={resend.isPending}
          outcome={resendOutcome}
        />
      ) : state.lifecycle === "suspended" ? (
        <SuspendedNotice
          unverified={false}
          fixAction={<Link to="/settings/billing">Top up →</Link>}
        />
      ) : isLowBalance(state, adapter?.thresholdUsd) ? (
        <LowBalanceBanner
          balanceUsd={state.balanceUsd}
          onEnableAutoCharge={
            adapter ? () => updateAuto.mutate({ enabled: true }) : undefined
          }
        />
      ) : null}
    </div>
  );
}
