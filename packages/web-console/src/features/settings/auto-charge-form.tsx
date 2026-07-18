/**
 * Auto-charge controls (WP-C5.4; console-spec §11.7, `console.md` §2a, W15 step
 * 3). The UI reads/writes the settings; the ENGINE is the backend adapter
 * (saved-method + off-session charging are adapter-internal, never here). Off by
 * default. The threshold/amount fields are the user's USD figures submitted
 * verbatim — the adapter converts to micros, so the browser does no money math
 * (§11.9). Daily/monthly caps and "last auto-charge" are shown read-only so the
 * state is never mysterious; an adapter auto-disable (repeated failures) is
 * surfaced plainly with the fallback to manual top-up.
 */
import { useId, useState } from "react";
import type { AutoChargeConfig, AutoChargeUpdate } from "@pi-managed/contracts";

import { Button } from "../../ui/button.js";
import { formatUsd } from "../sessions/format.js";
import { formatTimestamp } from "../sessions/format.js";
import styles from "./billing.module.css";

export function AutoChargeForm({
  config,
  onSave,
  saving,
  error,
}: {
  config: AutoChargeConfig;
  onSave: (update: AutoChargeUpdate) => void;
  saving: boolean;
  error: unknown;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [thresholdUsd, setThresholdUsd] = useState(String(config.thresholdUsd));
  const [amountUsd, setAmountUsd] = useState(String(config.amountUsd));
  const thresholdId = useId();
  const amountId = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // USD figures verbatim from the fields (no micro-math, §11.9). Numbers the
    // user didn't touch still round-trip as the same displayed value.
    onSave({
      enabled,
      thresholdUsd: Number(thresholdUsd),
      amountUsd: Number(amountUsd),
    });
  }

  return (
    <form className={styles.autoCharge} onSubmit={submit} aria-label="Auto-charge">
      {config.disabledReason === "consecutive_failures" ? (
        <p role="alert" className={styles.autoDisabled}>
          Auto-charge was turned off after repeated payment failures. No silent
          retries — re-enable it below once your payment method is fixed, or top
          up manually.
        </p>
      ) : null}

      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          Automatically top up when the balance runs low
          {config.enabled ? "" : " (off)"}
        </span>
      </label>

      <div className={styles.autoRow}>
        <div className={styles.field}>
          <label htmlFor={thresholdId}>Charge when balance drops below ($)</label>
          <input
            id={thresholdId}
            type="number"
            min="0"
            step="1"
            inputMode="decimal"
            value={thresholdUsd}
            onChange={(e) => setThresholdUsd(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={amountId}>Charge this amount ($)</label>
          <input
            id={amountId}
            type="number"
            min="1"
            step="1"
            inputMode="decimal"
            value={amountUsd}
            onChange={(e) => setAmountUsd(e.target.value)}
          />
        </div>
      </div>

      <dl className={styles.caps}>
        <div className={styles.cap}>
          <dt>Daily cap</dt>
          <dd>{formatUsd(config.dailyCapUsd)}</dd>
        </div>
        <div className={styles.cap}>
          <dt>Monthly cap</dt>
          <dd>{formatUsd(config.monthlyCapUsd)}</dd>
        </div>
        <div className={styles.cap}>
          <dt>Last auto-charge</dt>
          <dd>
            {config.lastChargeAt && config.lastChargeUsd !== null
              ? `${formatUsd(config.lastChargeUsd)} on ${formatTimestamp(config.lastChargeAt)}`
              : "none yet"}
          </dd>
        </div>
      </dl>

      <p className={styles.capsNote}>
        Hard caps bound the spend a runaway agent can trigger — a charge that
        would exceed either is skipped, never partially applied.
      </p>

      {error ? (
        <p role="alert" className={styles.saveError}>
          Couldn&apos;t save — try again.
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={saving}>
        {saving ? "Saving…" : "Save auto-charge settings"}
      </Button>
    </form>
  );
}
