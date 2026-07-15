/**
 * @pi-managed/client — interactive vs delegate forwarding rules (spec §24.7 #4).
 *
 * - Interactive mode (`/remote:start`): local prompts typed while the panel is
 *   attached are forwarded to the remote session as `user.message` events.
 * - Delegate mode (`/remote:delegate`): local prompts are NOT forwarded — the
 *   remote agent works toward its task autonomously. The user must
 *   `/remote:attach` and explicitly steer if they want to intervene.
 *
 * Decoupled from Pi types so the rule is unit-testable against a mock client.
 */

import type { ManagedApiClient } from "../api-client.js";
import type { InboundEvent } from "@pi-managed/contracts";
import type { DelegationMode } from "./types.js";

/** Whether local prompts should be forwarded in this mode. */
export function shouldForwardPrompt(mode: DelegationMode): boolean {
  return mode === "interactive";
}

/**
 * Forward a local prompt to the remote session as a `user.message` event.
 * Returns `true` if forwarded, `false` if suppressed (delegate mode).
 * Never throws on suppression — a non-forwarded prompt falls through to the
 * local agent (or is dropped, per the attach context).
 */
export async function forwardPrompt(
  apiClient: ManagedApiClient,
  sessionId: string,
  mode: DelegationMode,
  content: string,
): Promise<boolean> {
  if (!shouldForwardPrompt(mode)) return false;
  if (content.trim() === "") return false;
  const event: InboundEvent = { type: "user.message", content };
  await apiClient.sendEvent(sessionId, event);
  return true;
}
