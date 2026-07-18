/**
 * Resources index — the family overview rendered inside the section layout
 * (`resources.lazy.tsx`). One line of DP-6 microcopy per family.
 */
import { createLazyRoute, Link } from "@tanstack/react-router";

import styles from "./resources.module.css";

export const Route = createLazyRoute("/resources/")({
  component: ResourcesIndexPage,
});

const FAMILIES = [
  {
    label: "Environments",
    description:
      "Where sessions run — a cloud sandbox image or your own self-hosted workers.",
    to: "/resources/environments",
  },
  {
    label: "Vaults",
    description:
      "Named credential sets injected into sessions; secret values are write-only.",
    to: "/resources/vaults",
  },
  {
    label: "Memory stores",
    description:
      "Cross-session memory: directories of text documents mounted as a volume in the sandbox.",
    to: "/resources/memory-stores",
  },
  {
    label: "Files",
    description: "Uploaded inputs and artifacts attachable to sessions.",
    to: "/resources/files",
  },
  {
    label: "Skills",
    description: "Reusable instruction packages agents can load.",
    to: "/resources/skills",
  },
] as const;

function ResourcesIndexPage() {
  return (
    <ul className={styles.families}>
      {FAMILIES.map((family) => (
        <li key={family.label} className={styles.family}>
          <span className={styles.familyName}>
            <Link to={family.to} className={styles.familyLink}>
              {family.label}
            </Link>
          </span>
          <span className={styles.familyDescription}>{family.description}</span>
        </li>
      ))}
    </ul>
  );
}
