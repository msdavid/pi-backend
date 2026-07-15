/**
 * Vault re-resolution loop (WP-2.4, §12.5).
 *
 * A periodic loop that calls {@link SecretStore.revalidate} for each running
 * session's context. This is how rotation/archival/deletion (and mcp_oauth
 * token refresh) propagate to running sessions WITHOUT a restart (§12.5):
 *
 * - `resolveBindingsForSession` already reads the live `vault_credentials` rows,
 *   so archive/delete of a credential is reflected on the next binding
 *   resolution. `revalidate` refreshes expired mcp_oauth access tokens in place
 *   (updating `secret_enc`) so the MCP proxy continues to inject a live token.
 *
 * The loop is fully injectable: the session-context provider (which running
 * sessions to revalidate) and the tick interval are parameters, so tests drive
 * it deterministically. Production wiring passes the SessionManager's active
 * session set (see the wiring note in the WP report — `app.ts` is outside this
 * WP's owned paths, so the loop is started from `server.ts` when a provider is
 * supplied; the composition root threads the real provider through).
 *
 * The loop is bounded: a single tick never runs concurrently (an in-flight tick
 * is skipped if the next interval fires), and per-session errors are isolated so
 * one failing session cannot starve the others.
 */

import type { Logger } from "pino";
import type { SecretStore, SessionContext } from "../ports.js";

/** A function returning the session contexts to revalidate this tick. */
export type SessionContextsProvider = () => Promise<SessionContext[]> | SessionContext[];

/** Options for {@link startRevalidationLoop}. */
export interface RevalidationLoopOptions {
  secretStore: SecretStore;
  /** Returns the running sessions to revalidate each tick. */
  sessionContextsProvider: SessionContextsProvider;
  /** Tick interval in milliseconds. */
  intervalMs: number;
  logger: Logger;
  /** Optional AbortSignal; the loop stops when aborted. */
  signal?: AbortSignal;
}

/** A handle to stop a running re-resolution loop. */
export interface RevalidationLoopHandle {
  /** Stop the loop and clear its timer. Idempotent. */
  stop(): void;
  /** True while the loop's timer is active. */
  readonly running: boolean;
}

/**
 * Start the periodic re-resolution loop. Returns a handle whose `stop()` clears
 * the timer. A tick already in flight is not interrupted; `stop()` prevents
 * further ticks. Errors in `sessionContextsProvider` or per-session `revalidate`
 * calls are caught and logged — the loop keeps running.
 */
export function startRevalidationLoop(
  opts: RevalidationLoopOptions,
): RevalidationLoopHandle {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const contexts = await opts.sessionContextsProvider();
      for (const ctx of contexts) {
        try {
          await opts.secretStore.revalidate(ctx);
        } catch (err) {
          opts.logger.warn(
            { sessionId: ctx.sessionId, err: (err as Error).message },
            "vault revalidation failed for session",
          );
        }
      }
    } catch (err) {
      opts.logger.warn(
        { err: (err as Error).message },
        "vault revalidation tick failed",
      );
    } finally {
      inFlight = false;
    }
  };

  // Respect an external abort signal.
  if (opts.signal) {
    if (opts.signal.aborted) {
      stopped = true;
    } else {
      opts.signal.addEventListener("abort", () => handle.stop(), { once: true });
    }
  }

  if (!stopped) {
    timer = setInterval(() => {
      void tick().catch(() => {
        /* swallow — errors already logged inside tick() */
      });
    }, opts.intervalMs);
    // Don't keep the event loop alive solely for the re-resolution loop.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }

  const handle: RevalidationLoopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    get running(): boolean {
      return !stopped && timer !== undefined;
    },
  };
  return handle;
}
