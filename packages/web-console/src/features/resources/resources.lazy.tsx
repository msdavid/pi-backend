/**
 * Resources — section layout (console-spec §7.1: a top-level item MAY swap
 * in a contextual submenu; no deeper sidebar nesting). The sub-navigation is
 * persistent across the family screens; the index route
 * (`resources-index.lazy.tsx`) carries the family overview. All five family
 * screens are live: memory stores (WP-C2.4, §9.5), environments (WP-C3.2),
 * vaults (WP-C3.3), and files/skills (WP-C3.6).
 */
import { createLazyRoute, Link, Outlet } from "@tanstack/react-router";

import styles from "./resources.module.css";

export const Route = createLazyRoute("/resources")({
  component: ResourcesLayout,
});

/** The §7.1 submenu entries, in sidebar-sketch order (tmp/console.md §5). */
const SECTIONS = [
  { label: "Environments", to: "/resources/environments" },
  { label: "Vaults", to: "/resources/vaults" },
  { label: "Memory stores", to: "/resources/memory-stores" },
  { label: "Files", to: "/resources/files" },
  { label: "Skills", to: "/resources/skills" },
] as const;

function ResourcesLayout() {
  return (
    <section>
      <h1 className={styles.title}>Resources</h1>
      <nav aria-label="Resources sections" className={styles.subnav}>
        <ul className={styles.subnavList}>
          {SECTIONS.map((section) => (
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
