/**
 * Memory-store version history (WP-C2.4, restore WP-C4.0b; console-spec
 * §9.5, §13.5): the audit trail lists newest first; activating a row opens
 * the version's fields.
 *
 * Restore (write scope; api-reference §"…/versions/:v/restore", WP-C4.0):
 * the backend copies the version's content SERVER-SIDE into a NEW version
 * for the same `memoryPath`, which becomes the live head — non-destructive
 * (a plain Dialog states exactly that; deliberately not TypedConfirm),
 * history preserved, and an undelete when the path was deleted. Redacted
 * versions have no content left (the API answers `409 conflict`), so their
 * Restore is disabled with the reason; so is everything under a read-only
 * key (§6.1 disabled-with-reason).
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MemoryVersion } from "@pi-managed/contracts";

import {
  useMemoryVersion,
  useMemoryVersions,
  useRestoreMemoryVersion,
} from "../../api/memory-stores.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { Dialog } from "../../ui/dialog.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Table, type Column } from "../../ui/table.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import styles from "./memory-store-detail.module.css";

const VERSION_COLUMNS: Array<Column<MemoryVersion>> = [
  {
    key: "id",
    header: "Version",
    render: (version) => <code className={styles.mono}>{version.id}</code>,
  },
  {
    key: "path",
    header: "Path",
    render: (version) => (
      <code className={styles.mono}>{version.memoryPath}</code>
    ),
  },
  {
    key: "redacted",
    header: "Redacted",
    render: (version) => (version.redacted ? "yes" : "no"),
  },
  {
    key: "created",
    header: "Created",
    render: (version) => formatTimestamp(version.createdAt),
  },
  {
    key: "expires",
    header: "Expires",
    render: (version) => formatTimestamp(version.expiresAt),
  },
];

export function VersionsTab({ storeId }: { storeId: string }) {
  const versions = useMemoryVersions(storeId);
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const { toast } = useToast();
  const restore = useRestoreMemoryVersion(storeId);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  /** The row awaiting confirmation in the restore dialog. */
  const [pendingRestore, setPendingRestore] = useState<MemoryVersion | null>(
    null,
  );
  /** The head version a restore just created — its panel auto-scrolls. */
  const [restoredId, setRestoredId] = useState<string | null>(null);
  const rows = versions.data?.pages.flatMap((page) => page.data) ?? [];

  if (versions.isError) {
    return <ErrorAlert label="versions" error={versions.error} />;
  }
  if (versions.isPending) return <p role="status">Loading versions…</p>;

  function closeRestoreDialog() {
    setPendingRestore(null);
    restore.reset();
  }

  function onRestore() {
    if (!pendingRestore || restore.isPending) return;
    restore.mutate(pendingRestore.id, {
      onSuccess: (created) => {
        setPendingRestore(null);
        toast({
          message: `Restored ${created.memoryPath} — new head version ${created.id}`,
          tone: "success",
        });
        // Open (and scroll to) the new head version's panel; the
        // invalidated list refetch surfaces it as the newest-first head.
        setOpenVersionId(created.id);
        setRestoredId(created.id);
      },
    });
  }

  const columns: Array<Column<MemoryVersion>> = [
    ...VERSION_COLUMNS,
    {
      key: "restore",
      header: "Restore",
      render: (version) => (
        <Button
          disabled={!writable || version.redacted}
          aria-describedby={
            !writable
              ? "memory-restore-scope-note"
              : version.redacted
                ? "memory-restore-redacted-note"
                : undefined
          }
          // The button sits inside an interactive row (Table onRowActivate);
          // restoring must not also toggle the version panel — and Enter/
          // Space on the focused button must activate IT, not the row.
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setPendingRestore(version);
          }}
        >
          Restore
        </Button>
      ),
    },
  ];

  return (
    <>
      <p className={styles.hint}>
        Versions belong to the store and survive memory deletion; they are
        retained 30 days (recent versions always kept). Restore copies a
        version&apos;s content into a new head version — history is never
        rewritten. Redacted versions have no content left to restore.
      </p>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(version) => version.id}
        caption="Memory versions"
        onRowActivate={(version) =>
          setOpenVersionId((current) =>
            current === version.id ? null : version.id,
          )
        }
        empty={
          <EmptyState
            title="No versions yet"
            description="Every memory create, update, and delete writes an immutable version here — the store's audit trail."
          />
        }
      />
      {!writable ? (
        <p id="memory-restore-scope-note" className={styles.hint}>
          Restore requires the write scope.
        </p>
      ) : rows.some((version) => version.redacted) ? (
        <p id="memory-restore-redacted-note" className={styles.hint}>
          Redacted versions cannot be restored — their content has been
          scrubbed; only the audit fields remain (§13.6).
        </p>
      ) : null}
      {versions.hasNextPage ? (
        <div className={styles.more}>
          <Button
            onClick={() => void versions.fetchNextPage()}
            disabled={versions.isFetchingNextPage}
          >
            {versions.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {openVersionId !== null ? (
        <VersionDetail
          storeId={storeId}
          versionId={openVersionId}
          autoScroll={openVersionId === restoredId}
        />
      ) : null}

      {/* Non-destructive by design — a plain Dialog, not TypedConfirm:
          nothing is deleted or overwritten, a NEW version is created. */}
      {pendingRestore !== null ? (
        <Dialog open onClose={closeRestoreDialog} title="Restore version">
          {restore.isError ? (
            <div className={styles.dialogError}>
              <ErrorAlert label="restore" error={restore.error} />
            </div>
          ) : null}
          <p className={styles.dialogBody}>
            Restoring copies the content of{" "}
            <code className={styles.mono}>{pendingRestore.id}</code> into a
            NEW version of{" "}
            <code className={styles.mono}>{pendingRestore.memoryPath}</code>,
            which becomes the live head. Nothing is deleted or rewritten —
            every existing version stays in the history. If the memory was
            deleted, this brings it back.
          </p>
          <div className={styles.dialogActions}>
            <Button onClick={closeRestoreDialog}>Cancel</Button>
            <Button
              variant="primary"
              onClick={onRestore}
              disabled={restore.isPending}
            >
              {restore.isPending ? "Restoring…" : "Restore"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/** One version's audit fields (`GET …/versions/:v` returns metadata, not
 * content — the content itself is server-side, reachable via restore). */
function VersionDetail({
  storeId,
  versionId,
  autoScroll = false,
}: {
  storeId: string;
  versionId: string;
  /** Scroll the panel into view on open (set for a just-restored head). */
  autoScroll?: boolean;
}) {
  const version = useMemoryVersion(storeId, versionId);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (autoScroll) sectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [autoScroll, versionId]);

  return (
    <section
      ref={sectionRef}
      aria-label={`Version ${versionId}`}
      className={styles.contentPanel}
    >
      <h2 className={styles.panelTitle}>
        <code className={styles.mono}>{versionId}</code>
      </h2>
      {version.isError ? (
        <ErrorAlert label="version" error={version.error} />
      ) : version.isPending ? (
        <p role="status">Loading version…</p>
      ) : (
        <dl className={styles.meta}>
          <MetaRow label="Path">
            <code className={styles.mono}>{version.data.memoryPath}</code>
          </MetaRow>
          <MetaRow label="Content SHA-256">
            <code className={styles.mono}>{version.data.contentSha256}</code>
          </MetaRow>
          <MetaRow label="Redacted">
            {version.data.redacted ? "yes" : "no"}
          </MetaRow>
          <MetaRow label="Created">
            {formatTimestamp(version.data.createdAt)}
          </MetaRow>
          <MetaRow label="Expires">
            {formatTimestamp(version.data.expiresAt)}
          </MetaRow>
        </dl>
      )}
    </section>
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
