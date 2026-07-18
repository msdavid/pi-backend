/**
 * Usage tab (WP-C1.7; console-spec §9.9 minimal, W2 step 4): the session's
 * cumulative token counters + USD cost from `GET /v1/sessions/:id/usage`.
 * The console never computes money client-side — it displays what the API
 * reports (§11.9).
 */
import { useSessionUsage } from "../../api/sessions.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { formatUsd } from "./format.js";
import styles from "./usage-tab.module.css";

export function UsageTab({ sessionId }: { sessionId: string }) {
  const usage = useSessionUsage(sessionId);

  if (usage.isError) {
    return (
      <div>
        <ErrorAlert label="usage" error={usage.error} />
        <Button onClick={() => void usage.refetch()}>Retry</Button>
      </div>
    );
  }
  if (usage.isPending) {
    return <p role="status">Loading usage…</p>;
  }

  const u = usage.data;
  const rows: Array<[string, string]> = [
    ["Input tokens", String(u.inputTokens)],
    ["Output tokens", String(u.outputTokens)],
    ["Cache creation input tokens", String(u.cacheCreationInputTokens)],
    ["Cache read input tokens", String(u.cacheReadInputTokens)],
    ["USD cost", formatUsd(u.usdCost)],
  ];

  return (
    <dl className={styles.usage}>
      {rows.map(([label, value]) => (
        <div key={label} className={styles.row}>
          <dt className={styles.label}>{label}</dt>
          <dd className={styles.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
