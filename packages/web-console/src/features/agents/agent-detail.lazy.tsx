/**
 * Agent detail (WP-C3.1; console-spec §9.1, journeys W10 + W16): DP-1 facts
 * (status, current version, timestamps), the definition rendered readably
 * (`./definition.tsx` — the W16 governance view), browsable version history,
 * and a deep link to the sessions running this agent.
 *
 * Management ops — `write` scope (§6.2; the backend guards agent mutations
 * with method→scope, `write`; disabled-with-reason otherwise, §6.1):
 * - Edit → PATCH. The dialog says PLAINLY that saving creates version n+1
 *   and running sessions keep their version (§9.1 normative copy).
 * - Archive → terminal, DP-7 TypedConfirmDialog naming the real consequence:
 *   the count of scheduled jobs this auto-archives (`./referencing-jobs.ts`).
 */
import { createLazyRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import type { Agent, AgentCreate } from "@pi-managed/contracts";

import {
  useAgent,
  useAgentVersions,
  useArchiveAgent,
  useUpdateAgent,
} from "../../api/agents.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { JsonViewer } from "../../ui/json-viewer.js";
import { StatusChip } from "../../ui/status-chip.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { AgentFormDialog, valuesFromAgent } from "./agent-form.js";
import { AgentDefinition } from "./definition.js";
import {
  describeArchiveConsequence,
  useReferencingJobs,
} from "./referencing-jobs.js";
import styles from "./agent-detail.module.css";

export const Route = createLazyRoute("/agents/$agentId")({
  component: AgentDetailPage,
});

const routeApi = getRouteApi("/agents/$agentId");

function AgentDetailPage() {
  const { agentId } = routeApi.useParams();
  const agent = useAgent(agentId);

  if (agent.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="agent" error={agent.error} />
        <Button onClick={() => void agent.refetch()}>Retry</Button>
      </section>
    );
  }
  if (agent.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading agent…</p>
      </section>
    );
  }

  return <AgentDetail agent={agent.data} />;
}

function AgentDetail({ agent }: { agent: Agent }) {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const update = useUpdateAgent(agent.id);
  const archive = useArchiveAgent(agent.id);
  const referencingJobs = useReferencingJobs(agent.id, archiveOpen);

  const archived = agent.status === "archived";
  // §6.1: a disabled inline action always says why.
  const actionsNote = !writable
    ? "requires the write scope"
    : archived
      ? "this agent is archived — archival is terminal and read-only"
      : null;

  function openEdit() {
    update.reset();
    setEditOpen(true);
  }

  function submitEdit(body: AgentCreate) {
    update.mutate(body, {
      onSuccess: (updated) => {
        setEditOpen(false);
        toast({
          message: `Version ${updated.currentVersion} created — running sessions keep the version they started with`,
          tone: "success",
        });
      },
    });
  }

  function confirmArchive() {
    archive.mutate(undefined, {
      onSuccess: () => {
        setArchiveOpen(false);
        toast({ message: `Agent ${agent.name} archived`, tone: "success" });
      },
    });
  }

  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{agent.name}</h1>
          <span className={styles.actions}>
            <Button
              onClick={openEdit}
              disabled={!writable || archived}
              aria-describedby={actionsNote ? "agent-actions-note" : undefined}
            >
              Edit
            </Button>
            <Button
              variant="destructive"
              onClick={() => setArchiveOpen(true)}
              disabled={!writable || archived || archive.isPending}
              aria-describedby={actionsNote ? "agent-actions-note" : undefined}
            >
              Archive
            </Button>
            {actionsNote ? (
              <span id="agent-actions-note" className={styles.scopeNote}>
                {actionsNote}
              </span>
            ) : null}
          </span>
        </div>

        {archive.isError ? (
          <ErrorAlert label="archive" error={archive.error} />
        ) : null}

        <div className={styles.facts}>
          <span className={styles.fact}>
            <StatusChip status={agent.status} />
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>current version</span>
            <code className={styles.version}>v{agent.currentVersion}</code>
          </span>
        </div>

        <dl className={styles.meta}>
          <MetaRow label="ID">
            <CopyableId id={agent.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Created">{formatTimestamp(agent.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatTimestamp(agent.updatedAt)}</MetaRow>
        </dl>

        <p className={styles.sessionsLink}>
          <Link
            to="/sessions"
            search={{ agentId: agent.id }}
            className={styles.link}
          >
            Sessions using this agent →
          </Link>
        </p>
      </header>

      <h2 className={styles.sectionTitle}>
        Definition <span className={styles.sectionNote}>v{agent.currentVersion}</span>
      </h2>
      <AgentDefinition config={agent.config} metadata={agent.metadata} />

      <h2 className={styles.sectionTitle}>Version history</h2>
      <p className={styles.note}>
        Versions are immutable; an edit creates a new one. Sessions and jobs
        may pin any version.
      </p>
      <VersionHistory agentId={agent.id} currentVersion={agent.currentVersion} />

      <AgentFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit ${agent.name}`}
        submitLabel={`Save as v${agent.currentVersion + 1}`}
        notice={`Saving creates version ${agent.currentVersion + 1} — versions are immutable. Sessions already running keep the version they started with; omitted fields keep their v${agent.currentVersion} value.`}
        initial={valuesFromAgent(agent)}
        pending={update.isPending}
        submitError={update.isError ? update.error : undefined}
        onSubmit={submitEdit}
      />

      <TypedConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onConfirm={confirmArchive}
        title={`Archive ${agent.name}`}
        resourceName={agent.name}
        consequence={describeArchiveConsequence(referencingJobs)}
        confirmLabel={archive.isPending ? "Archiving…" : "Archive agent"}
      />
    </section>
  );
}

/** Version history rows (config viewable per row — the list carries it). */
function VersionHistory({
  agentId,
  currentVersion,
}: {
  agentId: string;
  currentVersion: number;
}) {
  const versions = useAgentVersions(agentId);

  if (versions.isError) {
    return <ErrorAlert label="version history" error={versions.error} />;
  }
  if (versions.isPending) {
    return <p role="status">Loading versions…</p>;
  }

  const rows = versions.data.pages.flatMap((page) => page.data);
  if (rows.length === 0) {
    return <p className={styles.note}>No versions recorded.</p>;
  }

  return (
    <>
      <ol className={styles.versionList} aria-label="Version history">
        {rows.map((version) => (
          <li key={version.version} className={styles.versionRow}>
            <span className={styles.versionHead}>
              <code className={styles.version}>v{version.version}</code>
              {version.version === currentVersion ? (
                <span className={styles.currentBadge}>current</span>
              ) : null}
              <span className={styles.versionDate}>
                {formatTimestamp(version.createdAt)}
              </span>
            </span>
            <JsonViewer label="config" value={version.config} />
          </li>
        ))}
      </ol>
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
    </>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/agents" className={styles.link}>
        ← Agents
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
