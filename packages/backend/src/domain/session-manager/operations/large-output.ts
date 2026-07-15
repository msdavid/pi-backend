/**
 * Large-output spill policy (WP-1.4, spec §11.3).
 *
 * Tool results that would exceed the model context budget are **spilled** to a file
 * inside the sandbox (`/tmp/tool-output-<id>.txt`) and replaced in the tool result
 * with a truncated preview + the sandbox file path. The agent can then re-read
 * slices of the spilled file via the `read` tool instead of carrying the full output
 * in the transcript.
 *
 * Threshold: **100k tokens** (≈400k chars at ~4 chars/token). This is distinct from
 * Pi's built-in 50KB/2000-line per-tool truncation (which guards a single tool's
 * display); the spill policy guards against pathological outputs that would still
 * blow the context window after Pi's truncation (e.g. a bash command dumping a large
 * file). The spill file lives in the VM so no host filesystem effect occurs (§10.2).
 */

import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxProvider } from "../../ports.js";
import { sq } from "./remote-operations.js";

/** Rough chars-per-token estimate for budgeting (spec §11.3). */
const CHARS_PER_TOKEN = 4;
/** Spill threshold (spec §11.3: ">100k tokens"). */
export const SPILL_TOKEN_THRESHOLD = 100_000;
/** Chars at which output is spilled (= SPILL_TOKEN_THRESHOLD * CHARS_PER_TOKEN). */
export const SPILL_CHAR_THRESHOLD = SPILL_TOKEN_THRESHOLD * CHARS_PER_TOKEN;
/** Preview size kept in the tool result after a spill (chars). */
const SPILL_PREVIEW_CHARS = 8_000;
/** Sandbox directory for spilled outputs. */
const SPILL_DIR = "/tmp";

/** Outcome of {@link maybeSpillLargeOutput}. */
export interface SpillResult {
  /** The text to place in the tool result (preview + notice, or the original). */
  text: string;
  /** Whether the output was spilled to a file. */
  spilled: boolean;
  /** Sandbox path of the spill file when `spilled`. */
  path?: string;
  /** Approximate token count of the original output. */
  approxTokens: number;
}

/**
 * If `output` exceeds the spill threshold, write it to a sandbox file and return a
 * truncated preview + the file path. Otherwise return `output` unchanged.
 *
 * The spill write goes through `provider.exec` (a heredoc/base64 write) so the full
 * output lands in the VM, not the backend host.
 */
export async function maybeSpillLargeOutput(
  output: string,
  ctx: { provider: SandboxProvider; handle: SandboxHandle },
): Promise<SpillResult> {
  const approxTokens = Math.ceil(output.length / CHARS_PER_TOKEN);
  if (approxTokens <= SPILL_TOKEN_THRESHOLD) {
    return { text: output, spilled: false, approxTokens };
  }
  const id = randomUUID();
  const path = `${SPILL_DIR}/tool-output-${id}.txt`;
  // base64-encode to write verbatim (no shell-escaping risk for large content).
  const b64 = Buffer.from(output, "utf8").toString("base64");
  const r = await ctx.provider.exec(ctx.handle, {
    cmd: `printf %s ${sq(b64)} | base64 -d > ${sq(path)}`,
  });
  if (r.exitCode !== 0) {
    // Spill failed: fall back to a hard truncation so the result still fits, and note
    // the failure (never silently drop output).
    return {
      text:
        output.slice(0, SPILL_PREVIEW_CHARS) +
        `\n\n[output truncated: ${approxTokens} tokens; spill to ${path} failed (exit ${r.exitCode})]`,
      spilled: false,
      approxTokens,
    };
  }
  const preview = output.slice(0, SPILL_PREVIEW_CHARS);
  return {
    text:
      preview +
      `\n\n[output truncated at ${SPILL_PREVIEW_CHARS} chars; full output ` +
      `(${approxTokens} tokens) written to sandbox file: ${path}]`,
    spilled: true,
    path,
    approxTokens,
  };
}
