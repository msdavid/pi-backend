/**
 * §10.4 hand-back (WP-C4.2): the deep-link philosophy running in both
 * directions — the exact extension command to pick this session up
 * interactively (`/remote:resume`,
 * `packages/client-extension/src/commands/remote.ts`), with one-click copy.
 *
 * Split out of `./conversation-composer.tsx` (file-size / single-purpose):
 * the Conversation tab imports it directly (no barrel) and renders it after a
 * non-empty transcript — the DP-5 empty state already teaches the same
 * command, so it is not duplicated there.
 */
import { useCopy } from "../../ui/use-copy.js";
import styles from "./conversation.module.css";

export function HandBackNote({ sessionId }: { sessionId: string }) {
  const command = `/remote:resume ${sessionId}`;
  const { copied, copy } = useCopy();
  return (
    <p className={styles.handBack}>
      <span>Continue in Pi instead:</span>
      <code className={styles.handBackCommand}>{command}</code>
      <button
        type="button"
        className={styles.handBackCopy}
        aria-label={`Copy command: ${command}`}
        onClick={() => void copy(command)}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </p>
  );
}
