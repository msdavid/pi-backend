/**
 * App shell (WP-C1.6): the root route's layout. `ConsoleRoot` stacks the
 * providers and the auth gate; `AppShell` renders the scope-variant sidebar
 * (console-spec §7.1 items, §6.1 filtering in `./nav.ts`) with the §7.5
 * requires_action badge on Sessions (WP-C2.2), the §6.3 read-only badge, the
 * one-time admin least-privilege nudge, and sign-out.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useDeleteConsoleSession } from "../api/console.js";
import { useApiClient } from "../api/provider.js";
import {
  sessionOptions,
  useRequiresActionSessions,
} from "../api/sessions.js";
import {
  ambientStatusOf,
  applyAmbientStatus,
  restoreAmbientDefaults,
} from "../lib/ambient-status.js";
import { isAdmin, isReadOnly } from "../lib/scopes.js";
import { Button } from "../ui/button.js";
import { cx } from "../ui/cx.js";
import { ToastProvider, useToast } from "../ui/toast.js";
import { AuthGate, useAuth } from "./auth.js";
import { visibleNavItems } from "./nav.js";
import styles from "./shell.module.css";

/** Root route component: providers → auth gate → signed-in shell. */
export function ConsoleRoot() {
  // PUBLIC routes render outside the auth gate and the signed-in shell:
  //  - /signup (WP-C3-prep; §9.6/§5.3) — sign-up precedes any session.
  //  - /verify-email (WP-C5.4; §11.1) — the trial-verification link is clicked
  //    straight from the email, possibly before signing in; the endpoint it
  //    calls (`POST /v1/onboarding/verify-email`) is itself public.
  const pathname = useLocation({ select: (location) => location.pathname });
  const publicPath = pathname.replace(/\/+$/, "");
  if (publicPath === "/signup" || publicPath === "/verify-email") {
    return (
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    );
  }
  return (
    <ToastProvider>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </ToastProvider>
  );
}

export function AppShell() {
  const auth = useAuth();
  const signOut = useDeleteConsoleSession();
  const { toast } = useToast();
  /**
   * Phone-width drawer state (WP-C4.3; console-spec §10.5). On desktop the
   * sidebar is always visible and the toggle is `display: none` (CSS-only —
   * `shell.module.css` media query); at phone width the sidebar becomes a
   * top bar and this button discloses the nav + session block as a drawer.
   * Plain `aria-expanded`/`aria-controls` disclosure — keyboard- and
   * axe-safe by construction, no focus trap needed (the page behind stays
   * interactive; it is a disclosure, not a modal).
   */
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className={styles.shell}>
      <AmbientSessionStatus />
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <span className={styles.brand}>Pi Console</span>
          <Button
            className={styles.menuToggle}
            aria-expanded={navOpen}
            aria-controls="shell-drawer"
            onClick={() => setNavOpen((open) => !open)}
          >
            Menu
          </Button>
        </div>
        <div
          id="shell-drawer"
          className={cx(styles.drawer, navOpen && styles.drawerOpen)}
        >
          <nav
            aria-label="Primary"
            className={styles.nav}
            // Following a nav link is the drawer's exit path on a phone —
            // the click bubbles here before the route change unmounts
            // nothing (the shell persists across routes).
            onClick={() => setNavOpen(false)}
          >
            <ul className={styles.navList}>
              {visibleNavItems(auth.scopes).map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={styles.navLink}
                    activeOptions={{ exact: item.to === "/" }}
                  >
                    {item.label}
                    {/* §7.5: requires_action surfaces globally, not only on
                        the session's own page (WP-C2.2). */}
                    {item.to === "/sessions" ? <RequiresActionBadge /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {/* W1: after sign-in the page shows the tenant name and key scopes. */}
          <div className={styles.session}>
            <span className={styles.tenant}>{auth.tenant.name}</span>
            <span className={styles.scopes}>
              key scopes: {auth.scopes.join(", ")}
            </span>
            {isReadOnly(auth.scopes) ? (
              <span className={styles.badge}>browsing read-only</span>
            ) : null}
            <Button
              className={styles.signOut}
              disabled={signOut.isPending}
              onClick={() =>
                signOut.mutate(undefined, {
                  onError: (error) =>
                    toast({ message: error.message, tone: "danger" }),
                })
              }
            >
              Sign out
            </Button>
          </div>
        </div>
      </aside>
      <main className={styles.main}>
        {isAdmin(auth.scopes) ? <AdminNudge /> : null}
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The §7.5 sidebar badge (WP-C2.2): how many sessions are idle on
 * `stopReason: requires_action` — the server-filtered first page
 * (`useRequiresActionSessions`; shared with Home, polled every
 * `REQUIRES_ACTION_REFRESH_MS` and additionally refreshed by the stream's
 * `session.status_*` invalidations). Hidden at zero; "N+" when another page
 * exists (truncation honesty).
 */
function RequiresActionBadge() {
  const waiting = useRequiresActionSessions();
  const count = waiting.data?.pages.flatMap((p) => p.data).length ?? 0;
  if (count === 0) return null;
  return (
    <span className={styles.navBadge}>
      {count}
      {waiting.hasNextPage ? "+" : ""}
      <span className={styles.visuallyHidden}> sessions require action</span>
    </span>
  );
}

/**
 * Ambient status (WP-C2.5; console-spec §8.3, DP-11): while a session detail
 * route is on screen, the tab title + favicon mirror that session's status.
 * Mounted once here rather than in the detail route: it observes the router's
 * `sessionId` param and the SAME `sessionKeys.detail` cache the detail page
 * fills and the live stream's invalidations keep fresh (§8.2), enabled only
 * on session routes; leaving the route (or unmounting the shell) restores the
 * page defaults.
 */
function AmbientSessionStatus() {
  const { sessionId } = useParams({ strict: false });
  const api = useApiClient();
  const session = useQuery({
    ...sessionOptions(sessionId ?? "", api),
    enabled: sessionId !== undefined,
  });
  const status =
    sessionId !== undefined && session.data
      ? ambientStatusOf(session.data)
      : null;

  useEffect(() => {
    if (status === null) restoreAmbientDefaults();
    else applyAmbientStatus(status);
  }, [status]);
  // Route leave resets via the effect above; shell unmount resets here.
  useEffect(() => () => restoreAmbientDefaults(), []);
  return null;
}

/**
 * One-time least-privilege nudge for admin-scoped sign-ins (console-spec
 * §6.3, DP-8). The dismissed flag is per-browser UI state, not a secret —
 * localStorage is fine (§4.1 bans key material, not preferences).
 */
const NUDGE_DISMISSED_KEY = "pi-console.admin-nudge-dismissed";

function isNudgeDismissed(): boolean {
  try {
    return window.localStorage.getItem(NUDGE_DISMISSED_KEY) === "1";
  } catch {
    return false; // Storage unavailable (privacy mode) — show the nudge.
  }
}

function AdminNudge() {
  const [dismissed, setDismissed] = useState(isNudgeDismissed);
  if (dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(NUDGE_DISMISSED_KEY, "1");
    } catch {
      // Persisting is best-effort; still dismiss for this page.
    }
    setDismissed(true);
  }

  return (
    <section aria-label="Least-privilege recommendation" className={styles.nudge}>
      <p className={styles.nudgeText}>
        You are signed in with an admin-scoped key. For everyday browsing,
        use a read-scoped key instead — issue one under Settings → API keys.
      </p>
      <Button onClick={dismiss}>Got it</Button>
    </section>
  );
}
