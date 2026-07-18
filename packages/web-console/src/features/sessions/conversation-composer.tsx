/**
 * Conversation composer + turn lifecycle (WP-C4.2; console-spec §10.1–10.4,
 * `console.md` §5a "guard rails", journey W5). The bottom of the Conversation
 * tab: where the `write`-scoped user continues the session from any browser.
 *
 * - **Send / wake (§10.1):** submits one `user.message` while the session is
 *   idle. On the backend that resolves the live runtime
 *   (`sessionManager.getOrCreate` — `api/events.ts`), which cold-wakes the
 *   session and re-provisions its sandbox on demand, so the `202` is an
 *   acceptance, not a reply: a visible waking note (`role="status"`) holds
 *   until the `session.status_run_started` frame flips the cached status
 *   (the page-owned stream, `src/api/session-stream.ts`).
 * - **Queue (§10.2, honest version):** spec phrasing says mid-turn messages
 *   "queue (as the API queues events)", but the REAL API rejects a mid-turn
 *   `user.message` with `409 session_not_idle` (ROB-5,
 *   `packages/backend/src/api/events.ts` — a second concurrent turn would
 *   corrupt the runtime's turn flags). So the queue lives client-side, and —
 *   because the tab strip unmounts inactive panels — its HOME is the
 *   session-detail page (`session-detail.lazy.tsx`), NOT this component:
 *   switching to the Trace tab (which the waking note itself recommends) must
 *   not drop the queue (C§10.2). The queue is passed in as `{queued,
 *   setQueued}` here; the composer renders the chips and enqueues. ONE queued
 *   message is dispatched per return to idle — dispatching more would race the
 *   very guard that made queueing necessary. The flush depends on CURRENT
 *   state (idle && !requires_action && queue non-empty), not on catching the
 *   idle→running→idle transition: a fast turn whose `run_started`+`idle`
 *   invalidations coalesce into a single refetch that already reads idle would
 *   otherwise strand the queue forever (F3). A 409 (the status flip raced the
 *   cache) sets `send.isError`, which pauses the flush until the session is
 *   next seen non-idle then idle again; the chip is retained, never dropped.
 * - **Interrupt (§10.2):** one click while a turn runs, right in the composer
 *   row (`user.interrupt`).
 * - **`requires_action` in the composer (§10.2):** while the session is idle
 *   on a blocking tool request, the phase-2 approve/deny panel
 *   (`./blocking-requests.tsx`) renders here — where you would type — and
 *   the automatic queue flush holds until a human answers (an auto-sent
 *   message while a permission decision is pending would be a surprise).
 * - **Scope/terminal honesty (§6.1, §5a guard rails):** under a `read` key or
 *   on a `terminated` session every control is disabled WITH the reason,
 *   never hidden.
 *
 * The resume-caveats copy (§10.3) lives in this module; the "continue in Pi
 * instead" hand-back (§10.4) is `./hand-back-note.tsx`, placed by the tab
 * after the transcript so the DP-5 empty state (which already teaches the
 * same command) is not duplicated.
 */
import { useEffect, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { Session } from "@pi-managed/contracts";

import { useSendSessionEvent } from "../../api/session-events.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { BlockingRequests } from "./blocking-requests.js";
import styles from "./conversation.module.css";

/** The one disabled-reason note the composer controls point at (§6.1). */
const COMPOSER_NOTE_ID = "conversation-composer-note";

/** The client-side queue, owned by the session-detail page so it survives
 * tab switches (F2 / C§10.2). The composer renders + mutates it via these. */
export interface ComposerQueue {
  queued: string[];
  setQueued: Dispatch<SetStateAction<string[]>>;
}

export function ConversationComposer({
  session,
  queued,
  setQueued,
}: { session: Session } & ComposerQueue) {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const send = useSendSessionEvent(session.id);
  const {
    mutate: sendEvent,
    isPending: sendPending,
    isError: sendError,
    reset: resetSend,
  } = send;
  const [draft, setDraft] = useState("");
  /** A send was accepted while idle — the cold-wake is in flight (§10.1). */
  const [waking, setWaking] = useState(false);

  const status = session.status;
  const requiresAction =
    status === "idle" && session.stopReason === "requires_action";
  const terminal = status === "terminated";
  const midTurn = status === "running" || status === "rescheduling";

  // The turn started (or the session ended): the waking note yields to the
  // tab's turn-in-progress note, and a stale flush 409 (send.isError) clears
  // so the queue can resume flushing at the next idle. Depends on CURRENT
  // status (left idle), never on catching a specific transition (F3); reset
  // only on error, so a healthy in-flight/successful send is left alone.
  useEffect(() => {
    if (status !== "idle") {
      setWaking(false);
      if (sendError) resetSend();
    }
  }, [status, sendError, resetSend]);

  // §10.2 queue flush: ONE queued message per return to idle. State-driven
  // (idle && !requires_action && queue non-empty && no send in flight && no
  // prior 409) — NOT transition-driven, so a coalesced run_started+idle
  // refetch that only ever reads idle cannot strand the queue (F3). A 409
  // (the status flip raced the cache — the very guard the queue exists for)
  // trips send.isError, pausing the flush until the session is next seen
  // non-idle (resetSend above) then idle again; the chip is always retained.
  const flushable = status === "idle" && !requiresAction && writable;
  useEffect(() => {
    if (!flushable || queued.length === 0 || sendPending || sendError) return;
    const content = queued[0]!;
    sendEvent(
      { type: "user.message", content },
      {
        onSuccess: () => {
          setQueued((q) => (q[0] === content ? q.slice(1) : q));
          setWaking(true);
        },
      },
    );
  }, [flushable, queued, sendPending, sendError, sendEvent, setQueued]);

  const disabledReason = !writable
    ? "requires the write scope — this key can only browse"
    : terminal
      ? "session is terminated — fork it to continue from its history"
      : null;
  // Queue (don't send) while a turn runs OR a just-accepted send is still
  // waking the session — a direct send then would hit the ROB-5 409.
  const queuesNow = midTurn || waking;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || disabledReason !== null) return;
    if (queuesNow || sendPending) {
      // §10.2: mid-turn (or while a send is already in flight) the message
      // queues as a visible chip; the flush effect dispatches it.
      setQueued((q) => [...q, content]);
      setDraft("");
      return;
    }
    sendEvent(
      { type: "user.message", content },
      {
        onSuccess: () => {
          setDraft("");
          setWaking(true);
        },
      },
    );
  }

  return (
    <section aria-label="Composer" className={styles.composerArea}>
      {/* §10.2: requires_action surfaces IN the composer — approve/deny
          where you would type (the phase-2 panel, reused). */}
      {requiresAction ? (
        <BlockingRequests sessionId={session.id} writable={writable} />
      ) : null}

      {/* §10.3 resume caveats, at the moment they inform — the session is
          idle and a send will cold-wake it (DP-6; the same caveat Pi gives
          the agent in its resume context). */}
      {status === "idle" && !terminal ? (
        <p className={styles.note}>
          Resuming here cold-starts the sandbox: processes from earlier turns
          are not preserved, outputs download to your machine, and there is no
          local working directory.
        </p>
      ) : null}

      {waking && status === "idle" ? (
        <p role="status" className={styles.note}>
          Message accepted — waking the session (the sandbox re-provisions on
          demand). The reply lands here at turn end; live events stream in the
          Trace tab.
        </p>
      ) : null}

      {queued.length > 0 ? (
        <div>
          <p role="status" className={styles.note}>
            Queued — held in this browser tab and sent automatically, one per
            turn, when the session returns to idle.
          </p>
          <ul className={styles.queueList} aria-label="Queued messages">
            {queued.map((content, i) => (
              <li key={`${i}-${content}`} className={styles.queueChip}>
                <span className={styles.queueText}>{content}</span>
                <button
                  type="button"
                  className={styles.queueRemove}
                  aria-label={`Remove queued message: ${content}`}
                  onClick={() =>
                    setQueued((q) => q.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form className={styles.composerForm} onSubmit={onSubmit}>
        <Input
          label="Message"
          hint={
            queuesNow
              ? "A turn is in flight — this message will queue."
              : "Sends user.message — an idle session wakes and runs a turn."
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Continue the conversation…"
          className={styles.composerInput}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={disabledReason !== null || (!queuesNow && sendPending)}
          aria-describedby={disabledReason ? COMPOSER_NOTE_ID : undefined}
        >
          {queuesNow ? "Queue" : sendPending ? "Sending…" : "Send"}
        </Button>
        {/* §10.2: interrupt is one click from the composer while running. */}
        {midTurn ? (
          <InterruptButton sessionId={session.id} writable={writable} />
        ) : null}
      </form>
      {disabledReason ? (
        <p id={COMPOSER_NOTE_ID} className={styles.note}>
          {disabledReason}
        </p>
      ) : null}
      {send.isError ? <ErrorAlert label="message" error={send.error} /> : null}
    </section>
  );
}

/** W5 interrupt: `user.interrupt`, confirm-free, toast-acknowledged (the
 * same behavior as the W4 control in `./interact-panel.tsx`). */
function InterruptButton({
  sessionId,
  writable,
}: {
  sessionId: string;
  writable: boolean;
}) {
  const interrupt = useSendSessionEvent(sessionId);
  const { toast } = useToast();
  return (
    <span className={styles.interrupt}>
      <Button
        disabled={!writable || interrupt.isPending}
        aria-describedby={writable ? undefined : COMPOSER_NOTE_ID}
        onClick={() =>
          interrupt.mutate(
            { type: "user.interrupt" },
            {
              onSuccess: () =>
                toast({
                  message:
                    "Interrupt sent — the turn stops; send a message to redirect",
                  tone: "success",
                }),
            },
          )
        }
      >
        {interrupt.isPending ? "Interrupting…" : "Interrupt"}
      </Button>
      {interrupt.isError ? (
        <ErrorAlert label="interrupt" error={interrupt.error} />
      ) : null}
    </span>
  );
}
