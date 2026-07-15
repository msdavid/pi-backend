/**
 * MCP large-output spill (WP-3.3, spec §11.3).
 *
 * MCP tool outputs are subject to the same 100k-token rule as built-in tools
 * (§11.3): a result exceeding the threshold is written to a sandbox file and
 * replaced in the tool result with a truncated preview + the sandbox path, so a
 * chatty MCP server cannot blow the model context window.
 *
 * This reuses {@link maybeSpillLargeOutput} from the operations layer (WP-1.4)
 * rather than re-implementing the policy — the threshold, char/token estimate,
 * and spill-file convention are identical. The only addition is formatting the
 * spill result into the MCP tool's `{content, details}` shape that
 * `pi.registerTool` expects.
 */

import type { SandboxHandle, SandboxProvider } from "../ports.js";
import {
  maybeSpillLargeOutput,
  type SpillResult,
} from "../session-manager/operations/large-output.js";

/**
 * Apply the 100k-token spill rule to an MCP tool's textual output. Returns the
 * `text` to surface and spill metadata.
 *
 * When no sandbox handle is available (e.g. the session has no remote sandbox),
 * a hard truncation fallback applies — the output is never carried verbatim past
 * the threshold.
 */
export async function maybeSpillMcpOutput(
  output: string,
  ctx?: { provider?: SandboxProvider; handle?: SandboxHandle },
): Promise<SpillResult> {
  if (ctx?.provider && ctx?.handle) {
    return maybeSpillLargeOutput(output, {
      provider: ctx.provider,
      handle: ctx.handle,
    });
  }
  // No sandbox: hard-truncate (never silently exceed the context budget).
  return hardTruncate(output);
}

/** Fallback when no sandbox is wired: truncate to the preview size. */
function hardTruncate(output: string): SpillResult {
  const approxTokens = Math.ceil(output.length / 4);
  // Re-export the threshold from the operations module via dynamic import path
  // is avoided — hardTruncate mirrors the same constants.
  const SPILL_TOKEN_THRESHOLD = 100_000;
  if (approxTokens <= SPILL_TOKEN_THRESHOLD) {
    return { text: output, spilled: false, approxTokens };
  }
  const preview = output.slice(0, 8_000);
  return {
    text:
      preview +
      `\n\n[output truncated at 8000 chars; full output (${approxTokens} ` +
      `tokens) not spilled — no sandbox available]`,
    spilled: false,
    approxTokens,
  };
}
