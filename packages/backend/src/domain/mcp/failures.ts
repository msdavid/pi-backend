/**
 * MCP failure handling (WP-3.3, spec §19.6).
 *
 * Session creation does **not** validate MCP connectivity (§19.6). A server that
 * is unreachable or rejects its credential is reported at runtime via a
 * `session.error` event carrying `mcpServerName` + `retryStatus`, and the failure
 * is retried on the next `idle` → `running` transition.
 *
 * This module provides:
 *
 * - {@link McpRetryStatus} — the two retry-status enum values (§19.6).
 * - {@link classifyMcpFailure} — map a thrown error to a retry status.
 * - {@link McpFailureSink} — the sink the bridge calls to emit `session.error`.
 * - {@link McpFailureTracker} — records failed servers so the next idle→running
 *   transition retries them (rather than re-failing on every tool call).
 */



/** §19.6 retry-status values carried on `session.error`. */
export type McpRetryStatus =
  | "mcp_connection_failed_error"
  | "mcp_authentication_failed_error";

/** A sink the bridge calls when an MCP server fails. Implemented by the event-stream. */
export interface McpFailureSink {
  /** Emit a `session.error` for the given server + retry status (§19.6). */
  emitMcpFailure(mcpServerName: string, retryStatus: McpRetryStatus): Promise<void>;
}

/**
 * Classify a thrown error from the MCP client into a §19.6 retry status.
 *
 * - {@link McpAuthError} (HTTP 401/403) → `mcp_authentication_failed_error`.
 * - {@link McpTransportError} / network errors → `mcp_connection_failed_error`.
 * - Unknown errors default to `mcp_connection_failed_error` (the safe default —
 *   the server may be transiently down).
 */
export function classifyMcpFailure(err: unknown): McpRetryStatus {
  if (err !== null && typeof err === "object" && err instanceof Error) {
    if (err.name === "McpAuthError") return "mcp_authentication_failed_error";
  }
  return "mcp_connection_failed_error";
}

/**
 * Records MCP servers that failed during a run, so the next `idle` → `running`
 * transition retries them (§19.6). The tracker is per-session; the session
 * manager (idle policy) calls {@link drainPendingRetries} when transitioning
 * idle→running to get the set of servers to re-attempt.
 *
 * A server that fails is added once; repeated failures during the same run do
 * not duplicate the entry (the first failure already emitted the event). A
 * server that succeeds on retry is cleared.
 */
export class McpFailureTracker {
  private readonly failed = new Map<string, McpRetryStatus>();

  /** Record (or refresh) a failure for a server. Returns `true` if newly added. */
  record(mcpServerName: string, retryStatus: McpRetryStatus): boolean {
    const isNew = !this.failed.has(mcpServerName);
    this.failed.set(mcpServerName, retryStatus);
    return isNew;
  }

  /** Clear a server's failure (it succeeded on retry). */
  clear(mcpServerName: string): void {
    this.failed.delete(mcpServerName);
  }

  /** Is the server currently marked failed? */
  has(mcpServerName: string): boolean {
    return this.failed.has(mcpServerName);
  }

  /**
   * Drain the pending retry set — called on idle→running. Returns the servers to
   * re-attempt and clears the tracker (a fresh run re-records any that fail
   * again). The bridge uses this to know which servers to re-connect.
   */
  drainPendingRetries(): ReadonlyMap<string, McpRetryStatus> {
    const snapshot = new Map(this.failed);
    this.failed.clear();
    return snapshot;
  }

  /** Number of servers currently marked failed. */
  get size(): number {
    return this.failed.size;
  }
}
