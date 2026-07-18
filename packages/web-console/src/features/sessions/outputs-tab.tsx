/**
 * Outputs tab (WP-C2.3; console-spec §7.3, W2 step 4 / W3 step 3: "list and
 * download files"). Lists `GET /v1/sessions/:id/outputs` — the files the
 * agent wrote to `/mnt/session/outputs/` in its sandbox — and links each to
 * the download route. Downloads are plain `<a href>` anchors to the
 * cookie-authed same-origin `/v1/…/outputs/:filename` endpoint (the console
 * session cookie rides every same-origin GET; the anchor's `download`
 * attribute names the file — the response sets no `Content-Disposition`).
 *
 * The API is idle-only: a non-idle session answers `409 session_not_idle`,
 * rendered here as one line of DP-6 microcopy instead of a raw error.
 */
import { ConsoleApiError } from "../../api/client.js";
import {
  sessionOutputDownloadUrl,
  useSessionOutputs,
} from "../../api/sessions.js";
import { Button } from "../../ui/button.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import styles from "./outputs-tab.module.css";

export function OutputsTab({ sessionId }: { sessionId: string }) {
  const outputs = useSessionOutputs(sessionId);

  if (outputs.isError) {
    const err = outputs.error;
    // Idle-only rule (api-reference): explain, don't alarm (DP-6).
    if (err instanceof ConsoleApiError && err.code === "session_not_idle") {
      return (
        <div>
          <p className={styles.note}>
            Outputs are readable only while the session is idle — its sandbox
            is busy right now. Check back once the current turn finishes.
          </p>
          <Button onClick={() => void outputs.refetch()}>Check again</Button>
        </div>
      );
    }
    return (
      <div>
        <ErrorAlert label="outputs" error={err} />
        <Button onClick={() => void outputs.refetch()}>Retry</Button>
      </div>
    );
  }
  if (outputs.isPending) {
    return <p role="status">Loading outputs…</p>;
  }

  if (outputs.data.data.length === 0) {
    return (
      <EmptyState
        title="No output files"
        description="Deliverables the agent writes to /mnt/session/outputs/ inside its sandbox appear here, ready to download."
      />
    );
  }

  return (
    <ul className={styles.list} aria-label="Output files">
      {outputs.data.data.map(({ name }) => (
        <li key={name} className={styles.row}>
          <code className={styles.name}>{name}</code>
          <a
            className={styles.download}
            href={sessionOutputDownloadUrl(sessionId, name)}
            download={name}
          >
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}
