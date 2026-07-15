/**
 * @pi-managed/client — disconnect/reconnect + offline completion (spec §24.9/§24.10).
 *
 * Owns the SSE stream lifecycle around the per-frame renderer:
 * - On an unexpected stream end (drop), shows "disconnected, reconnecting…"
 *   and re-opens the stream with `Last-Event-ID` so buffered events replay
 *   gap-free (the api-client's `streamSession` handles the replay; this module
 *   provides the outer loop + status UX).
 * - Polling fallback: when SSE is unusable, `streamSession` already falls back
 *   to polling `GET /v1/sessions/:id/events` (api-client §24.10). This module
 *   surfaces that as a status hint.
 * - Offline completion: on startup, fetch the session list and surface sessions
 *   that completed while local Pi was closed as `custom` entries.
 * - Error surfaces: `session.error` / `session.status_terminated` are rendered
 *   and recorded in the completion summary.
 *
 * Decoupled from Pi types: depends only on `ManagedApiClient`, a `PanelUi`
 * slice, a `DelegationRecorder`, and a frame callback. Tests inject a mock
 * `streamSession`.
 */

import type { ManagedApiClient, ParsedSseFrame } from "../api-client.js";
import type { Cursor, Session } from "@pi-managed/contracts";
import type { DelegationRecorder } from "./delegation.js";
import type { DelegationMode } from "./types.js";

/** UI slice the connection manager writes to (structural subset of ctx.ui). */
export interface PanelUi {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const STATUS_KEY = "pi-managed";
export const WIDGET_KEY = "pi-managed:live";

/** A frame handler (the live-view panel's per-event renderer). */
export type FrameHandler = (frame: ParsedSseFrame) => void;

/** Called when the stream ends in a terminal state (idle/terminated/error). */
export type StreamEndHandler = (terminal: {
  status: Session["status"];
  reason: string;
}) => void;

export interface ConnectionOptions {
  apiClient: ManagedApiClient;
  ui: PanelUi;
  recorder: DelegationRecorder;
  sessionId: string;
  mode: DelegationMode;
  /** Max reconnect attempts before giving up (default 5). */
  maxReconnects?: number;
  /** Base backoff ms, doubled per attempt (default 1000). */
  backoffMs?: number;
  /** Cap on backoff (default 30000). */
  maxBackoffMs?: number;
}

/**
 * Drives a session stream with reconnect + reconcile. Used by the live-view
 * panel. Construct, then `run(onFrame)` until the stream reaches a terminal
 * state (resolved) or exhausts reconnects (rejected).
 */
export class ConnectionManager {
  private readonly opts: Required<ConnectionOptions>;
  private lastEventId: number | undefined;
  private stopped = false;

  constructor(opts: ConnectionOptions) {
    this.opts = {
      maxReconnects: 5,
      backoffMs: 1000,
      maxBackoffMs: 30_000,
      ...opts,
    };
  }

  /** Stop the loop and clear panel UI. */
  stop(): void {
    this.stopped = true;
    this.opts.ui.setStatus(STATUS_KEY, undefined);
    this.opts.ui.setWidget(WIDGET_KEY, undefined);
  }

  /**
   * Run the stream until a terminal frame is seen (idle/terminated/error) or
   * reconnects are exhausted. `onFrame` is invoked for every parsed frame.
   */
  async run(onFrame: FrameHandler): Promise<void> {
    const { apiClient, ui, sessionId } = this.opts;
    ui.setStatus(STATUS_KEY, "connecting…");
    let attempts = 0;
    let delay = this.opts.backoffMs;
    while (!this.stopped) {
      try {
        for await (const frame of apiClient.streamSession(sessionId, {
          eventDeltas: ["agent.message"],
          lastEventId: this.lastEventId,
        })) {
          if (this.stopped) return;
          if (frame.id !== undefined) this.lastEventId = frame.id;
          ui.setStatus(STATUS_KEY, "live");
          // A frame arrived → the stream is healthy again. Reset the reconnect
          // budget so a long session survives multiple independent outages
          // (otherwise the counter/backoff accrue across the whole session and
          // a late drop is treated as the Nth failure).
          attempts = 0;
          delay = this.opts.backoffMs;
          onFrame(frame);
          const terminal = classifyTerminal(frame, this.opts.mode);
          if (terminal) {
            this.opts.recorder.appendCompletion(sessionId, {
              status: terminal.status,
              stopReason: terminal.stopReason,
              outputsAvailable: terminal.status === "idle",
              error: terminal.error,
            });
            this.stop();
            return;
          }
        }
        // Generator ended without a terminal frame → drop or clean close.
        if (this.stopped) return;
        // Reconcile: is the session actually done?
        const session = await apiClient.getSession(sessionId);
        if (isTerminalStatus(session.status)) {
          this.opts.recorder.appendCompletion(sessionId, {
            status: session.status,
            stopReason: session.stopReason,
            outputsAvailable: session.status === "idle",
          });
          this.stop();
          return;
        }
        // Still running — treat as a drop.
        attempts += 1;
        if (attempts > this.opts.maxReconnects) {
          ui.notify(
            `Lost connection to remote session ${sessionId} after ${this.opts.maxReconnects} retries.`,
            "error",
          );
          this.stop();
          return;
        }
        ui.setStatus(STATUS_KEY, "disconnected, reconnecting…");
        await sleep(delay);
        delay = Math.min(delay * 2, this.opts.maxBackoffMs);
      } catch (err) {
        if (this.stopped) return;
        attempts += 1;
        if (attempts > this.opts.maxReconnects) {
          ui.notify(
            `Connection to remote session ${sessionId} failed: ${(err as Error).message}`,
            "error",
          );
          this.stop();
          return;
        }
        ui.setStatus(STATUS_KEY, "disconnected, reconnecting…");
        await sleep(delay);
        delay = Math.min(delay * 2, this.opts.maxBackoffMs);
      }
    }
  }

  get lastSeenSeq(): number | undefined {
    return this.lastEventId;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: Session["status"]): boolean {
  return status === "idle" || status === "terminated";
}

/**
 * Classify a frame as terminal for THIS panel's purposes.
 *
 * In **delegate** mode, `session.status_idle` is terminal (the delegation ran
 * to completion). In interactive mode, `idle` means "awaiting input" and is
 * NOT terminal — the user may forward more prompts. Only `terminated` (and
 * `error`-bearing frames) are terminal in interactive mode.
 */
export function classifyTerminal(
  frame: ParsedSseFrame,
  mode: DelegationMode = "delegate",
): {
  status: Session["status"];
  stopReason?: string | null;
  error?: string;
} | null {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  switch (frame.event) {
    case "session.status_idle":
      if (mode !== "interactive") {
        return { status: "idle", stopReason: asString(data.stopReason) };
      }
      return null;
    case "session.status_terminated":
      return {
        status: "terminated",
        stopReason: asString(data.stopReason),
        error: asString(data.retryStatus),
      };
    case "session.error": {
      const msg = data.mcpServerName
        ? `MCP error: ${data.mcpServerName}`
        : "session.error";
      return { status: "terminated", error: msg };
    }
    default:
      return null;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * On startup, find sessions that completed while local Pi was offline and
 * surface them as `custom` entries via the recorder (§24.9).
 *
 * A session counts as "completed while offline" when it is idle/terminated
 * AND has no start marker recorded locally (i.e. we never opened a panel for
 * it — or we did, lost connection, and it finished without us).
 */
export async function surfaceOfflineCompletions(
  apiClient: ManagedApiClient,
  recorder: DelegationRecorder,
): Promise<Session[]> {
  let cursor: string | undefined;
  const surfaced: Session[] = [];
  // Page through recent sessions (newest-first). Cap at a few pages.
  for (let pages = 0; pages < 5; pages += 1) {
    const page: Cursor<Session> = await apiClient.listSessions({
      limit: 50,
      cursor,
    });
    for (const session of page.data) {
      if (!isTerminalStatus(session.status)) continue;
      if (recorder.hasStarted(session.id) && !recorder.hasCompleted(session.id)) {
        // We had a start marker but never recorded completion → finish it now.
        recorder.appendOfflineCompletion(session.id, session);
        surfaced.push(session);
      } else if (!recorder.hasCompleted(session.id)) {
        recorder.appendOfflineCompletion(session.id, session);
        surfaced.push(session);
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return surfaced;
}
