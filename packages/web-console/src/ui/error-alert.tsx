/**
 * DP-9 failure line (console-spec §6.4): every query error renders the human
 * message plus the machine facts — `code` and `requestId` via `errorSummary`
 * — and a "docs" link into the api-reference "Error envelope" section, so
 * the reader can act on the code without asking. One component so every
 * feature screen renders failures identically.
 */
import { errorDocsUrl, errorSummary } from "../lib/errors.js";
import styles from "./error-alert.module.css";

export function ErrorAlert({
  label,
  error,
}: {
  /** What failed to load, e.g. "sessions" → "Failed to load sessions: …". */
  label: string;
  error: unknown;
}) {
  return (
    <p role="alert" className={styles.error}>
      Failed to load {label}: {errorSummary(error)}{" "}
      <a
        className={styles.docs}
        href={errorDocsUrl()}
        target="_blank"
        rel="noreferrer"
      >
        docs
      </a>
    </p>
  );
}
