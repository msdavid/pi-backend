/**
 * Vault detail (WP-C3.3; console-spec §9.3, journey W11). Credentials are
 * grouped by category — records only, never a secret value (contracts
 * `Credential` carries none; C§13). The page states the fail-closed rule and
 * the ~60 s rotation propagation (DP-6; verified against
 * docs/architecture.md "vault revalidation"), and archive is a DP-7 typed
 * confirmation naming the real cascade (api-reference §12.7).
 *
 * Management ops are `write` mutations (§6.2 — the backend guards vault
 * mutations with method→scope, `write`); under a read-only key every
 * mutating control is disabled with the reason (§6.1).
 */
import { createLazyRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import type { Vault } from "@pi-managed/contracts";

import {
  useArchiveVault,
  useCredentials,
  useVault,
} from "../../api/vaults.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { StatusChip } from "../../ui/status-chip.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { formatTimestamp } from "../sessions/format.js";
import { CATEGORY_ORDER } from "./credential-categories.js";
import { CredentialSection } from "./credential-section.js";
import styles from "./vault-detail.module.css";

export const Route = createLazyRoute("/resources/vaults/$vaultId")({
  component: VaultDetailPage,
});

const routeApi = getRouteApi("/resources/vaults/$vaultId");

function VaultDetailPage() {
  const { vaultId } = routeApi.useParams();
  const vault = useVault(vaultId);

  if (vault.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="vault" error={vault.error} />
        <Button onClick={() => void vault.refetch()}>Retry</Button>
      </section>
    );
  }
  if (vault.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading vault…</p>
      </section>
    );
  }

  return <VaultDetail vault={vault.data} />;
}

function VaultDetail({ vault }: { vault: Vault }) {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const credentials = useCredentials(vault.id);
  const archive = useArchiveVault(vault.id);
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  const records = credentials.data?.data ?? [];
  // DP-7 counts what the archive actually changes: already-archived
  // credentials have no secret left to purge and are not re-archived.
  const activeCount = records.filter((c) => c.status === "active").length;
  const archived = vault.status === "archived";
  const archiveDisabledReason = !writable
    ? "requires the write scope"
    : archived
      ? "already archived"
      : null;

  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{vault.name}</h1>
          <span className={styles.actions}>
            <Button
              variant="destructive"
              onClick={() => setConfirmingArchive(true)}
              disabled={archiveDisabledReason !== null || archive.isPending}
              aria-describedby={
                archiveDisabledReason ? "archive-vault-note" : undefined
              }
            >
              {archive.isPending ? "Archiving…" : "Archive vault"}
            </Button>
            {archiveDisabledReason ? (
              <span id="archive-vault-note" className={styles.scopeNote}>
                {archiveDisabledReason}
              </span>
            ) : null}
          </span>
        </div>

        {archived ? (
          <p role="alert" className={styles.archivedBanner}>
            <strong>Archived.</strong> All credentials are archived and their
            secrets purged; future sessions referencing this vault fail.
            Archival is terminal.
          </p>
        ) : null}

        {archive.isError ? (
          <ErrorAlert label="archive vault" error={archive.error} />
        ) : null}

        <div className={styles.facts}>
          <StatusChip status={vault.status} />
        </div>

        <dl className={styles.meta}>
          <MetaRow label="ID">
            <CopyableId id={vault.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Created">{formatTimestamp(vault.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatTimestamp(vault.updatedAt)}</MetaRow>
        </dl>

        {/* §9.3 MUST: the fail-closed rule, plus how rotation propagates
            (docs/architecture.md: the vault revalidation loop re-resolves
            running sessions' credentials every ~60 s). */}
        <p className={styles.failClosed}>
          <strong>Fail-closed:</strong> sessions resolve credentials from
          their vaults at wake. Without a resolvable{" "}
          <code>model_provider_key</code> credential, sessions fail before the
          first model call. <strong>Rotation:</strong> replacing a credential
          propagates to running sessions within ~60 s — no restarts.
        </p>
      </header>

      <h2 className={styles.credentialsTitle}>Credentials</h2>
      <p className={styles.cliHint}>
        From the CLI:{" "}
        <code className={styles.cliCommand}>
          /remote:vault add-cred {vault.id}
        </code>
      </p>

      {credentials.isError ? (
        <ErrorAlert label="credentials" error={credentials.error} />
      ) : credentials.isPending ? (
        <p role="status">Loading credentials…</p>
      ) : (
        CATEGORY_ORDER.map((category) => (
          <CredentialSection
            key={category}
            vault={vault}
            category={category}
            credentials={records.filter((c) => c.category === category)}
            writable={writable}
          />
        ))
      )}

      <TypedConfirmDialog
        open={confirmingArchive}
        onClose={() => setConfirmingArchive(false)}
        onConfirm={() => {
          archive.mutate();
          setConfirmingArchive(false);
        }}
        title="Archive vault"
        resourceName={vault.name}
        consequence={`Archiving "${vault.name}" archives its ${activeCount} active credential${activeCount === 1 ? "" : "s"} and purges ${activeCount === 1 ? "its secret" : "their secrets"}. Future sessions referencing this vault fail; running sessions continue. Archival is terminal.`}
        confirmLabel="Archive vault"
      />
    </section>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/resources/vaults" className={styles.backLink}>
        ← Vaults
      </Link>
    </p>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>{children}</dd>
    </div>
  );
}
