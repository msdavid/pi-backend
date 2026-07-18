/**
 * Top-up amount dialog (WP-C5.4; console-spec §11.7/§11.9, journey W15 step 2).
 * The console collects the top-up amount, asks the adapter for a hosted checkout
 * URL, and redirects the browser there — the card is entered on the payment
 * engine's page, NEVER in the console (§11.9). The reference (Stripe) adapter
 * issues a FIXED-amount hosted page, so an amount is required (an omitted amount
 * is a 422 at the adapter); this dialog always sends one. No money math here: the
 * USD figure is passed verbatim and the adapter converts to micros.
 */
import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateCheckout } from "../../api/billing.js";
import { redirectToExternal } from "../../lib/navigate.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import styles from "./billing.module.css";

/** A sensible starting top-up; the user edits it before continuing. */
const DEFAULT_AMOUNT = "20";

export function TopUpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const checkout = useCreateCheckout();
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);

  function close() {
    checkout.reset();
    setAmount(DEFAULT_AMOUNT);
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // USD verbatim from the field (no micro-math, §11.9) — the adapter converts.
    checkout.mutate(
      { amountUsd: Number(amount) },
      { onSuccess: (link) => redirectToExternal(link.url) },
    );
  }

  const parsed = Number(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <Dialog open={open} onClose={close} title="Top up your balance">
      <form onSubmit={submit} className={styles.autoCharge} aria-label="Top up">
        <Input
          label="Amount to add ($)"
          type="number"
          min="1"
          step="1"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint="You'll enter your card on your payment provider's hosted page — never in the console."
        />
        {checkout.isError ? (
          <ErrorAlert label="checkout" error={checkout.error} />
        ) : null}
        <div className={styles.moneyActions}>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!valid || checkout.isPending}
          >
            {checkout.isPending ? "Opening checkout…" : "Continue to checkout"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
