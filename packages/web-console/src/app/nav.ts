/**
 * Sidebar information architecture (console-spec §7.1): exactly these six
 * top-level items, filtered by scope.
 *
 * Scope filtering (§6.1/§6.2, decided): `read` unlocks ALL
 * browsing/observation surfaces — Home, Sessions, Agents, Jobs, and Resources
 * are all browsable with a `read` key (every GET route requires only `read`,
 * api-reference §"Authorization scopes"), so they stay visible for every
 * scope. `write` adds inline actions (session interaction, job trigger), not
 * sections. Settings is the one purely-management top-level section (API
 * keys · webhooks · tenant — admin surfaces per §6.2 and the sidebar sketch
 * in tmp/console.md §5, "admin scope only"), so it is hidden — not disabled —
 * without `admin`.
 *
 * No top-level item differs by MODE (billing[saas] and health[solo/team]
 * are Settings sub-items, §7.1), so this module stays mode-free; the mode
 * filtering lives in the Settings section layout
 * (`src/features/settings/settings.lazy.tsx`, WP-C3-prep).
 */

import { isAdmin } from "../lib/scopes.js";

export interface NavItem {
  label: string;
  /** Router path (basepath-relative, `router.tsx`). */
  to: string;
  /** Hidden (not disabled) without the `admin` scope (console-spec §6.1). */
  adminOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Home", to: "/" },
  { label: "Sessions", to: "/sessions" },
  { label: "Agents", to: "/agents" },
  { label: "Jobs", to: "/jobs" },
  { label: "Resources", to: "/resources" },
  { label: "Settings", to: "/settings", adminOnly: true },
];

/** The §7.1 sidebar items this key's scopes can use (§6.1: others are hidden). */
export function visibleNavItems(scopes: readonly string[]): NavItem[] {
  const admin = isAdmin(scopes);
  return NAV_ITEMS.filter((item) => !item.adminOnly || admin);
}
