/**
 * @pi-managed/client — live-view panel shared types (spec §24.7).
 *
 * The panel's durable footprint is exactly TWO `custom` entries per delegation
 * (a start marker + a completion summary), persisted via `pi.appendEntry()`
 * under `DELEGATION_CUSTOM_TYPE`. All other live state is ephemeral, surfaced
 * through `ctx.ui.setWidget` / `ctx.ui.setStatus` — NEVER appended per remote
 * event, so the local session log stays compact and the LLM context clean.
 */

import type { SessionStatus, Usage } from "@pi-managed/contracts";

/** `customType` for delegation start/completion markers. */
export const DELEGATION_CUSTOM_TYPE = "pi-managed:delegation";

/** How the local Pi treats local prompts while a panel is attached. */
export type DelegationMode = "interactive" | "delegate";

/** Durable start-marker data — the FIRST custom entry of a delegation. */
export interface DelegationStartData {
  kind: "start";
  sessionId: string;
  /** The task (for delegate) or a label (for interactive). May be empty. */
  task: string;
  startedAt: string;
  mode: DelegationMode;
}

/** Durable completion-summary data — the SECOND custom entry of a delegation. */
export interface DelegationCompletionData {
  kind: "completion";
  sessionId: string;
  status: SessionStatus;
  stopReason?: string | null;
  usage?: Usage;
  outputsAvailable: boolean;
  completedAt: string;
  /** Present when the session ended in error / terminated. */
  error?: string;
}

/**
 * Offline-completion marker — a session that completed while local Pi was
 * closed (§24.9). These have no local start marker (Pi was offline), so they
 * surface as a single completion entry on next startup.
 */
export interface OfflineCompletionData {
  kind: "offline-completion";
  sessionId: string;
  status: SessionStatus;
  outputsAvailable: boolean;
  completedAt: string;
}

export type DelegationEntryData =
  | DelegationStartData
  | DelegationCompletionData
  | OfflineCompletionData;

/** A no-op appendEntry stub (used when Pi is unavailable / in tests). */
export type AppendEntryFn = <T = unknown>(customType: string, data?: T) => void;
