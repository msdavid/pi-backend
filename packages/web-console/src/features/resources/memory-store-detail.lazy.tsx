/**
 * Memory store detail (WP-C2.4; console-spec §9.5): store facts +
 * instructions, the memories list with per-memory content viewing (fetched
 * only when opened, DP-2; JSON renders in the JsonViewer, anything else as
 * plain text), and the version audit trail with per-version viewing and
 * restore (write scope, WP-C4.0b — see `./memory-versions-tab.tsx`).
 * Redact and store mutations are `write` surfaces not built in the console
 * yet.
 */
import { createLazyRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { MemoryStore, MemorySummary } from "@pi-managed/contracts";

import {
  useMemories,
  useMemory,
  useMemoryStore,
} from "../../api/memory-stores.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { Tabs } from "../../ui/tabs.js";
import { formatTimestamp } from "../sessions/format.js";
import { VersionsTab } from "./memory-versions-tab.js";
import styles from "./memory-store-detail.module.css";

export const Route = createLazyRoute("/resources/memory-stores/$storeId")({
  component: MemoryStoreDetailPage,
});

const routeApi = getRouteApi("/resources/memory-stores/$storeId");

function MemoryStoreDetailPage() {
  const { storeId } = routeApi.useParams();
  const store = useMemoryStore(storeId);

  if (store.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="memory store" error={store.error} />
        <Button onClick={() => void store.refetch()}>Retry</Button>
      </section>
    );
  }
  if (store.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading memory store…</p>
      </section>
    );
  }

  return <MemoryStoreDetail store={store.data} />;
}

function MemoryStoreDetail({ store }: { store: MemoryStore }) {
  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <h1 className={styles.title}>{store.displayTitle}</h1>
        {/* DP-1 facts: access + lifecycle status. */}
        <div className={styles.facts}>
          <span className={styles.fact}>
            <StatusChip status={store.status} />
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>access</span>
            {store.access}
          </span>
        </div>
        <dl className={styles.meta}>
          <MetaRow label="ID">
            <CopyableId id={store.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Instructions">{store.instructions ?? "—"}</MetaRow>
          <MetaRow label="Created">{formatTimestamp(store.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatTimestamp(store.updatedAt)}</MetaRow>
        </dl>
      </header>

      <Tabs
        label="Memory store detail"
        tabs={[
          {
            id: "memories",
            label: "Memories",
            content: <MemoriesTab storeId={store.id} />,
          },
          {
            id: "versions",
            label: "Version history",
            content: <VersionsTab storeId={store.id} />,
          },
        ]}
      />
    </section>
  );
}

// --- Memories (list + content view) ------------------------------------------

const MEMORY_COLUMNS: Array<Column<MemorySummary>> = [
  {
    key: "path",
    header: "Path",
    render: (memory) => <code className={styles.mono}>{memory.path}</code>,
  },
  {
    key: "sha",
    header: "Content SHA-256",
    render: (memory) => (
      <code className={styles.mono}>{memory.contentSha256.slice(0, 12)}…</code>
    ),
  },
  {
    key: "updated",
    header: "Updated",
    render: (memory) => formatTimestamp(memory.updatedAt),
  },
];

function MemoriesTab({ storeId }: { storeId: string }) {
  const memories = useMemories(storeId);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const rows = memories.data?.pages.flatMap((page) => page.data) ?? [];

  if (memories.isError) {
    return <ErrorAlert label="memories" error={memories.error} />;
  }
  if (memories.isPending) return <p role="status">Loading memories…</p>;

  return (
    <>
      <Table
        columns={MEMORY_COLUMNS}
        rows={rows}
        rowKey={(memory) => memory.path}
        caption="Memories"
        onRowActivate={(memory) =>
          setOpenPath((current) =>
            current === memory.path ? null : memory.path,
          )
        }
        empty={
          <EmptyState
            title="No memories in this store"
            description="Agents (and the API) write memories as text documents under paths, like files in a directory."
            cliCommand="/remote:memory"
          />
        }
      />
      {memories.hasNextPage ? (
        <div className={styles.more}>
          <Button
            onClick={() => void memories.fetchNextPage()}
            disabled={memories.isFetchingNextPage}
          >
            {memories.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {openPath !== null ? (
        <MemoryContent storeId={storeId} path={openPath} />
      ) : null}
    </>
  );
}

/** One memory's content, fetched on open (DP-2). */
function MemoryContent({ storeId, path }: { storeId: string; path: string }) {
  const memory = useMemory(storeId, path);
  // Content type: a memory is text on the wire; JSON documents get the
  // structured viewer, everything else renders verbatim (§9.5 "content
  // viewing per API").
  const json = useMemo(() => {
    if (!memory.data) return undefined;
    try {
      const parsed: unknown = JSON.parse(memory.data.content);
      return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
      return undefined;
    }
  }, [memory.data]);

  return (
    <section
      aria-label={`Memory ${path}`}
      className={styles.contentPanel}
    >
      <h2 className={styles.panelTitle}>
        <code className={styles.mono}>{path}</code>
      </h2>
      {memory.isError ? (
        <ErrorAlert label="memory content" error={memory.error} />
      ) : memory.isPending ? (
        <p role="status">Loading content…</p>
      ) : json !== undefined ? (
        <JsonViewer label={path} value={json} />
      ) : (
        <pre className={styles.content}>{memory.data.content}</pre>
      )}
    </section>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/resources/memory-stores" className={styles.backLink}>
        ← Memory stores
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
