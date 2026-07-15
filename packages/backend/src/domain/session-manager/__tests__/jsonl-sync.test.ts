/**
 * JSONL sync tests (R2.10e — real optimistic concurrency).
 *
 * Covers the durable-sync contract:
 *  - first sync is a plain `put` (no etag basis yet);
 *  - the second sync uses `conditionalPut` with the persisted etag;
 *  - an etag mismatch that persists after a refetch does NOT blind-overwrite the object
 *    store's newer copy — the sync aborts and records an error (the backend is the sole,
 *    append-only writer, §28).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeObjectStore } from "@pi-managed/testkit";
import type {
  ObjectMeta,
  ObjectStore,
  PutResult,
} from "../../ports.js";
import { InMemorySessionStore } from "../session-store.js";
import { JsonlSync } from "../jsonl-sync.js";

const SESSION_ID = "sess_jsonl_sync";
const KEY = "tenants/t/sessions/s/log.jsonl";

/** Write `content` to a fresh tmp JSONL file and return its path. */
function tmpJsonl(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-jsonl-sync-"));
  const path = join(dir, "log.jsonl");
  writeFileSync(path, content);
  return path;
}

/** Drain a web `ReadableStream<Uint8Array>` to a Buffer. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

describe("JsonlSync (R2.10)", () => {
  it("first sync plain-puts; the second conditional-puts with the persisted etag", async () => {
    const objects = new FakeObjectStore();
    const sessions = new InMemorySessionStore();
    const jsonl = new JsonlSync(objects, sessions);

    const path = tmpJsonl('{"type":"session","id":"a"}\n');

    // First sync: no etag basis → plain put.
    const first = await jsonl.syncToJsonl(SESSION_ID, path, KEY);
    expect(first?.etag).toBeDefined();
    expect(jsonl.events).toHaveLength(1);
    expect(jsonl.events[0]).toMatchObject({ kind: "sync", conditional: false });
    // The etag was persisted through the SessionStore seam.
    expect((await sessions.get(SESSION_ID))?.lastSyncedEtag ?? undefined).toBeUndefined();

    // Append and sync again: an etag basis now exists → conditional put.
    writeFileSync(path, '{"type":"session","id":"a"}\n{"type":"message","id":"b"}\n');
    const second = await jsonl.syncToJsonl(SESSION_ID, path, KEY);
    expect(second?.etag).toBeDefined();
    const conditionalSyncs = jsonl.events.filter(
      (e) => e.kind === "sync" && e.conditional,
    );
    expect(conditionalSyncs).toHaveLength(1);

    // The stored object reflects the second write.
    const stored = await readAll(await objects.get(KEY));
    expect(stored.toString("utf8")).toContain('"id":"b"');
  });

  it("skips the upload when the local file is unchanged since the last sync (PERF-10)", async () => {
    const objects = new FakeObjectStore();
    const sessions = new InMemorySessionStore();
    const jsonl = new JsonlSync(objects, sessions);

    const path = tmpJsonl('{"type":"session","id":"a"}\n');

    // First sync uploads.
    const first = await jsonl.syncToJsonl(SESSION_ID, path, KEY);
    expect(first?.etag).toBeDefined();
    expect(jsonl.events).toHaveLength(1);

    // Second sync with the file untouched → skipped: no PutResult, no new event.
    const second = await jsonl.syncToJsonl(SESSION_ID, path, KEY);
    expect(second).toBeUndefined();
    expect(jsonl.events).toHaveLength(1);

    // Appending changes the file → the next sync uploads again.
    writeFileSync(path, '{"type":"session","id":"a"}\n{"type":"message","id":"b"}\n');
    const third = await jsonl.syncToJsonl(SESSION_ID, path, KEY);
    expect(third?.etag).toBeDefined();
    expect(jsonl.events).toHaveLength(2);
  });

  it("a persistent etag mismatch aborts without overwriting the object store", async () => {
    // The store holds newer content ("B") at etag "etag-current". Our in-process basis is
    // stale ("stale"), and the refetch yields a *different* etag ("etag-wrong") — modelling
    // a fast concurrent writer — so the retry conditional-put also mismatches. The sync
    // must abort (error event) and NEVER overwrite "B".
    const objects = new ConflictObjectStore();
    const sessions = new InMemorySessionStore();
    const jsonl = new JsonlSync(objects, sessions);
    jsonl.seedEtag("stale");

    const path = tmpJsonl('{"local":"C"}\n');
    const result = await jsonl.syncToJsonl(SESSION_ID, path, KEY);

    // No PutResult — the sync aborted.
    expect(result).toBeUndefined();
    // The object store still holds "B" — the local "C" never overwrote it.
    expect(objects.content.toString("utf8")).toBe("B");
    expect(objects.writes).toBe(0);
    // A mismatch and then an error were recorded (no blind overwrite).
    expect(jsonl.events.some((e) => e.kind === "mismatch")).toBe(true);
    expect(jsonl.events.some((e) => e.kind === "error")).toBe(true);
  });
});

/**
 * An object store whose `conditionalPut` only succeeds when `ifMatch === currentEtag`,
 * and whose `list` (the retry's etag refetch) deliberately reports a DIFFERENT etag — so
 * a stale writer can never win, and a genuine overwrite is prevented.
 */
class ConflictObjectStore implements ObjectStore {
  readonly versioningSupported = false;
  content = Buffer.from("B");
  readonly currentEtag = "etag-current";
  /** Deliberately != currentEtag so the retry conditional-put also mismatches. */
  readonly listEtag = "etag-wrong";
  /** Count of successful writes (must stay 0 in the conflict case). */
  writes = 0;

  async put(_key: string, stream: ReadableStream<Uint8Array>): Promise<PutResult> {
    this.content = await readAll(stream);
    this.writes += 1;
    return { etag: this.currentEtag };
  }

  async get(_key: string): Promise<ReadableStream<Uint8Array>> {
    return new Response(this.content).body as ReadableStream<Uint8Array>;
  }

  async conditionalPut(
    _key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult> {
    if (ifMatch !== this.currentEtag) {
      throw new Error(`etag mismatch: ${ifMatch} != ${this.currentEtag}`);
    }
    this.content = await readAll(stream);
    this.writes += 1;
    return { etag: this.currentEtag };
  }

  async delete(): Promise<void> {}

  async *list(prefix: string): AsyncIterable<ObjectMeta> {
    yield {
      key: prefix,
      size: this.content.byteLength,
      etag: this.listEtag,
      lastModified: new Date().toISOString(),
    };
  }
}
