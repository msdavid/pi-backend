/**
 * Settings → Billing (WP-C5.4; console-spec §11.8–11.9, journey W15). SAAS
 * ONLY — the submenu link and the router gate this to saas; the route stays
 * registered in every mode (deep links resolve) and states why it is empty
 * elsewhere, mirroring /settings/health.
 *
 * Layered exactly like the spec (§11.8): balance + lifecycle, the unverified /
 * low / suspended banners (DP-9: one fixing action), the money controls (top-up
 * + auto-charge + receipts — present ONLY when a billing adapter is configured;
 * ABSENT otherwise, §11.8), and the append-only ledger history. The console
 * NEVER computes money (§11.9): every figure is the API's `*Usd` verbatim via
 * `formatUsd`; the card is entered on the payment engine's hosted page, never
 * here — "Top up" / "Receipts" redirect to an adapter-issued URL.
 */
import { createLazyRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { LedgerEntry, TenantBillingState } from "@pi-managed/contracts";

import {
  useAutoCharge,
  useBilling,
  useCreatePortal,
  useLedger,
  useResendVerification,
  useUpdateAutoCharge,
} from "../../api/billing.js";
import { useConsoleConfig } from "../../api/console.js";
import { ConsoleApiError } from "../../api/client.js";
import { redirectToExternal } from "../../lib/navigate.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import {
  isLowBalance,
  LowBalanceBanner,
  SuspendedNotice,
  UnverifiedNotice,
} from "../billing/widgets.js";
import { formatTimestamp, formatUsd } from "../sessions/format.js";
import { AutoChargeForm } from "./auto-charge-form.js";
import { TopUpDialog } from "./top-up-dialog.js";
import styles from "./billing.module.css";

export const Route = createLazyRoute("/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  const config = useConsoleConfig();
  // Billing is saas-only — never probe the ledger out of saas (the query is
  // withheld until config confirms the mode).
  const isSaas = config.data?.mode === "saas";
  const billing = useBilling({ enabled: isSaas });

  if (config.data && config.data.mode !== "saas") {
    return (
      <section>
        <h2 className={styles.title}>Billing</h2>
        <p className={styles.muted}>
          Billing is a saas-mode facility. This deployment runs in{" "}
          {config.data.mode} mode — usage and spend live under{" "}
          <strong>Settings → Tenant</strong>.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className={styles.title}>Billing</h2>
      {billing.isPending ? (
        <p role="status">Loading balance…</p>
      ) : billing.isError ? (
        billing.error instanceof ConsoleApiError && billing.error.status === 404 ? (
          <p className={styles.muted}>
            Billing isn&apos;t provisioned for this tenant yet. Once it is, your
            balance and history appear here.
          </p>
        ) : (
          <ErrorAlert label="billing" error={billing.error} />
        )
      ) : (
        <BillingBody state={billing.data} />
      )}
    </section>
  );
}

function BillingBody({ state }: { state: TenantBillingState }) {
  const autoCharge = useAutoCharge();
  const resend = useResendVerification();
  const portal = useCreatePortal();
  const updateAuto = useUpdateAutoCharge();
  const [topUpOpen, setTopUpOpen] = useState(false);

  // The single adapter-presence signal (§11.8): non-null config ⇒ money
  // controls; null ⇒ no adapter, controls absent. While the probe is in flight
  // we withhold the controls rather than flash them.
  const adapter = autoCharge.data ?? null;
  const adapterKnown = autoCharge.isSuccess;

  const resendOutcome = resend.isError
    ? ("error" as const)
    : resend.isSuccess
      ? resend.data.sent
        ? ("sent" as const)
        : ("noop" as const)
      : null;

  function enableAutoCharge(): void {
    updateAuto.mutate({ enabled: true });
  }

  // "Top up" opens the amount dialog; the checkout request (which requires an
  // amount, §11.7) and the redirect to the hosted page live there.
  const topUpAction = adapter ? (
    <Button variant="primary" onClick={() => setTopUpOpen(true)}>
      Top up
    </Button>
  ) : null;

  return (
    <>
      {/* Balance — DP-1 crucial fact first. */}
      <div className={styles.balanceRow}>
        <span className={styles.balanceValue}>{formatUsd(state.balanceUsd)}</span>
        <span className={styles.balanceMeta}>
          balance <StatusChip status={state.lifecycle} />
        </span>
      </div>

      {/* One fixing action per state (§11.8, DP-9). */}
      {state.verificationRequired ? (
        <UnverifiedNotice
          onResend={() => resend.mutate()}
          pending={resend.isPending}
          outcome={resendOutcome}
        />
      ) : state.lifecycle === "suspended" ? (
        <SuspendedNotice unverified={false} fixAction={topUpAction} />
      ) : isLowBalance(state, adapter?.thresholdUsd) ? (
        <LowBalanceBanner
          balanceUsd={state.balanceUsd}
          onEnableAutoCharge={adapter ? enableAutoCharge : undefined}
        />
      ) : null}

      {/* Money controls — present only with an adapter (§11.8). */}
      {adapterKnown ? (
        adapter ? (
          <section className={styles.money} aria-label="Payments">
            <h3 className={styles.section}>Payments</h3>
            <div className={styles.moneyActions}>
              {topUpAction}
              <Button
                onClick={() =>
                  portal.mutate(undefined, {
                    onSuccess: (link) => redirectToExternal(link.url),
                  })
                }
                disabled={portal.isPending}
              >
                {portal.isPending ? "Opening…" : "Receipts & payment method"}
              </Button>
            </div>
            <p className={styles.moneyNote}>
              Checkout and receipts open your payment provider&apos;s hosted page
              — your card is never entered in the console.
            </p>

            <h3 className={styles.section}>Auto-charge</h3>
            <AutoChargeForm
              config={adapter}
              onSave={(update) => updateAuto.mutate(update)}
              saving={updateAuto.isPending}
              error={updateAuto.isError ? updateAuto.error : null}
            />
            <TopUpDialog open={topUpOpen} onClose={() => setTopUpOpen(false)} />
          </section>
        ) : (
          <p className={styles.noAdapter}>
            Top-ups aren&apos;t available on this deployment — no payment adapter
            is configured. Your balance, history, and everything else still work.
          </p>
        )
      ) : null}

      <h3 className={styles.section}>Ledger history</h3>
      <LedgerHistory />
    </>
  );
}

const LEDGER_COLUMNS: Array<Column<LedgerEntry>> = [
  { key: "when", header: "When", render: (e) => formatTimestamp(e.createdAt) },
  {
    key: "kind",
    header: "Kind",
    render: (e) => <StatusChip status={ledgerStatus(e.kind)} />,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    // Signed USD, verbatim from the API (credits +, debits −) — §11.9.
    render: (e) => (
      <span className={styles.mono}>{formatUsd(e.amountUsd)}</span>
    ),
  },
  {
    key: "balance",
    header: "Balance after",
    align: "right",
    render: (e) => (
      <span className={styles.mono}>{formatUsd(e.balanceAfterUsd)}</span>
    ),
  },
  { key: "source", header: "Source", render: (e) => e.source ?? "—" },
];

/** Map a ledger kind onto the shared lifecycle vocabulary (status-chip). */
function ledgerStatus(kind: LedgerEntry["kind"]): string {
  switch (kind) {
    case "grant":
    case "topup":
      return "active"; // success tone — money in
    case "debit":
      return "neutral"; // routine usage drain
    case "adjustment":
      return "paused"; // warning tone — a manual correction
  }
}

function LedgerHistory() {
  const ledger = useLedger();
  const entries = ledger.data?.pages.flatMap((p) => p.data) ?? [];

  if (ledger.isError) return <ErrorAlert label="ledger history" error={ledger.error} />;
  if (ledger.isPending) return <p role="status">Loading history…</p>;

  return (
    <>
      <Table
        columns={LEDGER_COLUMNS}
        rows={entries}
        rowKey={(e) => e.id}
        caption="Ledger history"
        empty={
          <EmptyState
            title="No ledger entries yet"
            description="Grants, top-ups, and usage drains appear here as they happen."
          />
        }
      />
      {ledger.hasNextPage ? (
        <Button
          onClick={() => void ledger.fetchNextPage()}
          disabled={ledger.isFetchingNextPage}
        >
          {ledger.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </>
  );
}
