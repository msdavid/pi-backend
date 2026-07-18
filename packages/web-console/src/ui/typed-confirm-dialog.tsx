import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "./button.js";
import { Dialog } from "./dialog.js";
import { Input } from "./input.js";
import styles from "./typed-confirm-dialog.module.css";

export interface TypedConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired only when the typed name matches exactly. */
  onConfirm: () => void;
  title: string;
  /** The name the user must retype (e.g. the agent's name). */
  resourceName: string;
  /**
   * Explicit consequence language sourced from real API behavior (DP-7),
   * e.g. "Archiving this agent auto-archives 3 scheduled jobs. Archival is
   * terminal."
   */
  consequence: string;
  /** Label of the destructive button. */
  confirmLabel?: string;
}

/**
 * Destructive confirmation (DP-7): states the consequences and requires the
 * user to retype the resource name before the destructive button enables.
 */
export function TypedConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  resourceName,
  consequence,
  confirmLabel = "Confirm",
}: TypedConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const matches = typed === resourceName;

  // A reopened dialog must never remember a previous confirmation.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches) onConfirm();
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form onSubmit={submit}>
        <p className={styles.consequence}>{consequence}</p>
        <Input
          label={`Type "${resourceName}" to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={!matches}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
