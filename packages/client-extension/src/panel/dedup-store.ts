/**
 * @pi-managed/client — file-backed DelegationRecorder dedup persistence (§24.7, R3.3).
 *
 * Mirrors the `PiAuthStorageAdapter` pattern in auth.ts: a durable adapter for
 * the `DelegationDedupStore` port defined in delegation.ts. The started/completed
 * session-id sets are serialized to JSON next to Pi's `settings.json` (reusing
 * `defaultSettingsPath` from config.ts), so the "exactly 2 entries" invariant and
 * offline-completion dedup survive a Pi restart. All I/O is guarded by try/catch:
 * a missing/corrupt file loads as empty state, and a failed write is swallowed
 * (dedup persistence is best-effort — never block a command on disk).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultSettingsPath } from "../config.js";
import type {
  DelegationDedupState,
  DelegationDedupStore,
} from "./delegation.js";

/** Dedup-state file path for a cwd (`.pi/delegation-dedup.json`, beside settings.json). */
export function defaultDedupPath(cwd?: string): string {
  return `${dirname(defaultSettingsPath(cwd))}/delegation-dedup.json`;
}

/** File-backed dedup store — JSON at `filePath`, empty state on any I/O error. */
export class PiDelegationDedupStore implements DelegationDedupStore {
  constructor(private readonly filePath: string) {}

  load(): DelegationDedupState {
    try {
      if (!existsSync(this.filePath)) return { started: [], completed: [] };
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as
        | Partial<DelegationDedupState>
        | null;
      return {
        started: Array.isArray(raw?.started) ? raw!.started : [],
        completed: Array.isArray(raw?.completed) ? raw!.completed : [],
      };
    } catch {
      return { started: [], completed: [] };
    }
  }

  save(state: DelegationDedupState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch {
      // Best-effort; never block a command on a failed dedup write.
    }
  }
}
