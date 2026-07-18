/**
 * Conversation tab (WP-C4.1; console-spec §10.1 rendering side, `console.md`
 * §5a, journey W5 steps 1–2). The conversation-shaped lens on the session —
 * deliberately NOT the Trace (DP-4: one record, many lenses): seeded from
 * `GET /v1/sessions/:id/messages` (Pi's post-compaction LLM-context view),
 * user messages right-aligned, agent text as markdown-ish plaintext, tool
 * internals compact with the payload one click away
 * (`./conversation-message.tsx`).
 *
 * Freshness is stated honestly (see `src/api/conversation.ts`): stream
 * frames carry entries, never message-shaped data, so turn boundaries land
 * via the detail page's stream invalidating this query on
 * `session.status_*`, and while `running` the query rides the backend's
 * periodic JSONL sync (~30 s) — a visible note points at the Trace for live
 * per-event output.
 *
 * WP-C4.2 adds the turn-lifecycle surface below the transcript
 * (`./conversation-composer.tsx`): the send/wake composer with the
 * client-side mid-turn queue, interrupt, the requires_action panel inline,
 * the §10.3 resume caveats, and the §10.4 hand-back (after a non-empty
 * transcript — the DP-5 empty state already teaches the same command).
 */
import { useState } from "react";
import type { Session } from "@pi-managed/contracts";

import {
  MESSAGES_SYNC_REFRESH_MS,
  useSessionMessages,
} from "../../api/conversation.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import {
  ConversationComposer,
  type ComposerQueue,
} from "./conversation-composer.js";
import { ConversationMessage } from "./conversation-message.js";
import { HandBackNote } from "./hand-back-note.js";
import { SessionId } from "./session-id.js";
import styles from "./conversation.module.css";

/** Initial render cap: long transcripts start at the tail (DP-2). */
export const CONVERSATION_TAIL_LIMIT = 100;

export function ConversationTab({
  session,
  queued,
  setQueued,
}: { session: Session } & ComposerQueue) {
  const running = session.status === "running";
  const messages = useSessionMessages(session.id, {
    refetchInterval: running ? MESSAGES_SYNC_REFRESH_MS : false,
  });
  const [showAll, setShowAll] = useState(false);

  if (messages.isError) {
    return (
      <div>
        <ErrorAlert label="conversation" error={messages.error} />
        <Button onClick={() => void messages.refetch()}>Retry</Button>
      </div>
    );
  }
  if (messages.isPending) {
    return <p role="status">Loading conversation…</p>;
  }

  const all = messages.data;
  const truncated = !showAll && all.length > CONVERSATION_TAIL_LIMIT;
  const visible = truncated ? all.slice(-CONVERSATION_TAIL_LIMIT) : all;

  return (
    <div>
      {/* Forked-session seed boundary: `/messages` serves the JSONL tree the
          fork SHARES with its parent, so the transcript includes the
          inherited history — said in place (DP-6) rather than left to
          surprise. */}
      {session.forkedFromSessionId ? (
        <p className={styles.note}>
          Forked from <SessionId id={session.forkedFromSessionId} maxLength={30} /> —
          the conversation includes the history shared up to the fork point.
        </p>
      ) : null}
      {/* Honest mid-turn latency (§10.1): message-shaped data only exists
          post-sync; live per-event output is the Trace lens. */}
      {running ? (
        <p role="status" className={styles.note}>
          Turn in progress — the conversation catches up when the turn
          completes (live events stream in the Trace tab).
        </p>
      ) : null}
      {all.length === 0 ? (
        <EmptyState
          title="No conversation yet"
          description="Messages appear once the session runs a turn — the conversation is the agent's post-compaction message view of the same record the Trace shows event by event."
          cliCommand={`/remote:resume ${session.id}`}
        />
      ) : (
        <>
          {truncated ? (
            <p className={styles.note}>
              Showing the last {CONVERSATION_TAIL_LIMIT} of {all.length}{" "}
              messages.{" "}
              <Button onClick={() => setShowAll(true)}>
                Show all {all.length} messages
              </Button>
            </p>
          ) : null}
          <ol className={styles.list} aria-label="Conversation">
            {visible.map((message, i) => (
              <ConversationMessage
                key={(truncated ? all.length - visible.length : 0) + i}
                value={message}
              />
            ))}
          </ol>
        </>
      )}
      {/* WP-C4.2 (§10.1–10.4): continue the session from here. The queue is
          owned by the session-detail page (survives tab switches, F2). */}
      <ConversationComposer
        session={session}
        queued={queued}
        setQueued={setQueued}
      />
      {all.length > 0 ? <HandBackNote sessionId={session.id} /> : null}
    </div>
  );
}
