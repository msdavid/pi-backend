/**
 * Add-credential dialog (WP-C3.3; console-spec §9.3, DP-8). The secret field
 * is WRITE-ONLY end-to-end: `type="password"` (never rendered as text),
 * `autoComplete="off"`, and the value exists only in transient component
 * state and the `POST …/credentials` body — on success (and on close) the
 * state is cleared, so the submitted value is never echoed anywhere in the
 * DOM. Same handling as the sign-in key (`../auth/sign-in.tsx`, §4.1).
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { CredentialCategory } from "@pi-managed/contracts";

import { useAddCredential } from "../../api/vaults.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { buildCredentialBody, CATEGORY_META } from "./credential-categories.js";
import styles from "./vaults.module.css";

export function AddCredentialDialog({
  vaultId,
  category,
  open,
  onClose,
}: {
  vaultId: string;
  category: CredentialCategory;
  open: boolean;
  onClose: () => void;
}) {
  const meta = CATEGORY_META[category];
  const add = useAddCredential(vaultId);
  const { reset } = add;
  const { toast } = useToast();
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");

  // A closed dialog holds no secret (DP-8) and reopens blank.
  useEffect(() => {
    if (!open) {
      setKey("");
      setSecret("");
      reset();
    }
  }, [open, reset]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey || !secret || add.isPending) return;
    add.mutate(buildCredentialBody(category, trimmedKey, secret), {
      onSuccess: (record) => {
        // Drop the last in-memory copy of the secret before anything else
        // re-renders; the record that comes back never carries it (§12.4).
        setSecret("");
        setKey("");
        onClose();
        toast({
          message: `Added ${record.category} credential "${record.key}"`,
          tone: "success",
        });
      },
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Add: ${meta.title}`}>
      <form onSubmit={submit}>
        {add.isError ? (
          <div className={styles.dialogError}>
            <ErrorAlert label="add credential" error={add.error} />
          </div>
        ) : null}
        <Input
          label={meta.keyLabel}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          hint={`${meta.keyHint} Immutable, and stays reserved even after the credential is archived.`}
        />
        <Input
          label={meta.secretLabel}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          hint="Write-only: stored encrypted and never shown again — not even to you (DP-8)."
        />
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={add.isPending || key.trim() === "" || secret === ""}
          >
            {add.isPending ? "Adding…" : "Add credential"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
