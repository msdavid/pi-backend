/**
 * @pi-managed/client — the live-view panel (spec §24.7).
 *
 * Renders remote session activity to the local Pi via the UI sub-protocol:
 * - `ctx.ui.setWidget` — buffered agent text + current tool (display-only).
 * - `ctx.ui.setStatus` — connection/status line.
 *
 * **Display-only:** nothing is appended to the local log per remote event. The
 * ONLY durable footprint is the two `custom` entries managed by the
 * `DelegationRecorder` (start + completion). This keeps the local LLM context
 * clean and the session log small/forkable.
 *
 * The panel is started by `/remote:start` / `/remote:delegate` /
 * `/remote:attach` and stopped on terminal completion or `/remote:detach`.
 */

import type { ManagedApiClient, ParsedSseFrame } from "../api-client.js";
import type {
  ConnectionManager,
  FrameHandler,
  PanelUi,
} from "./connection.js";
import { ConnectionManager as ConnectionManagerImpl } from "./connection.js";
import { STATUS_KEY, WIDGET_KEY } from "./connection.js";
import type { DelegationRecorder } from "./delegation.js";
import type { DelegationMode } from "./types.js";

export interface LiveViewPanelDeps {
  ui: PanelUi;
  recorder: DelegationRecorder;
  sessionId: string;
  mode: DelegationMode;
  /** Max widget text lines (buffered agent text is tail-truncated). */
  maxLines?: number;
}

interface PanelState {
  /** Buffered agent message text (tail of the remote transcript). */
  bufferedText: string;
  /** Live delta preview (in-flight, not yet reconciled). */
  preview: string;
  currentTool: string | undefined;
  thinking: string | undefined;
  lastToolResult: string | undefined;
}

/**
 * The live-view panel. Owns the per-frame rendering that turns remote events
 * into a compact widget. A `ConnectionManager` drives the stream and decides
 * terminal/reconnect; this class just renders frames.
 */
export class LiveViewPanel {
  private readonly deps: Required<LiveViewPanelDeps>;
  private readonly state: PanelState = {
    bufferedText: "",
    preview: "",
    currentTool: undefined,
    thinking: undefined,
    lastToolResult: undefined,
  };

  constructor(deps: LiveViewPanelDeps) {
    this.deps = { maxLines: 12, ...deps };
  }

  /** The frame handler plugged into a `ConnectionManager.run()`. */
  get frameHandler(): FrameHandler {
    return (frame) => this.render(frame);
  }

  render(frame: ParsedSseFrame): void {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    switch (frame.event) {
      case "event_start":
        this.state.preview = "";
        break;
      case "event_delta": {
        const text = asString(data.text) ?? "";
        this.state.preview += text;
        this.redraw("streaming");
        break;
      }
      case "agent.message": {
        const content = asString(data.content) ?? "";
        this.state.preview = "";
        this.state.bufferedText = tail(
          this.state.bufferedText + "\n" + content,
          this.deps.maxLines,
        );
        this.redraw("running");
        break;
      }
      case "agent.thinking": {
        this.state.thinking = asString(data.content);
        this.redraw("thinking");
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        this.state.currentTool = asString(data.tool) ?? frame.event;
        this.redraw("tool");
        break;
      }
      case "agent.tool_result": {
        this.state.lastToolResult = tail(
          asString(data.output) ?? "",
          1,
        );
        this.state.currentTool = undefined;
        this.redraw("running");
        break;
      }
      case "session.status_run_started":
        this.redraw("running");
        break;
      case "session.status_idle":
        this.redraw(this.deps.mode === "interactive" ? "awaiting-input" : "done");
        break;
      case "session.status_terminated":
        this.redraw("terminated");
        break;
      case "session.error": {
        const mcp = asString(data.mcpServerName);
        this.state.lastToolResult = mcp ? `error: ${mcp}` : "session error";
        this.redraw("error");
        break;
      }
      default:
        // Unknown/wildcard session.* / span.* — ignored for display.
        break;
    }
  }

  /** Render the current state to the widget. */
  private redraw(phase: string): void {
    const lines: string[] = [`▸ remote ${this.deps.sessionId} · ${phase}`];
    if (this.state.thinking) {
      lines.push(`  thinking: ${truncate(this.state.thinking, 80)}`);
    }
    if (this.state.currentTool) {
      lines.push(`  tool: ${this.state.currentTool}`);
    }
    if (this.state.lastToolResult) {
      lines.push(`  result: ${truncate(this.state.lastToolResult, 80)}`);
    }
    const text =
      this.state.preview ||
      this.state.bufferedText.split("\n").filter((l) => l !== "").slice(-3).join("\n");
    if (text) {
      for (const line of text.split("\n").slice(-this.deps.maxLines)) {
        lines.push(`  ${truncate(line, 100)}`);
      }
    }
    this.deps.ui.setWidget(WIDGET_KEY, lines);
    this.deps.ui.setStatus(STATUS_KEY, phase);
  }

  /** Clear the widget (called on detach/stop). */
  clear(): void {
    this.deps.ui.setWidget(WIDGET_KEY, undefined);
    this.deps.ui.setStatus(STATUS_KEY, undefined);
  }
}

// --- module-level registry: attach / detach panels across commands ---------

const panels = new Map<string, LiveViewPanel>();

/** Register a live panel (replaces any existing one for the session). */
export function registerPanel(sessionId: string, panel: LiveViewPanel): void {
  panels.set(sessionId, panel);
}

/** Detach (and clear) the live panel for a session, if any. */
export function detachPanel(sessionId: string): LiveViewPanel | undefined {
  const panel = panels.get(sessionId);
  if (panel) {
    panel.clear();
    panels.delete(sessionId);
  }
  return panel;
}

/** Look up the live panel for a session. */
export function getPanel(sessionId: string): LiveViewPanel | undefined {
  return panels.get(sessionId);
}

/** Track active connection managers so a panel can be stopped cleanly. */
const connections = new Map<string, ConnectionManager>();
export function registerConnection(sessionId: string, cm: ConnectionManager): void {
  connections.set(sessionId, cm);
}
export function detachConnection(sessionId: string): ConnectionManager | undefined {
  const cm = connections.get(sessionId);
  if (cm) {
    cm.stop();
    connections.delete(sessionId);
  }
  return cm;
}
export function getConnection(sessionId: string): ConnectionManager | undefined {
  return connections.get(sessionId);
}

/**
 * The interactive session local prompts are forwarded to (interactive mode
 * only). At most one interactive panel is "focused" at a time; detached panels
 * stop receiving forwarded prompts. Delegate panels never set this.
 */
let activeInteractiveSession: string | undefined;

export function setActiveInteractive(sessionId: string | undefined): void {
  activeInteractiveSession = sessionId;
}

export function getActiveInteractive(): string | undefined {
  return activeInteractiveSession;
}

export interface PanelHostDeps {
  apiClient: ManagedApiClient;
  ui: PanelUi;
  recorder: DelegationRecorder;
  sessionId: string;
  mode: DelegationMode;
}

/**
 * Build + register a live-view panel and its connection manager, and start
 * the stream loop (fire-and-forget — the command returns while the panel
 * streams in the background, updating widget/status). Errors surface via
 * `ui.notify` inside `ConnectionManager.run`.
 */
export function startLivePanel(deps: PanelHostDeps): {
  panel: LiveViewPanel;
  connection: ConnectionManager;
} {
  const panel = new LiveViewPanel({
    ui: deps.ui,
    recorder: deps.recorder,
    sessionId: deps.sessionId,
    mode: deps.mode,
  });
  const connection = new ConnectionManagerImpl({
    apiClient: deps.apiClient,
    ui: deps.ui,
    recorder: deps.recorder,
    sessionId: deps.sessionId,
    mode: deps.mode,
  });
  registerPanel(deps.sessionId, panel);
  registerConnection(deps.sessionId, connection);
  if (deps.mode === "interactive") setActiveInteractive(deps.sessionId);
  void connection.run(panel.frameHandler);
  return { panel, connection };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tail(s: string, lines: number): string {
  const arr = s.split("\n");
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}
