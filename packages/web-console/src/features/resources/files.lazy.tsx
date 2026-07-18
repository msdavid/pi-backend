/**
 * Files (WP-C3.6; console-spec §9.5 remainder): list + per-file detail +
 * content download, plus the one cheap mutation the API offers — hard
 * delete. Uploads are multipart and deliberately NOT in the console
 * (`src/api/files-skills.ts` header) — the empty state and microcopy teach
 * the API path instead (DP-5). Files have no detail route (§9.5 is a
 * list-first surface, like memory stores' inline panels): activating a row
 * opens the detail panel below, fetched via `GET /v1/files/:id` (DP-2).
 * Content downloads are plain same-origin `<a href>` anchors — the console
 * session cookie rides the GET, like session outputs.
 *
 * Delete requires the `write` scope (backend `requireScopeByMethod`:
 * mutations → write, admin passes); read-only keys see the reason (C§6.1).
 */
import { createLazyRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import type { File } from "@pi-managed/contracts";

import {
  fileContentDownloadUrl,
  useDeleteFile,
  useFile,
  useFiles,
} from "../../api/files-skills.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { Table, type Column } from "../../ui/table.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { SessionId } from "../sessions/session-id.js";
import { formatBytes } from "../settings/tenant-usage.js";
import styles from "./files-skills.module.css";

export const Route = createLazyRoute("/resources/files")({
  component: FilesPage,
});

const UPLOAD_CURL = `curl -X POST $PI_BACKEND_URL/v1/files -H "Authorization: Bearer $PI_API_KEY" -H "Idempotency-Key: $(uuidgen)" -F file=@report.pdf`;

const COLUMNS: Array<Column<File>> = [
  { key: "name", header: "Name", render: (file) => file.name },
  {
    key: "id",
    header: "ID",
    render: (file) => <CopyableId id={file.id} maxLength={22} />,
  },
  {
    key: "type",
    header: "Content type",
    render: (file) => file.contentType ?? "—",
  },
  {
    key: "size",
    header: "Size",
    render: (file) => formatBytes(file.sizeBytes),
  },
  {
    key: "session",
    header: "Session",
    render: (file) =>
      file.sessionId ? <SessionId id={file.sessionId} maxLength={20} /> : "—",
  },
  {
    key: "created",
    header: "Created",
    render: (file) => formatTimestamp(file.createdAt),
  },
];

function FilesPage() {
  const files = useFiles();
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = files.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section>
      <p className={styles.back}>
        <Link to="/resources" className={styles.backLink}>
          ← Resources
        </Link>
      </p>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Files</h1>
          {/* DP-6: one line — files exist independently of sessions; the
              console reads and deletes, uploads are the API's multipart. */}
          <p className={styles.microcopy}>
            Standalone stored files, independent of any session&apos;s
            lifetime. Upload happens through the API (multipart) — the
            console lists, downloads, and deletes.
          </p>
        </div>
        <Button
          onClick={() => void files.refetch()}
          disabled={files.isRefetching}
        >
          Refresh
        </Button>
      </header>

      {files.isError ? (
        <ErrorAlert label="files" error={files.error} />
      ) : files.isPending ? (
        <p role="status">Loading files…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(file) => file.id}
            caption="Files"
            onRowActivate={(file) =>
              setOpenId((current) => (current === file.id ? null : file.id))
            }
            empty={
              <EmptyState
                title="No files yet"
                description="Upload inputs for agents or keep deliverables around — files survive session deletion."
                cliCommand={UPLOAD_CURL}
              />
            }
          />
          {files.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void files.fetchNextPage()}
                disabled={files.isFetchingNextPage}
              >
                {files.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
          {openId !== null ? (
            <FileDetail id={openId} onDeleted={() => setOpenId(null)} />
          ) : null}
        </>
      )}
    </section>
  );
}

/** Per-file detail panel, fetched on open (DP-2; `GET /v1/files/:id`). */
function FileDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const file = useFile(id);
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const del = useDeleteFile();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  return (
    <section aria-label={`File ${id}`} className={styles.panel}>
      {file.isError ? (
        <ErrorAlert label="file" error={file.error} />
      ) : file.isPending ? (
        <p role="status">Loading file…</p>
      ) : (
        <>
          <h2 className={styles.panelTitle}>{file.data.name}</h2>
          <dl className={styles.meta}>
            <MetaRow label="ID">
              <CopyableId id={file.data.id} maxLength={30} />
            </MetaRow>
            <MetaRow label="Content type">
              {file.data.contentType ?? "—"}
            </MetaRow>
            <MetaRow label="Size">
              {formatBytes(file.data.sizeBytes)} ({file.data.sizeBytes} bytes)
            </MetaRow>
            <MetaRow label="Session">
              {file.data.sessionId ? (
                <SessionId id={file.data.sessionId} maxLength={26} />
              ) : (
                "—"
              )}
            </MetaRow>
            <MetaRow label="Created">
              {formatTimestamp(file.data.createdAt)}
            </MetaRow>
          </dl>
          {file.data.metadata && Object.keys(file.data.metadata).length > 0 ? (
            <JsonViewer label="Metadata" value={file.data.metadata} />
          ) : null}
          <div className={styles.actions}>
            <a
              className={styles.download}
              href={fileContentDownloadUrl(file.data.id)}
              download={file.data.name}
            >
              Download content
            </a>
            <Button
              variant="destructive"
              onClick={() => setConfirming(true)}
              disabled={!writable || del.isPending}
              aria-describedby={writable ? undefined : "file-delete-note"}
            >
              Delete
            </Button>
            {!writable ? (
              <span id="file-delete-note" className={styles.scopeNote}>
                requires the write scope
              </span>
            ) : null}
          </div>
          {del.isError ? (
            <ErrorAlert label="delete file" error={del.error} />
          ) : null}
          <TypedConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            title="Delete file"
            resourceName={file.data.name}
            consequence={`This permanently deletes "${file.data.name}" and its stored content. Hard delete — there is no archive state and no undo.`}
            confirmLabel="Delete file"
            onConfirm={() => {
              setConfirming(false);
              del.mutate(id, {
                onSuccess: () => {
                  toast({ message: "File deleted", tone: "success" });
                  onDeleted();
                },
              });
            }}
          />
        </>
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
