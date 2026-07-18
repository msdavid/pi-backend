/**
 * Sessions list (WP-C1.7; console-spec §7.3, journey W2 step 1): ONE list
 * (DP-4 — no tabs-by-status), columns id · title · status · agent@version ·
 * environment · created · cost, filters for status/agent/environment, and
 * cursor pagination per api-reference (the `useSessions` infinite query).
 *
 * The cost column shows USD from the `usage.usdCost` rollup the list payload
 * carries (WP-C2.0/WP-C2.2; see `./format.ts` — token counters live on the
 * detail page's Usage tab). Live updates ride the detail page's stream
 * invalidations (WP-C2.1); the Refresh button re-reads on demand.
 */
import { createLazyRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import type { Session, SessionStatus } from "@pi-managed/contracts";

import type { SessionListFilters } from "../../api/sessions.js";
import { useSessions } from "../../api/sessions.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { Select } from "../../ui/select.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { formatSessionCost, formatTimestamp } from "./format.js";
import { AgentId, EnvironmentId } from "./resource-ids.js";
import { SessionId } from "./session-id.js";
import styles from "./sessions.module.css";

export const Route = createLazyRoute("/sessions")({
  component: SessionsPage,
});

const STATUSES: SessionStatus[] = [
  "idle",
  "running",
  "rescheduling",
  "terminated",
];

const COLUMNS: Array<Column<Session>> = [
  { key: "id", header: "ID", render: (s) => <SessionId id={s.id} /> },
  { key: "title", header: "Title", render: (s) => s.title ?? "(untitled)" },
  {
    key: "status",
    header: "Status",
    render: (s) => <StatusChip status={s.status} />,
  },
  {
    key: "agent",
    header: "Agent",
    // §7.6: every id is copyable AND a link — family routes until the
    // phase-3 detail routes exist (see ./resource-ids.tsx).
    render: (s) => (
      <span className={styles.agent}>
        <AgentId id={s.agentId} maxLength={18} />
        <span className={styles.version}>@v{s.agentVersion}</span>
      </span>
    ),
  },
  {
    key: "environment",
    header: "Environment",
    render: (s) => <EnvironmentId id={s.environmentId} maxLength={18} />,
  },
  {
    key: "created",
    header: "Created",
    render: (s) => formatTimestamp(s.createdAt),
  },
  {
    key: "cost",
    header: "Cost (USD)",
    render: (s) => formatSessionCost(s.usage),
    align: "right",
  },
];

function SessionsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<SessionListFilters>({});
  // Text filters commit on submit (typing must not fire a query per key).
  const [agentDraft, setAgentDraft] = useState("");
  const [environmentDraft, setEnvironmentDraft] = useState("");
  const sessions = useSessions(filters);

  const rows = sessions.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Boolean(
    filters.status || filters.agentId || filters.environmentId,
  );

  function applyTextFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters((f) => ({
      ...f,
      agentId: agentDraft.trim() || undefined,
      environmentId: environmentDraft.trim() || undefined,
    }));
  }

  return (
    <section>
      <header className={styles.header}>
        <h1 className={styles.title}>Sessions</h1>
        <Button
          onClick={() => void sessions.refetch()}
          disabled={sessions.isRefetching}
        >
          Refresh
        </Button>
      </header>

      <form className={styles.filters} onSubmit={applyTextFilters}>
        <Select
          label="Status"
          value={filters.status ?? ""}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              status: (e.target.value || undefined) as
                | SessionStatus
                | undefined,
            }))
          }
        >
          <option value="">all</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </Select>
        <Input
          label="Agent id"
          value={agentDraft}
          onChange={(e) => setAgentDraft(e.target.value)}
          placeholder="agent_…"
          spellCheck={false}
        />
        <Input
          label="Environment id"
          value={environmentDraft}
          onChange={(e) => setEnvironmentDraft(e.target.value)}
          placeholder="env_…"
          spellCheck={false}
        />
        <Button type="submit" className={styles.apply}>
          Apply filters
        </Button>
      </form>

      {sessions.isError ? (
        <ErrorAlert label="sessions" error={sessions.error} />
      ) : sessions.isPending ? (
        <p role="status">Loading sessions…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(s) => s.id}
            caption="Sessions"
            onRowActivate={(s) =>
              void navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: s.id },
              })
            }
            empty={
              filtered ? (
                <EmptyState
                  title="No sessions match these filters"
                  description="Clear a filter or check the ids — filters match exact resource ids."
                />
              ) : (
                <EmptyState
                  title="No sessions yet"
                  description="A session is a running agent instance inside an environment; delegate work to create one."
                  cliCommand='/remote:delegate "fix the login bug"'
                />
              )
            }
          />
          {sessions.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void sessions.fetchNextPage()}
                disabled={sessions.isFetchingNextPage}
              >
                {sessions.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
