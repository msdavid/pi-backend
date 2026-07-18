/**
 * Session interaction controls (WP-C2.2; console-spec §7.5, journey W4): the
 * blocking-request panel plus the two steering controls, mounted between the
 * detail header and the tabs.
 *
 * - **Blocking requests** (`./blocking-requests.tsx`) — while the session is
 *   idle on `stopReason: requires_action`, the pending tool request(s)
 *   render with Approve / Deny posting `user.tool_confirmation` (§9.5). The
 *   session's resumption arrives via the §8 stream (or the mutation's
 *   invalidations) and the panel clears itself.
 * - **Steering composer** — one small input + Send posting `user.message`
 *   (idle-only per the API: mid-turn the button says to Interrupt first).
 *   Deliberately NOT the phase-4 Conversation view.
 * - **Interrupt** — while running, `user.interrupt`; confirm-free but
 *   toast-acknowledged.
 *
 * Scope rule (§6.1, W4 watch-out): under a `read` key every control renders
 * disabled WITH the reason, never hidden.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@pi-managed/contracts";

import { useSendSessionEvent } from "../../api/session-events.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { useToast } from "../../ui/toast.js";
import { BlockingRequests, SCOPE_NOTE_ID } from "./blocking-requests.js";
import styles from "./interact-panel.module.css";

export function SessionInteractPanel({ session }: { session: Session }) {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const requiresAction =
    session.status === "idle" && session.stopReason === "requires_action";
  const showComposer =
    session.status === "idle" || session.status === "running";

  if (!requiresAction && !showComposer) return null;

  return (
    <section aria-label="Session controls" className={styles.panel}>
      {requiresAction ? (
        <BlockingRequests sessionId={session.id} writable={writable} />
      ) : null}
      {showComposer ? (
        <div className={styles.steerRow}>
          <SteerComposer session={session} writable={writable} />
          {session.status === "running" ? (
            <InterruptButton sessionId={session.id} writable={writable} />
          ) : null}
        </div>
      ) : null}
      {!writable ? (
        <p id={SCOPE_NOTE_ID} className={styles.scopeNote}>
          requires the write scope — this key can only browse (§6.1)
        </p>
      ) : null}
    </section>
  );
}

/**
 * W4 step 3 (steer): one `user.message`. The API accepts it only while idle
 * (`409 session_not_idle` mid-turn, api-reference §"user.message"), so
 * mid-turn the Send button is disabled with that exact reason instead of
 * inviting a guaranteed 409.
 */
function SteerComposer({
  session,
  writable,
}: {
  session: Session;
  writable: boolean;
}) {
  const send = useSendSessionEvent(session.id);
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const reason = !writable
    ? "requires the write scope"
    : session.status !== "idle"
      ? "session is mid-turn — Interrupt first, then steer"
      : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    send.mutate(
      { type: "user.message", content },
      {
        onSuccess: () => {
          setDraft("");
          toast({ message: "Steering message sent", tone: "success" });
        },
      },
    );
  }

  return (
    <form className={styles.composer} onSubmit={onSubmit}>
      <Input
        label="Steer this session"
        hint="Sends one user.message — not the full conversation view."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. also update the changelog"
        className={styles.composerInput}
      />
      <Button
        type="submit"
        variant="primary"
        disabled={reason !== null || send.isPending}
        aria-describedby={reason ? "steer-disabled-note" : undefined}
      >
        {send.isPending ? "Sending…" : "Send"}
      </Button>
      {reason ? (
        <span id="steer-disabled-note" className={styles.scopeNote}>
          {reason}
        </span>
      ) : null}
      {send.isError ? (
        <ErrorAlert label="steering message" error={send.error} />
      ) : null}
    </form>
  );
}

/** W4 step 3 (stop): `user.interrupt` — confirm-free, toast-acknowledged. */
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
        aria-describedby={writable ? undefined : SCOPE_NOTE_ID}
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
