/**
 * Home (WP-C1.7; console-spec §7.2, W1 step 3): headline strip, sessions in
 * `requires_action`, active sessions, and the per-browser recents +
 * favorites (client-side state, no API — `src/lib/session-shortcuts.ts`).
 *
 * Headline strip: DP-14 caps it at 5 metrics; phase 1 shows the three the
 * read surface can compute (active / requires-action / favorites). The saas
 * balance + burn strip (§11.8, WP-C5.4) renders ABOVE it via
 * `<SaasBillingHome>` (saas mode only), carrying the balance/runway headline
 * and the unverified/low/suspended banner.
 *
 * The "Requires action" section (WP-C2.2, §7.5) is powered by the
 * server-side `?stopReason=requires_action` filter (WP-C2.0) via
 * `useRequiresActionSessions` — the same polled query behind the sidebar
 * badge (one request serves both; interval documented at
 * `REQUIRES_ACTION_REFRESH_MS`).
 *
 * Truncation honesty: both session sections read ONE first page (50
 * requiring action / 25 running). When the server reports another page, the
 * metric values ("N+") / labels and the sections say so explicitly (with a
 * link to the full Sessions list) instead of silently understating.
 *
 * First-run card (WP-C3.8, DP-12): while the W8 checklist is incomplete it
 * must be reachable from Home, not only via a manual /signup visit — the
 * card links back to the checklist. Rendered (and its cross-family probe
 * fired) only where the checklist itself exists: saas mode with onboarding
 * enabled (`signup.lazy.tsx` gates identically); complete or unknown
 * progress renders nothing.
 */
import { createLazyRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { useConsoleConfig } from "../../api/console.js";
import { useFirstRunProgress } from "../../api/onboarding.js";
import { SaasBillingHome } from "../billing/home-billing.js";
import {
  useRequiresActionSessions,
  useSessions,
} from "../../api/sessions.js";
import { listFavorites, listRecents } from "../../lib/session-shortcuts.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { SessionList, ShortcutList, TruncationNote } from "./home-lists.js";
import styles from "./home.module.css";

export const Route = createLazyRoute("/")({
  component: HomePage,
});

function HomePage() {
  const active = useSessions({ status: "running", limit: 25 });
  // §7.5: the exact server-filtered set, shared with the sidebar badge.
  const waiting = useRequiresActionSessions();
  // Shortcuts are read once per mount — they only change via navigation.
  const [recents] = useState(listRecents);
  const [favorites] = useState(listFavorites);

  const activeSessions = active.data?.pages.flatMap((p) => p.data) ?? [];
  const requiresAction = waiting.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <section>
      <h1 className={styles.title}>Home</h1>

      {/* saas: balance + burn + the unverified/low/suspended banner (§11.8).
          Renders nothing in solo/team or when billing isn't enrolled. */}
      <SaasBillingHome />

      <FirstRunCard />

      <section className={styles.strip} aria-label="Headline metrics">
        {/* When another page exists the count covers only the first page —
            the label / "N+" value says so (truncation honesty). */}
        <Metric
          label={
            active.hasNextPage
              ? "Active sessions (25 most recent)"
              : "Active sessions"
          }
          value={active.isSuccess ? String(activeSessions.length) : "—"}
        />
        <Metric
          label="Requires action"
          value={
            waiting.isSuccess
              ? `${requiresAction.length}${waiting.hasNextPage ? "+" : ""}`
              : "—"
          }
          tone={requiresAction.length > 0 ? "warning" : undefined}
        />
        <Metric label="Favorites" value={String(favorites.length)} />
      </section>

      <HomeSection title="Requires action">
        {waiting.isError ? (
          <ErrorAlert label="sessions" error={waiting.error} />
        ) : waiting.isPending ? (
          <Loading />
        ) : (
          <>
            {requiresAction.length === 0 ? (
              <p className={styles.muted}>
                Nothing is waiting on you — sessions stopped on a blocking
                request appear here.
              </p>
            ) : (
              <SessionList sessions={requiresAction} showStopReason />
            )}
            {waiting.hasNextPage ? (
              <TruncationNote scanned="50 most recent sessions requiring action" />
            ) : null}
          </>
        )}
      </HomeSection>

      <HomeSection title="Active sessions">
        {active.isError ? (
          <ErrorAlert label="active sessions" error={active.error} />
        ) : active.isPending ? (
          <Loading />
        ) : (
          <>
            {activeSessions.length === 0 ? (
              <EmptyState
                title="No sessions running"
                description="Delegate work from your terminal and watch it here."
                cliCommand='/remote:delegate "fix the login bug"'
              />
            ) : (
              <SessionList sessions={activeSessions} />
            )}
            {active.hasNextPage ? (
              <TruncationNote scanned="25 most recent running sessions" />
            ) : null}
          </>
        )}
      </HomeSection>

      <HomeSection title="Recently viewed">
        {recents.length === 0 ? (
          <p className={styles.muted}>Sessions you open appear here.</p>
        ) : (
          <ShortcutList shortcuts={recents} />
        )}
      </HomeSection>

      <HomeSection title="Favorites">
        {favorites.length === 0 ? (
          <p className={styles.muted}>
            Star a session on its detail page to pin it here.
          </p>
        ) : (
          <ShortcutList shortcuts={favorites} />
        )}
      </HomeSection>
    </section>
  );
}

/**
 * DP-12 (WP-C3.8): the incomplete first-run checklist, reachable from Home.
 * Probes only where the checklist exists (saas + onboarding enabled — the
 * same gate `signup.lazy.tsx` applies); renders nothing while progress is
 * unknown, on probe failure (the card is a nudge, not a surface — the
 * checklist page itself renders errors per DP-9), or once all steps are done.
 */
function FirstRunCard() {
  const config = useConsoleConfig();
  const enabled =
    config.data?.mode === "saas" && config.data.onboardingEnabled === true;
  const progress = useFirstRunProgress({ enabled });
  if (!enabled || !progress.data) return null;

  const steps = [
    progress.data.hasModelProviderKey,
    progress.data.hasAgent,
    progress.data.hasSession,
  ];
  const done = steps.filter(Boolean).length;
  if (done === steps.length) return null;

  return (
    <section aria-label="Finish setting up" className={styles.firstRun}>
      <p className={styles.firstRunText}>
        <strong>Finish setting up</strong> — {done} of {steps.length} first-run
        steps done. Sessions fail closed until a model provider key exists.
      </p>
      <Link to="/signup" className={styles.viewAll}>
        Resume the setup checklist
      </Link>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className={styles.metric}>
      <span className={styles.metricValue} data-tone={tone}>
        {value}
      </span>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}

function HomeSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function Loading() {
  return <p role="status">Loading…</p>;
}
