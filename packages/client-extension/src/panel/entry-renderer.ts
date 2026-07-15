/**
 * @pi-managed/client — delegation entry renderer (spec §24.7 step 1/3).
 *
 * Registers a `registerEntryRenderer` for `customType: "pi-managed:delegation"`.
 * The renderer is the **visual** layer for the two durable `custom` entries
 * (start marker + completion summary). The durable data itself is persisted by
 * `pi.appendEntry()` via the `DelegationRecorder` and survives forks regardless
 * of rendering.
 *
 * NOTE: rich pi-tui `Component` rendering is intentionally deferred. Building a
 * real `Component` requires a runtime dependency on `@earendil-works/pi-tui`,
 * which is not resolvable from this package (it is nested under the
 * `@earendil-works/pi-coding-agent` install and is not hoisted). Per the
 * "no new runtime deps" rule, the renderer is type-only here and returns
 * `undefined` (Pi renders a default compact form or omits inline rendering).
 * The live view of remote activity is delivered through `ctx.ui.setWidget` /
 * `ctx.ui.setStatus` (see `live-view.ts`), which works in both TUI and RPC
 * modes and needs no pi-tui dependency.
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATION_CUSTOM_TYPE } from "./types.js";
import type { DelegationEntryData } from "./types.js";

/**
 * Compact summary of a delegation marker, for inline rendering once a pi-tui
 * component dependency is available. Exported so tests + future renderers
 * share the exact same formatting.
 */
export function summarizeDelegationEntry(
  data: DelegationEntryData,
): string {
  switch (data.kind) {
    case "start":
      return `▸ remote ${data.mode}: ${data.sessionId} — ${data.task || "(interactive)"}`;
    case "completion":
      return `▾ remote done: ${data.sessionId} — ${data.status}${
        data.error ? ` (${data.error})` : ""
      }${data.outputsAvailable ? " · outputs available" : ""}`;
    case "offline-completion":
      return `▾ remote (offline): ${data.sessionId} — ${data.status} · completed ${data.completedAt}`;
    default: {
      // exhaustiveness guard
      const _exhaustive: never = data;
      void _exhaustive;
      return "";
    }
  }
}

/**
 * The registered entry renderer. Returns `undefined` (no pi-tui Component) — see
 * the module doc for the rationale. The durable entry data is the source of
 * truth; `summarizeDelegationEntry` is the canonical compact text a future
 * pi-tui renderer would display.
 */
export const delegationEntryRenderer: EntryRenderer<DelegationEntryData> = (
  entry,
  _options,
  _theme,
) => {
  void entry;
  return undefined;
};

/** Register the delegation entry renderer with Pi. */
export function registerDelegationRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(DELEGATION_CUSTOM_TYPE, delegationEntryRenderer);
}
