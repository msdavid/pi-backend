/**
 * Environments list (WP-C3.2; console-spec §9.2, journey W10/W12).
 * Browsing is all-scopes; create is a `write` mutation (§6.2 — the backend
 * guards `POST /v1/environments` with method→scope, `write`; §6.1: the
 * inline action is disabled WITH its reason for read-only keys). The empty
 * state teaches the create flow and the API-equivalent command (DP-5).
 */
import { createLazyRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Environment, ResourceStatus } from "@pi-managed/contracts";

import { useEnvironments } from "../../api/environments.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Select } from "../../ui/select.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { formatTimestamp } from "../sessions/format.js";
import { LinkedId } from "../linked-id.js";
import { EnvironmentCreateDialog } from "./environment-create-dialog.js";
import { ENVIRONMENT_EXPLAINER } from "./environment-copy.js";
import styles from "./environments.module.css";

export const Route = createLazyRoute("/resources/environments")({
  component: EnvironmentsPage,
});

/** The API-equivalent create command (DP-5; api-reference §"Environments"). */
const CREATE_CLI_COMMAND =
  "curl -X POST $PI_URL/v1/environments -H \"Authorization: Bearer $PI_KEY\" -H \"Idempotency-Key: $(uuidgen)\" -H \"Content-Type: application/json\" -d '{\"name\":\"python-env\",\"type\":\"cloud\"}'";

const COLUMNS: Array<Column<Environment>> = [
  { key: "name", header: "Name", render: (env) => env.name },
  {
    key: "id",
    header: "ID",
    render: (env) => (
      <LinkedId
        id={env.id}
        maxLength={24}
        to="/resources/environments/$environmentId"
        params={{ environmentId: env.id }}
      />
    ),
  },
  { key: "type", header: "Type", render: (env) => env.type },
  {
    key: "status",
    header: "Status",
    render: (env) => <StatusChip status={env.status} />,
  },
  {
    key: "updated",
    header: "Updated",
    render: (env) => formatTimestamp(env.updatedAt),
  },
];

function EnvironmentsPage() {
  const navigate = useNavigate();
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const [status, setStatus] = useState<ResourceStatus | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const environments = useEnvironments(status ? { status } : {});
  const rows = environments.data?.pages.flatMap((page) => page.data) ?? [];

  const createButton = (
    <span className={styles.action}>
      <Button
        variant="primary"
        onClick={() => setCreating(true)}
        disabled={!writable}
        aria-describedby={writable ? undefined : "env-create-scope-note"}
      >
        Create environment
      </Button>
      {!writable ? (
        <span id="env-create-scope-note" className={styles.scopeNote}>
          requires the write scope
        </span>
      ) : null}
    </span>
  );

  return (
    <section>
      <p className={styles.back}>
        <Link to="/resources" className={styles.backLink}>
          ← Resources
        </Link>
      </p>
      <header className={styles.header}>
        <h1 className={styles.title}>Environments</h1>
        <span className={styles.headerActions}>
          {createButton}
          <Button
            onClick={() => void environments.refetch()}
            disabled={environments.isRefetching}
          >
            Refresh
          </Button>
        </span>
      </header>
      <p className={styles.hint}>{ENVIRONMENT_EXPLAINER}</p>

      <div className={styles.filters}>
        <Select
          label="Status"
          value={status ?? ""}
          onChange={(e) =>
            setStatus((e.target.value || undefined) as ResourceStatus | undefined)
          }
        >
          <option value="">all</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
        </Select>
      </div>

      {environments.isError ? (
        <ErrorAlert label="environments" error={environments.error} />
      ) : environments.isPending ? (
        <p role="status">Loading environments…</p>
      ) : (
        <>
          <Table
            columns={COLUMNS}
            rows={rows}
            rowKey={(env) => env.id}
            caption="Environments"
            onRowActivate={(env) =>
              void navigate({
                to: "/resources/environments/$environmentId",
                params: { environmentId: env.id },
              })
            }
            empty={
              <EmptyState
                title={status ? "No environments match" : "No environments yet"}
                description={ENVIRONMENT_EXPLAINER}
                cliCommand={CREATE_CLI_COMMAND}
              >
                {writable ? (
                  <Button variant="primary" onClick={() => setCreating(true)}>
                    Create environment
                  </Button>
                ) : null}
              </EmptyState>
            }
          />
          {environments.hasNextPage ? (
            <div className={styles.more}>
              <Button
                onClick={() => void environments.fetchNextPage()}
                disabled={environments.isFetchingNextPage}
              >
                {environments.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <EnvironmentCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
      />
    </section>
  );
}
