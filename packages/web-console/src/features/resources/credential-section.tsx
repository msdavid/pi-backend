/**
 * One vault-detail credential section per category (WP-C3.3; console-spec
 * §9.3, journey W11): the category's records (never a secret value —
 * contracts `Credential` has no such field), an add form (secret write-only,
 * see `./add-credential-dialog.tsx`), a live Validate check (§12.5), and
 * archive-credential behind a DP-7 typed confirmation naming the real
 * consequence (secret purged, key freed — api-reference §12.7).
 */
import { useState } from "react";
import type {
  Credential,
  CredentialCategory,
  CredentialValidateResponse,
  Vault,
} from "@pi-managed/contracts";

import {
  useDeleteCredential,
  useValidateCredential,
} from "../../api/vaults.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { formatTimestamp } from "../sessions/format.js";
import { AddCredentialDialog } from "./add-credential-dialog.js";
import { CATEGORY_META, VALIDATION_COPY } from "./credential-categories.js";
import styles from "./vault-detail.module.css";

export function CredentialSection({
  vault,
  category,
  credentials,
  writable,
}: {
  vault: Vault;
  category: CredentialCategory;
  credentials: Credential[];
  /** `write` scope (§6.2) — the backend guards these mutations method→scope. */
  writable: boolean;
}) {
  const meta = CATEGORY_META[category];
  const archived = vault.status === "archived";
  const validate = useValidateCredential(vault.id);
  const remove = useDeleteCredential(vault.id);
  const [adding, setAdding] = useState(false);
  /** Credential key → last §12.5 validate outcome shown inline. */
  const [validations, setValidations] = useState<
    Record<string, CredentialValidateResponse>
  >({});
  /** The key currently being validated (its button shows progress). */
  const [validating, setValidating] = useState<string | null>(null);
  /** The credential awaiting DP-7 confirmation, or null. */
  const [deleting, setDeleting] = useState<Credential | null>(null);

  // §6.1: disabled actions explain themselves; one shared note per section.
  const noteId = `${category}-actions-note`;
  const disabledReason = !writable
    ? "requires the write scope"
    : archived
      ? "vault is archived"
      : null;

  function runValidate(key: string) {
    setValidating(key);
    validate.mutate(key, {
      onSuccess: ({ status }) =>
        setValidations((prev) => ({ ...prev, [key]: status })),
      onSettled: () => setValidating(null),
    });
  }

  const columns: Array<Column<Credential>> = [
    { key: "key", header: "Key", render: (cred) => <code>{cred.key}</code> },
    {
      key: "id",
      header: "ID",
      render: (cred) => <CopyableId id={cred.id} maxLength={24} />,
    },
    {
      key: "status",
      header: "Status",
      render: (cred) => <StatusChip status={cred.status} />,
    },
    {
      key: "added",
      header: "Added",
      render: (cred) => formatTimestamp(cred.createdAt),
    },
    {
      key: "actions",
      header: "Actions",
      render: (cred) =>
        cred.status === "archived" ? (
          <span className={styles.archivedCell}>archived — secret purged</span>
        ) : (
          <span className={styles.rowActions}>
            <Button
              onClick={() => runValidate(cred.key)}
              disabled={disabledReason !== null || validating === cred.key}
              aria-describedby={disabledReason ? noteId : undefined}
            >
              {validating === cred.key ? "Validating…" : "Validate"}
            </Button>
            {validations[cred.key] ? (
              <span role="status" className={styles.validation}>
                {VALIDATION_COPY[validations[cred.key]!]}
              </span>
            ) : null}
            <Button
              variant="destructive"
              onClick={() => setDeleting(cred)}
              disabled={disabledReason !== null}
              aria-describedby={disabledReason ? noteId : undefined}
            >
              Delete
            </Button>
          </span>
        ),
    },
  ];

  return (
    <section className={styles.category} aria-label={meta.title}>
      <div className={styles.categoryHeader}>
        <h3 className={styles.categoryTitle}>{meta.title}</h3>
        <span className={styles.rowActions}>
          <Button
            onClick={() => setAdding(true)}
            disabled={disabledReason !== null}
            aria-describedby={disabledReason ? noteId : undefined}
          >
            Add
          </Button>
          {disabledReason ? (
            <span id={noteId} className={styles.scopeNote}>
              {disabledReason}
            </span>
          ) : null}
        </span>
      </div>
      <p className={styles.categoryDescription}>{meta.description}</p>

      {validate.isError ? (
        <ErrorAlert label="validate credential" error={validate.error} />
      ) : null}
      {remove.isError ? (
        <ErrorAlert label="delete credential" error={remove.error} />
      ) : null}

      {credentials.length === 0 ? (
        <p className={styles.categoryEmpty}>
          No {meta.title.toLowerCase()} yet.
        </p>
      ) : (
        <Table
          columns={columns}
          rows={credentials}
          rowKey={(cred) => cred.id}
          caption={meta.title}
        />
      )}

      <AddCredentialDialog
        vaultId={vault.id}
        category={category}
        open={adding}
        onClose={() => setAdding(false)}
      />

      {deleting ? (
        <TypedConfirmDialog
          open
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            remove.mutate(deleting.key);
            setDeleting(null);
          }}
          title="Delete credential"
          resourceName={deleting.key}
          consequence={`Deleting "${deleting.key}" purges its secret immediately and cannot be undone. The archived record remains for audit and keeps the key reserved — a replacement needs a new key. Running sessions lose this credential at their next refresh (~60 s).`}
          confirmLabel="Delete credential"
        />
      ) : null}
    </section>
  );
}
