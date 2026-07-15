import type {
  ObjectMeta,
  ObjectStore,
  PutResult,
} from "@pi-managed/backend";

/**
 * In-memory fake `ObjectStore` (spec §28) backed by a `Map`. Supports conditional puts
 * (etag-based) for JSONL sync. No real versioning — `versioningSupported` is configurable.
 */
interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  version?: string;
  lastModified: string;
}

export class FakeObjectStore implements ObjectStore {
  private store = new Map<string, StoredObject>();
  private versionCounter = 0;
  readonly versioningSupported: boolean;

  constructor(opts: { versioningSupported?: boolean } = {}) {
    this.versioningSupported = opts.versioningSupported ?? false;
  }

  async put(
    key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<PutResult> {
    const bytes = await readAll(stream);
    return this.write(key, bytes);
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const obj = this.store.get(key);
    if (!obj) throw new Error(`object not found: ${key}`);
    return new Response(obj.bytes).body as ReadableStream<Uint8Array>;
  }

  async conditionalPut(
    key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult> {
    const existing = this.store.get(key);
    if (existing && existing.etag !== ifMatch) {
      throw new Error(
        `conditional put failed: etag mismatch (${existing.etag} != ${ifMatch})`,
      );
    }
    const bytes = await readAll(stream);
    return this.write(key, bytes);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // No real version history in the fake — a Map delete removes the sole entry,
  // so hard delete is identical to delete.
  async hardDelete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async head(key: string): Promise<ObjectMeta | null> {
    const obj = this.store.get(key);
    if (!obj) return null;
    return {
      key,
      size: obj.bytes.byteLength,
      etag: obj.etag,
      version: obj.version,
      lastModified: obj.lastModified,
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectMeta> {
    for (const [key, obj] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        yield {
          key,
          size: obj.bytes.byteLength,
          etag: obj.etag,
          version: obj.version,
          lastModified: obj.lastModified,
        };
      }
    }
  }

  private write(key: string, bytes: Uint8Array): PutResult {
    const etag = `"${hash(bytes)}"`;
    let version: string | undefined;
    if (this.versioningSupported) {
      this.versionCounter += 1;
      version = String(this.versionCounter);
    }
    this.store.set(key, {
      bytes,
      etag,
      version,
      lastModified: new Date().toISOString(),
    });
    return { etag, version };
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** A tiny non-cryptographic hash for fake etags. */
function hash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
