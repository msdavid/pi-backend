/**
 * Show-once secret reveal (DP-8; console-spec §9.2/§9.6/§9.7/§9.8): renders
 * a just-issued credential (raw API key, `whsec_` signing secret, worker
 * key) EXACTLY once, behind copy-and-confirm. The confirm gate — an
 * acknowledgement checkbox, or the Copy action itself (`confirmVia="copy"`)
 * — locks the only proceeding action, with the locked reason visible and
 * wired via `aria-describedby` (§6.1). The caller unmounts this component
 * (dropping the mutation result, the secret's sole home) when `onConfirm`
 * fires. Nothing here persists the value: no state copy, no storage, no
 * re-fetch path exists server-side.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "./button.js";
import { useCopy } from "./use-copy.js";
import styles from "./secret-reveal.module.css";

export interface SecretRevealProps {
  /** What the value is, e.g. "API key" or "signing secret". */
  label: string;
  /** The raw secret — lives only in the caller's mutation result. */
  secret: string;
  /** Accessible name for the copy button (defaults to its "Copy" text). */
  copyLabel?: string;
  /**
   * Contextual warning slot, rendered as a `role="alert"` banner. Omit for
   * the standard show-once line; pass `null` when the surrounding copy
   * already carries the warning.
   */
  warning?: ReactNode;
  /** One line of DP-6 microcopy: what it authenticates, where it goes. */
  note?: ReactNode;
  /**
   * What unlocks the proceed action: the acknowledgement `checkbox`
   * (default), or the `copy` action itself.
   */
  confirmVia?: "checkbox" | "copy";
  /** Acknowledgement-checkbox label; defaults to "I have stored this {label} — it will not be shown again". */
  confirmText?: string;
  /** Proceed-button label; defaults to "Done". */
  confirmLabel?: string;
  /** Disables proceed while the caller's follow-up (e.g. sign-in) runs. */
  confirmPending?: boolean;
  /** Visible reason while the gate is locked (§6.1). */
  lockedReason?: string;
  /** Extra content (error alerts, follow-up hints) above the actions. */
  children?: ReactNode;
  /** Fired on proceed; the caller unmounts the reveal, dropping the secret. */
  onConfirm: () => void;
}

export function SecretReveal({
  label,
  secret,
  copyLabel,
  warning,
  note,
  confirmVia = "checkbox",
  confirmText,
  confirmLabel = "Done",
  confirmPending = false,
  lockedReason,
  children,
  onConfirm,
}: SecretRevealProps) {
  const { copied, copy } = useCopy();
  const [acknowledged, setAcknowledged] = useState(false);
  // `copied` resets after a moment (useCopy); `hasCopied` stays — the
  // copy-and-confirm gate must not re-lock.
  const [hasCopied, setHasCopied] = useState(false);
  const reasonId = useId();

  const unlocked = confirmVia === "copy" ? hasCopied : acknowledged;
  const showReason = !unlocked && lockedReason !== undefined;

  return (
    <div className={styles.reveal}>
      {warning === undefined ? (
        <p className={styles.warning} role="alert">
          This {label} is shown <strong>exactly once</strong> — it cannot be
          retrieved again. Copy it now.
        </p>
      ) : warning === null ? null : (
        <p className={styles.warning} role="alert">
          {warning}
        </p>
      )}
      {note ? <p className={styles.note}>{note}</p> : null}
      <div className={styles.secretRow}>
        <code className={styles.secret}>{secret}</code>
        <Button
          aria-label={copyLabel}
          onClick={() => {
            void copy(secret);
            setHasCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {confirmVia === "checkbox" ? (
        <label className={styles.ack}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          {confirmText ??
            `I have stored this ${label} — it will not be shown again`}
        </label>
      ) : null}
      {children}
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={onConfirm}
          disabled={!unlocked || confirmPending}
          aria-describedby={showReason ? reasonId : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
      {showReason ? (
        <p id={reasonId} className={styles.reason}>
          {lockedReason}
        </p>
      ) : null}
    </div>
  );
}
