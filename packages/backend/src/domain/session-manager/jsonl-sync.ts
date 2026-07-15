/**
 * JSONL durability (§5.1, §28).
 *
 * Pi's `SessionManager` writes JSONL to local disk; the backend syncs the local file
 * to the {@link ObjectStore} on every `session.status_idle` transition + a periodic
 * interval while running (default 30s, decisions.md / docs/decisions.md item context).
 *
 * Sync uses `objectStore.conditionalPut(key, stream, ifMatch)` (§28): the first sync
 * establishes the object via `put` (capturing the etag); subsequent syncs use
 * `conditionalPut` with the last-known etag so a concurrent update never silently
 * overwrites. On an etag mismatch (concurrent writer), the sync re-reads the object's
 * etag and retries once.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ObjectStore, PutResult, SessionId } from "../ports.js";
import type { SessionStore } from "./types.js";

/** Default periodic sync interval while running (ms). */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

/** Recorded sync events for assertions. */
export type JsonlSyncEvent =
  | { kind: "sync"; sessionId: SessionId; etag?: string; conditional: boolean }
  | { kind: "mismatch"; sessionId: SessionId }
  | { kind: "error"; sessionId: SessionId; message: string };

/**
 * JSONL sync coordinator. Owns the per-session last-known etag and the periodic timer.
 */
export class JsonlSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEtag: string | undefined;
  /** Signature (size + mtime) of the local file at the last successful sync (PERF-10). */
  private lastSynced: { size: number; mtimeMs: number } | undefined;
  readonly events: JsonlSyncEvent[] = [];

  constructor(
    private readonly objects: ObjectStore,
    private readonly sessionStore: SessionStore,
  ) {}

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Seed the last-known etag (e.g. from the session record on `wake`). */
  seedEtag(etag?: string): void {
    if (etag) this.lastEtag = etag;
  }

  /** Begin periodic sync while running. */
  startPeriodic(
    sessionId: SessionId,
    localJsonlPath: string,
    objectStoreKey: string,
    intervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
  ): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.syncToJsonl(sessionId, localJsonlPath, objectStoreKey).catch(
        () => {
          /* errors recorded on the event log; periodic timer keeps running */
        },
      );
    }, intervalMs);
  }

  /** Stop the periodic timer (runtime teardown). */
  stopPeriodic(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Sync the local JSONL file to the object store. First sync uses `put`; subsequent
   * syncs use `conditionalPut` with the last-known etag (§28). Persists the new etag
   * via the `SessionStore`.
   */
  async syncToJsonl(
    sessionId: SessionId,
    localJsonlPath: string,
    objectStoreKey: string,
  ): Promise<PutResult | undefined> {
    // PERF-10: skip the upload when the local file is byte-for-byte what we last synced. Pi
    // only ever APPENDS to the JSONL, so any new content bumps the size (and mtime); an
    // unchanged signature means the object store already holds these exact bytes and a
    // re-upload would just re-read + re-hash + re-PUT the same data every interval.
    const st = await stat(localJsonlPath).catch(() => undefined);
    if (
      st &&
      this.lastSynced &&
      st.size === this.lastSynced.size &&
      st.mtimeMs === this.lastSynced.mtimeMs
    ) {
      return undefined;
    }
    const stream = fileStream(localJsonlPath);
    let result: PutResult;
    try {
      if (this.lastEtag === undefined) {
        result = await this.objects.put(objectStoreKey, stream);
        this.events.push({
          kind: "sync",
          sessionId,
          etag: result.etag,
          conditional: false,
        });
      } else {
        result = await this.retryConditional(sessionId, objectStoreKey, localJsonlPath);
      }
    } catch (err) {
      this.events.push({ kind: "error", sessionId, message: toMessage(err) });
      return undefined;
    }
    if (result.etag) {
      this.lastEtag = result.etag;
      await this.sessionStore.saveSyncedEtag(sessionId, result.etag);
    }
    // Record the synced file signature so an unchanged file is skipped next pass (PERF-10).
    if (st) this.lastSynced = { size: st.size, mtimeMs: st.mtimeMs };
    return result;
  }

  /**
   * Conditional put with real optimistic concurrency (§28, R2.10e).
   *
   * The backend is the SOLE, append-only writer of this key. A mismatch therefore means
   * our in-process `lastEtag` was stale, not that a competing writer diverged the object.
   * On mismatch we re-fetch the CURRENT etag and retry the conditional put ONCE with that
   * fresh basis. If it STILL mismatches (a genuine concurrent writer slipped in between
   * the fetch and the put — which must not happen for a single-writer key), we ABORT and
   * surface an error rather than blind-overwriting the object store's newer copy. The old
   * code re-fetched-then-put unconditionally, which was an overwrite in disguise.
   */
  private async retryConditional(
    sessionId: SessionId,
    objectStoreKey: string,
    localJsonlPath: string,
  ): Promise<PutResult> {
    try {
      const result = await this.objects.conditionalPut(
        objectStoreKey,
        fileStream(localJsonlPath),
        this.lastEtag!,
      );
      this.events.push({ kind: "sync", sessionId, etag: result.etag, conditional: true });
      return result;
    } catch (err) {
      if (!isEtagMismatch(err)) throw err;
      this.events.push({ kind: "mismatch", sessionId });
    }

    // Re-establish the current etag as the retry basis. If we cannot resolve it, abort —
    // never fall back to an unconditional put (that would clobber a newer object).
    const fresh = await this.fetchCurrentEtag(objectStoreKey);
    if (fresh === undefined) {
      throw new Error(
        `jsonl-sync: cannot resolve current etag for ${objectStoreKey} — ` +
          `aborting to avoid a blind overwrite`,
      );
    }
    this.lastEtag = fresh;
    try {
      const result = await this.objects.conditionalPut(
        objectStoreKey,
        fileStream(localJsonlPath),
        fresh,
      );
      this.events.push({ kind: "sync", sessionId, etag: result.etag, conditional: true });
      return result;
    } catch (err) {
      if (!isEtagMismatch(err)) throw err;
      // Still mismatched after a fresh fetch → a genuine concurrent writer exists (should
      // never happen for this single-writer, append-only key). Abort — do NOT overwrite.
      throw new Error(
        `jsonl-sync: etag still mismatched for ${objectStoreKey} after refetch — ` +
          `aborting to avoid a blind overwrite (backend is the sole writer)`,
      );
    }
  }

  /** Best-effort etag lookup for retry basis (falls back to undefined → plain put). */
  private async fetchCurrentEtag(key: string): Promise<string | undefined> {
    try {
      // `list` returns ObjectMeta with etag; take the first (keys are unique).
      for await (const meta of this.objects.list(key)) {
        return meta.etag;
      }
    } catch {
      /* ignore — next sync will plain-put if undefined */
    }
    return undefined;
  }
}

/** Read a local file as a `ReadableStream<Uint8Array>` (Web stream). */
function fileStream(path: string): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(path);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

function isEtagMismatch(err: unknown): boolean {
  const msg = toMessage(err);
  return /mismatch|precondition|412|etag/i.test(msg);
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
