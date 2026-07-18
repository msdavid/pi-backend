/**
 * Memory stores list (WP-C2.4; console-spec §9.5 read surface). Browsing is
 * all-scopes; create/update/delete are `write` surfaces not built in the
 * console yet — the empty state teaches the CLI path instead (DP-5).
 */
import { createLazyRoute, Link, useNavigate } from "@tanstack/react-router";
import type { MemoryStore } from "@pi-managed/contracts";

import { useMemoryStores } from "../../api/memory-stores.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { LinkedId } from "../linked-id.js";
import { formatTimestamp } from "../sessions/format.js";
import styles from "./memory-stores.module.css";

export const Route = createLazyRoute("/resources/memory-stores")({
  component: MemoryStoresPage,
});

const COLUMNS: Array<Column<MemoryStore>> = [
  {
    key: "displayTitle",
    header: "Title",
    render: (store) => store.displayTitle,
  },
  {
    key: "id",
    header: "ID",
    render: (store) => (
      <LinkedId
        id={store.id}
        maxLength={24}
        to="/resources/memory-stores/$storeId"
        params={{ storeId: store.id }}
      />
    ),
  },
  { key: "access", header: "Access", render: (store) => store.access },
  {
    key: "status",
    header: "Status",
    render: (store) => <StatusChip status={store.status} />,
  },
  {
    key: "updated",
    header: "Updated",
    render: (store) => formatTimestamp(store.updatedAt),
  },
];

function MemoryStoresPage() {
  const navigate = useNavigate();
  const stores = useMemoryStores();
  const rows = stores.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section>
      <p className={styles.back}>
        <Link to="/resources" className={styles.backLink}>
          ← Resources
        </Link>
      </p>
      <header className={styles.header}>
        <h1 className={styles.title}>Memory stores</h1>
        <Button
          onClick={() => void stores.refetch()}
          disabled={stores.isRefetching}
        >
          Refresh
        </Button>
      </header>

      {stores.isError ? (
        <ErrorAlert label="memory stores" error={stores.error} />
      ) : stores.isPending ? (
        <p role="status">Loading memory stores…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(store) => store.id}
            caption="Memory stores"
            onRowActivate={(store) =>
              void navigate({
                to: "/resources/memory-stores/$storeId",
                params: { storeId: store.id },
              })
            }
            empty={
              <EmptyState
                title="No memory stores yet"
                description="A memory store is a directory of text documents mounted into sessions, so agents keep knowledge across sessions."
                cliCommand="/remote:memory"
              />
            }
          />
          {stores.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void stores.fetchNextPage()}
                disabled={stores.isFetchingNextPage}
              >
                {stores.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
