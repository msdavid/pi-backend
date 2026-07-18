/**
 * Session detail (WP-C1.7 + WP-C2.2 + WP-C2.3; console-spec §7.3–§7.5, W2
 * steps 2–4, W4, W6). The header leads with the DP-1 crucial facts — status +
 * stop reason, agent@version + environment, cost so far — followed by the W4
 * interaction surface (`./interact-panel.tsx`: blocking-request approve/deny,
 * steering composer, interrupt); everything else sits below the fold.
 *
 * Tabs: Trace (default), Tree, Usage, Outputs, Conversation (§7.3 order;
 * Conversation is the WP-C4.1 §10.1 lens — render-only until the WP-C4.2
 * composer). The header carries the
 * one write this stage: **Fork** (W6 — write scope, disabled-with-reason
 * under `read`, §6.1); success links to the new session AND shows the
 * CLI-preferred follow-up, `/remote:resume <id>` (§1.4: "fork → resume",
 * §10.4). Visiting a session records it in the per-browser recents and can
 * star it as a favorite (§7.2 — client-side state, no API).
 */
import { createLazyRoute, getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@pi-managed/contracts";

import {
  useForkSession,
  useSession,
  useSessionUsage,
} from "../../api/sessions.js";
import {
  isTerminalSessionStatus,
  useSessionStream,
} from "../../api/session-stream.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import {
  isFavorite,
  recordRecent,
  toggleFavorite,
} from "../../lib/session-shortcuts.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Tabs } from "../../ui/tabs.js";
import { useToast } from "../../ui/toast.js";
import { useCopy } from "../../ui/use-copy.js";
import { ConversationTab } from "./conversation-tab.js";
import { formatTimestamp, formatUsd } from "./format.js";
import { SessionInteractPanel } from "./interact-panel.js";
import { OutputsTab } from "./outputs-tab.js";
import { AgentId, EnvironmentId } from "./resource-ids.js";
import { SessionId } from "./session-id.js";
import { TraceTab } from "./trace-tab.js";
import { TreeTab } from "./tree-tab.js";
import { UsageTab } from "./usage-tab.js";
import styles from "./session-detail.module.css";

export const Route = createLazyRoute("/sessions/$sessionId")({
  component: SessionDetailPage,
});

const routeApi = getRouteApi("/sessions/$sessionId");

function SessionDetailPage() {
  const { sessionId } = routeApi.useParams();
  const session = useSession(sessionId);

  if (session.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="session" error={session.error} />
        <Button onClick={() => void session.refetch()}>Retry</Button>
      </section>
    );
  }
  if (session.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading session…</p>
      </section>
    );
  }

  return <SessionDetail session={session.data} />;
}

function SessionDetail({ session }: { session: Session }) {
  // Cost-so-far shares the Usage tab's query (same key → one request). A
  // usage failure is partial: the header shows "—" and the page still works
  // (v1 parity), with the full error visible on the Usage tab.
  const usage = useSessionUsage(session.id);
  const [favorite, setFavorite] = useState(() => isFavorite(session.id));
  const { scopes } = useAuth();
  const { toast } = useToast();
  const fork = useForkSession(session.id);
  const [forked, setForked] = useState<Session | null>(null);
  const writable = canWrite(scopes);
  // Which tab is active — the interact panel (below) hides on Conversation,
  // where the composer owns interaction (no duplicate inputs/landmarks, F4).
  const [activeTab, setActiveTab] = useState("trace");
  // The composer's client-side message queue (C§10.2). Its home is HERE, not
  // the composer: the tab strip unmounts inactive panels, so a queue owned by
  // the composer would vanish when the user switches to the Trace tab (which
  // the waking note recommends) — dropping queued intent (F2). It is CLIENT
  // intent, not server state, so a detail-level React state is the honest home
  // (no parallel server-state store, C§8.2); it flushes on the composer's
  // remount.
  const [queued, setQueued] = useState<string[]>([]);
  // ONE live stream per viewed session, owned here — not by the Trace tab,
  // which unmounts with tab switches: the stream's invalidations must keep
  // the detail cache (and with it the §8.3 ambient title/favicon and the W4
  // panel) fresh whichever tab is active (§8.1: stop once terminal).
  const stream = useSessionStream(session.id, {
    enabled: !isTerminalSessionStatus(session.status),
  });

  useEffect(() => {
    recordRecent({ id: session.id, title: session.title });
  }, [session.id, session.title]);

  function onFork() {
    fork.mutate(undefined, {
      onSuccess: (created) => {
        setForked(created);
        toast({ message: `Forked — new session ${created.id}`, tone: "success" });
      },
    });
  }

  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{session.title ?? session.id}</h1>
          <span className={styles.actions}>
            {/* W6: fork instead of disturb — a branch sharing history to the
                fork point. Write scope (§6.2); disabled-with-reason (§6.1). */}
            <Button
              variant="primary"
              onClick={onFork}
              disabled={!writable || fork.isPending}
              aria-describedby={writable ? undefined : "fork-scope-note"}
            >
              {fork.isPending ? "Forking…" : "Fork"}
            </Button>
            {!writable ? (
              <span id="fork-scope-note" className={styles.scopeNote}>
                requires the write scope
              </span>
            ) : null}
            <Button
              onClick={() =>
                setFavorite(
                  toggleFavorite({ id: session.id, title: session.title }),
                )
              }
            >
              {favorite ? "Unfavorite" : "Favorite"}
            </Button>
          </span>
        </div>

        {forked ? <ForkNotice forked={forked} /> : null}
        {fork.isError ? <ErrorAlert label="fork" error={fork.error} /> : null}
        {/* DP-1: the 2–3 decisive facts lead. */}
        <div className={styles.facts}>
          <span className={styles.fact}>
            <StatusChip status={session.status} />
            {session.stopReason ? (
              <StatusChip status={session.stopReason} />
            ) : null}
          </span>
          {/* §7.6: agent/environment ids link to their family routes until
              the phase-3 detail routes exist (./resource-ids.tsx). */}
          <span className={styles.fact}>
            <span className={styles.factLabel}>agent</span>
            <AgentId id={session.agentId} maxLength={18} />
            <span className={styles.factLabel}>@v{session.agentVersion}</span>
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>environment</span>
            <EnvironmentId id={session.environmentId} maxLength={18} />
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>cost so far</span>
            <span className={styles.cost}>
              {usage.data ? formatUsd(usage.data.usdCost) : "—"}
            </span>
          </span>
        </div>
        <dl className={styles.meta}>
          <MetaRow label="ID">
            <SessionId id={session.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Created">
            {formatTimestamp(session.createdAt)}
          </MetaRow>
          <MetaRow label="Updated">
            {formatTimestamp(session.updatedAt)}
          </MetaRow>
          <MetaRow label="Last activity">
            {formatTimestamp(session.lastActivityAt)}
          </MetaRow>
          <MetaRow label="Forked from">
            {session.forkedFromSessionId ? (
              <SessionId id={session.forkedFromSessionId} maxLength={30} />
            ) : (
              "—"
            )}
          </MetaRow>
        </dl>
      </header>

      {/* W4 (WP-C2.2): blocking-request panel + steer/interrupt controls.
          NOT on the Conversation tab — the composer owns interaction there,
          so rendering both would double the user.message input and the
          Blocking-requests group (F4). */}
      {activeTab !== "conversation" ? (
        <SessionInteractPanel session={session} />
      ) : null}

      <Tabs
        label="Session detail"
        onTabChange={setActiveTab}
        tabs={[
          {
            id: "trace",
            label: "Trace",
            content: (
              <TraceTab sessionId={session.id} streamPhase={stream.phase} />
            ),
          },
          {
            id: "tree",
            label: "Tree",
            content: <TreeTab session={session} />,
          },
          {
            id: "usage",
            label: "Usage",
            content: <UsageTab sessionId={session.id} />,
          },
          {
            id: "outputs",
            label: "Outputs",
            content: <OutputsTab sessionId={session.id} />,
          },
          {
            id: "conversation",
            label: "Conversation",
            content: (
              <ConversationTab
                session={session}
                queued={queued}
                setQueued={setQueued}
              />
            ),
          },
        ]}
      />
    </section>
  );
}

/**
 * W6 outcome, per §1.4: the fork's deep link plus the CLI-preferred
 * follow-up — a fork is a fresh idle session, so the extension command to
 * pick it up interactively is `/remote:resume <id>`
 * (`packages/client-extension/src/commands/remote.ts`).
 */
function ForkNotice({ forked }: { forked: Session }) {
  const command = `/remote:resume ${forked.id}`;
  const { copied, copy } = useCopy();
  return (
    <div role="status" className={styles.forkNotice}>
      <p className={styles.forkNoticeLine}>
        Forked → <SessionId id={forked.id} maxLength={30} /> — a new session
        sharing history up to the fork point; the original is unaffected.
      </p>
      <p className={styles.forkNoticeLine}>
        <span>Continue it in the CLI:</span>
        <code className={styles.forkCommand}>{command}</code>
        <button
          type="button"
          className={styles.forkCopy}
          aria-label={`Copy command: ${command}`}
          onClick={() => void copy(command)}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </p>
    </div>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/sessions" className={styles.backLink}>
        ← Sessions
      </Link>
    </p>
  );
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>{children}</dd>
    </div>
  );
}
