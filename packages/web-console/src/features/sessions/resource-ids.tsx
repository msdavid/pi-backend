/**
 * Agent/environment ids rendered per console-spec §7.6: monospaced,
 * one-click copyable, and a link. Their DETAIL routes land with the phase-3
 * surfaces, so until then these link to the family routes that exist today
 * (`/agents`, `/resources`) — phase 3 upgrades them to the detail routes.
 * Same composition as `./session-id.tsx` (router `<Link>` into the
 * router-agnostic `CopyableId`), sharing its link style.
 */
import { Link } from "@tanstack/react-router";

import { CopyableId } from "../../ui/copyable-id.js";
import styles from "../linked-id.module.css";

export function AgentId({
  id,
  maxLength,
}: {
  id: string;
  maxLength?: number;
}) {
  return (
    <CopyableId
      id={id}
      maxLength={maxLength}
      link={(code) => (
        <Link
          to="/agents"
          className={styles.link}
          // Inside an interactive table row the link is its own action;
          // don't double-fire the row activation.
          onClick={(event) => event.stopPropagation()}
        >
          {code}
        </Link>
      )}
    />
  );
}

export function EnvironmentId({
  id,
  maxLength,
}: {
  id: string;
  maxLength?: number;
}) {
  return (
    <CopyableId
      id={id}
      maxLength={maxLength}
      link={(code) => (
        <Link
          to="/resources"
          className={styles.link}
          onClick={(event) => event.stopPropagation()}
        >
          {code}
        </Link>
      )}
    />
  );
}
