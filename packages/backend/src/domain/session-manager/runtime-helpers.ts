/**
 * Pure helpers extracted from {@link ManagedSessionRuntime} (runtime.ts) to keep that file
 * focused on the turn-driving orchestration. None of these touch runtime state.
 */

import { existsSync, readFileSync } from "node:fs";
import type { SessionEntry } from "../ports.js";
import type { ResolvedAgentMaterial } from "./types.js";
import type { CustomToolDeclaration } from "../../pi-extensions/custom-tools/index.js";

/** Current time as an ISO-8601 string. */
export function now(): string {
  return new Date().toISOString();
}

/** Drain a web `ReadableStream<Uint8Array>` into a single `Buffer`. */
export async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The client-executed custom-tool declarations for a session (§11.2). `AgentConfig` has
 * no custom-tool wire field yet, so this is empty today — the declaration source is a seam.
 * The relay + coordinator are still loaded (see the runtime's `buildManagedExtensions`) so
 * the `user.custom_tool_result` round-trip is live the moment a declaration exists.
 */
export function customToolDeclarationsFor(
  _material: ResolvedAgentMaterial,
): CustomToolDeclaration[] {
  return [];
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Heuristic: is a `prompt()` rejection transient (retryable) per decisions.md item 7. */
export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/auth|authentication|forbidden|401|403|budget|archived|not found/i.test(msg)) {
    return false; // non-retryable → terminate
  }
  return /timeout|econnreset|enotfound|eai_again|5\d{2}|transient|network|fetch|abort/i.test(
    msg,
  );
}

/** Map a Pi JSONL entry to the port {@link SessionEntry} (positional). */
export function toSessionEntry(
  entry: {
    type: string;
    id: string;
    timestamp: string;
    [k: string]: unknown;
  },
  position: number,
): SessionEntry {
  return {
    position,
    type: entry.type,
    id: entry.id,
    createdAt: entry.timestamp,
    payload: entry,
  };
}

/** Read the local JSONL file as text (used only by the no-SDK test path). */
export function readJsonlText(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}
