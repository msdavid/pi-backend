/**
 * Agents list (WP-C3.1; console-spec §9.1, journey W10): columns name ·
 * version · status · updated, server-side `?name=` filter, cursor
 * pagination. Create is a resource-management mutation — `write` scope
 * (§6.2; the backend guards `POST /v1/agents` with method→scope, `write`);
 * under `read` the button is disabled with the reason inline (§6.1). The
 * empty state teaches the API-equivalent command (DP-5 — agents have no
 * dedicated CLI command; they are created via `POST /v1/agents`).
 */
import { createLazyRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import type { Agent, AgentCreate } from "@pi-managed/contracts";

import { useAgents, useCreateAgent } from "../../api/agents.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { AgentFormDialog, EMPTY_AGENT_FORM } from "./agent-form.js";
import styles from "./agents.module.css";

export const Route = createLazyRoute("/agents")({
  component: AgentsPage,
});

// DP-5: a WORKING command — the backend hard-requires the bearer, the
// `Idempotency-Key` (POST /v1/agents), and a JSON content type.
const CREATE_CLI = `curl -X POST $PI_URL/v1/agents -H "Authorization: Bearer $PI_KEY" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{"name":"reviewer","model":{"provider":"anthropic","id":"claude-sonnet-4"}}'`;

const COLUMNS: Array<Column<Agent>> = [
  { key: "name", header: "Name", render: (agent) => agent.name },
  {
    key: "version",
    header: "Version",
    render: (agent) => (
      <code className={styles.version}>v{agent.currentVersion}</code>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (agent) => <StatusChip status={agent.status} />,
  },
  {
    key: "updated",
    header: "Updated",
    render: (agent) => formatTimestamp(agent.updatedAt),
  },
];

function AgentsPage() {
  const navigate = useNavigate();
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const { toast } = useToast();
  const [name, setName] = useState<string | undefined>(undefined);
  const [nameDraft, setNameDraft] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const agents = useAgents(name ? { name } : {});
  const create = useCreateAgent();

  const rows = agents.data?.pages.flatMap((page) => page.data) ?? [];

  function applyNameFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setName(nameDraft.trim() || undefined);
  }

  function openCreate() {
    create.reset();
    setCreateOpen(true);
  }

  function submitCreate(body: AgentCreate) {
    create.mutate(body, {
      onSuccess: (agent) => {
        setCreateOpen(false);
        toast({ message: `Agent ${agent.name} created`, tone: "success" });
        void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } });
      },
    });
  }

  return (
    <section>
      <header className={styles.header}>
        <h1 className={styles.title}>Agents</h1>
        <span className={styles.headerActions}>
          <Button
            onClick={() => void agents.refetch()}
            disabled={agents.isRefetching}
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            onClick={openCreate}
            disabled={!writable}
            aria-describedby={writable ? undefined : "new-agent-scope-note"}
          >
            New agent
          </Button>
          {!writable ? (
            <span id="new-agent-scope-note" className={styles.scopeNote}>
              requires the write scope
            </span>
          ) : null}
        </span>
      </header>

      <form className={styles.filters} onSubmit={applyNameFilter}>
        <Input
          label="Name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          placeholder="exact name"
          spellCheck={false}
        />
        <Button type="submit" className={styles.apply}>
          Apply filter
        </Button>
      </form>

      {agents.isError ? (
        <ErrorAlert label="agents" error={agents.error} />
      ) : agents.isPending ? (
        <p role="status">Loading agents…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(agent) => agent.id}
            caption="Agents"
            onRowActivate={(agent) =>
              void navigate({
                to: "/agents/$agentId",
                params: { agentId: agent.id },
              })
            }
            empty={
              name ? (
                <EmptyState
                  title="No agents match this filter"
                  description="The name filter matches the exact agent name."
                />
              ) : (
                <EmptyState
                  title="No agents yet"
                  description="An agent is a named, versioned behavior definition — model, system prompt, tool permissions — that sessions and scheduled jobs reference."
                  cliCommand={CREATE_CLI}
                >
                  {writable ? (
                    <Button variant="primary" onClick={openCreate}>
                      New agent
                    </Button>
                  ) : null}
                </EmptyState>
              )
            }
          />
          {agents.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void agents.fetchNextPage()}
                disabled={agents.isFetchingNextPage}
              >
                {agents.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <AgentFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New agent"
        submitLabel="Create agent"
        initial={EMPTY_AGENT_FORM}
        pending={create.isPending}
        submitError={create.isError ? create.error : undefined}
        onSubmit={submitCreate}
      />
    </section>
  );
}
