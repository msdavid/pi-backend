/**
 * Vaults list (WP-C3.3; console-spec §9.3, journey W11). Browsing is
 * all-scopes; create is a `write` mutation (§6.2 — the backend guards
 * `POST /v1/vaults` with method→scope, `write`) — under a read-only key the
 * button is disabled with the reason (§6.1). The empty
 * state teaches the CLI path (DP-5). Secret values never appear on this
 * surface: vault records carry none (contracts `Vault`), and the credential
 * forms live on the detail page.
 */
import { createLazyRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Vault } from "@pi-managed/contracts";

import { useCreateVault, useVaults } from "../../api/vaults.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { LinkedId } from "../linked-id.js";
import { formatTimestamp } from "../sessions/format.js";
import styles from "./vaults.module.css";

export const Route = createLazyRoute("/resources/vaults")({
  component: VaultsPage,
});

const COLUMNS: Array<Column<Vault>> = [
  { key: "name", header: "Name", render: (vault) => vault.name },
  {
    key: "id",
    header: "ID",
    render: (vault) => (
      <LinkedId
        id={vault.id}
        maxLength={24}
        to="/resources/vaults/$vaultId"
        params={{ vaultId: vault.id }}
      />
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (vault) => <StatusChip status={vault.status} />,
  },
  {
    key: "updated",
    header: "Updated",
    render: (vault) => formatTimestamp(vault.updatedAt),
  },
];

function VaultsPage() {
  const navigate = useNavigate();
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const vaults = useVaults();
  const [creating, setCreating] = useState(false);
  const rows = vaults.data?.data ?? [];

  return (
    <section>
      <p className={styles.back}>
        <Link to="/resources" className={styles.backLink}>
          ← Resources
        </Link>
      </p>
      <header className={styles.header}>
        <h1 className={styles.title}>Vaults</h1>
        <span className={styles.actions}>
          <Button
            onClick={() => void vaults.refetch()}
            disabled={vaults.isRefetching}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            onClick={() => setCreating(true)}
            disabled={!writable}
            aria-describedby={writable ? undefined : "new-vault-scope-note"}
          >
            New vault
          </Button>
          {!writable ? (
            <span id="new-vault-scope-note" className={styles.scopeNote}>
              requires the write scope
            </span>
          ) : null}
        </span>
      </header>
      {/* DP-6: one line per concept, incl. the fail-closed rule (§9.3). */}
      <p className={styles.intro}>
        A vault is a named set of credentials sessions resolve at wake; secret
        values are write-only. Without a resolvable{" "}
        <code>model_provider_key</code> credential, sessions fail before the
        first model call.
      </p>

      {vaults.isError ? (
        <ErrorAlert label="vaults" error={vaults.error} />
      ) : vaults.isPending ? (
        <p role="status">Loading vaults…</p>
      ) : (
        <Table
          columns={COLUMNS}
          rows={rows}
          rowKey={(vault) => vault.id}
          caption="Vaults"
          onRowActivate={(vault) =>
            void navigate({
              to: "/resources/vaults/$vaultId",
              params: { vaultId: vault.id },
            })
          }
          empty={
            <EmptyState
              title="No vaults yet"
              description="Register credentials once — model-provider keys, bearer tokens, env-var secrets — and reference the vault by id at session creation."
              cliCommand="/remote:vault create"
            >
              {writable ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New vault
                </Button>
              ) : null}
            </EmptyState>
          }
        />
      )}

      <CreateVaultDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(vault) =>
          void navigate({
            to: "/resources/vaults/$vaultId",
            params: { vaultId: vault.id },
          })
        }
      />
    </section>
  );
}

function CreateVaultDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (vault: Vault) => void;
}) {
  const create = useCreateVault();
  const { reset } = create;
  const [name, setName] = useState("");

  // A reopened dialog starts blank.
  useEffect(() => {
    if (!open) {
      setName("");
      reset();
    }
  }, [open, reset]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (vault) => {
          onClose();
          onCreated(vault);
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="New vault">
      <form onSubmit={submit}>
        {create.isError ? (
          <div className={styles.dialogError}>
            <ErrorAlert label="create vault" error={create.error} />
          </div>
        ) : null}
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          hint="A vault holds no secrets at creation — add credentials on its detail page."
        />
        <div className={styles.dialogActions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending || name.trim() === ""}
          >
            {create.isPending ? "Creating…" : "Create vault"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
