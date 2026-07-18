/**
 * Settings — section layout (console-spec §7.1: API keys · webhooks · tenant
 * · billing[saas] · health[solo/team]; the submenu swaps in, no deeper
 * sidebar nesting). The sub-navigation is persistent across the settings
 * screens; the index route (`settings-index.lazy.tsx`) carries the overview.
 *
 * MODE RULES (C§7.1, §5; mode from `/console/config`): Health renders only
 * in `solo`/`team` (decided: no `/readyz` widget for saas tenants,
 * console.md §10.4). While the config query is in flight the mode-dependent
 * item is simply absent — a route present/absent is the sanctioned kind of
 * mode difference (§5.4), and the /settings/health ROUTE stays registered
 * for every mode (deep links resolve; the page states why it is empty).
 */
import { createLazyRoute, Link, Outlet } from "@tanstack/react-router";

import { useConsoleConfig } from "../../api/console.js";
import styles from "./settings.module.css";

export const Route = createLazyRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const config = useConsoleConfig();
  const mode = config.data?.mode;

  const sections: Array<{ label: string; to: string }> = [
    { label: "API keys", to: "/settings/api-keys" },
    { label: "Webhooks", to: "/settings/webhooks" },
    { label: "Tenant", to: "/settings/tenant" },
    // Billing is a saas-only surface (C§11.8, WP-C5.4): balance, ledger,
    // top-up, auto-charge. Hidden in solo/team (self-hosters are never
    // balance-gated); the /settings/billing ROUTE stays registered for every
    // mode (deep links resolve; the page states why it is empty out of mode).
    ...(mode === "saas" ? [{ label: "Billing", to: "/settings/billing" }] : []),
    ...(mode === "solo" || mode === "team"
      ? [{ label: "Health", to: "/settings/health" }]
      : []),
  ];

  return (
    <section>
      <h1 className={styles.title}>Settings</h1>
      <nav aria-label="Settings sections" className={styles.subnav}>
        <ul className={styles.subnavList}>
          {sections.map((section) => (
            <li key={section.to}>
              <Link
                to={section.to}
                className={styles.subnavLink}
                activeProps={{ "aria-current": "page" }}
              >
                {section.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </section>
  );
}
