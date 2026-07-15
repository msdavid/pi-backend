/**
 * Filesystem-backed {@link ObjectStore} (§28) — the v1 default (§7.3, §3.2).
 *
 * Keys map to `<root>/<key>` paths using the layout in `docs/db-schema.md` §6
 * (forward-slash-separated, e.g. `tenants/<t>/sessions/<s>/log.jsonl`). Parent
 * directories are created on write. Streaming get/put via `node:fs` +
 * `node:stream`. ETag = quoted sha256 hex of the object content.
 *
 * No object versioning: `versioningSupported` is `false` (§28 backup note — fs is
 * the local-only v1 store; S3 provides versioning for SaaS).
 *
 * Design notes:
 * - `list` omits `etag` (an optional `ObjectMeta` field). Computing it would require
 *   reading every file's full content on each listing — prohibitively expensive for
 *   large stores. ETags remain available via `put`/`conditionalPut` results and are
 *   recomputed on demand for `conditionalPut` precondition checks.
 * - `conditionalPut` re-reads the existing object to compute its etag; correct but
 *   O(size) per conditional write. Acceptable for v1 JSONL-sync cadence (§28).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, join, relative, sep } from "node:path";
import type {
  ObjectMeta,
  ObjectStore,
  PutResult,
} from "../../domain/ports.js";

/** Options for {@link FilesystemObjectStore}. */
export interface FilesystemObjectStoreOptions {
  /** Absolute or relative root directory. Created lazily on first write. */
  root: string;
}

/** Result shape returned by {@link FilesystemObjectStore.probe}. */
export interface ObjectStoreProbeResult {
  status: "up" | "down";
  detail?: string;
}

/**
 * Local-filesystem {@link ObjectStore}. Constructed without I/O; the root is
 * created lazily on the first write (parent dirs of each object are `mkdir -p`'d).
 */
export class FilesystemObjectStore implements ObjectStore {
  readonly versioningSupported = false;
  readonly root: string;

  constructor(opts: FilesystemObjectStoreOptions) {
    this.root = opts.root;
  }

  async put(key: string, stream: ReadableStream<Uint8Array>): Promise<PutResult> {
    assertSafeKey(key);
    const filePath = this.resolve(key);
    await mkdir(dirname(filePath), { recursive: true });
    const etag = await this.writeStream(filePath, stream);
    return { etag };
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    assertSafeKey(key);
    const filePath = this.resolve(key);
    try {
      await access(filePath);
    } catch {
      throw new Error(`object not found: ${key}`);
    }
    return Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  }

  async conditionalPut(
    key: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<PutResult> {
    assertSafeKey(key);
    const filePath = this.resolve(key);
    const existing = await computeEtag(filePath);
    if (existing !== undefined && existing !== ifMatch) {
      throw new Error(
        `conditional put failed: etag mismatch (${existing} != ${ifMatch})`,
      );
    }
    // Object missing or etag matches → write.
    await mkdir(dirname(filePath), { recursive: true });
    const etag = await this.writeStream(filePath, stream);
    return { etag };
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  /**
   * The filesystem store has no object versioning (`versioningSupported` is
   * `false`), so a real `unlink` already leaves nothing recoverable — hard delete
   * is identical to {@link delete}.
   */
  async hardDelete(key: string): Promise<void> {
    await this.delete(key);
  }

  async head(key: string): Promise<ObjectMeta | null> {
    assertSafeKey(key);
    const filePath = this.resolve(key);
    let st;
    try {
      st = await stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // Single-object etag: reading one file's content is O(size) — the whole point
    // of `head` is to recover an etag without a full-store `list` walk.
    const etag = await computeEtag(filePath);
    return {
      key,
      size: st.size,
      ...(etag ? { etag } : {}),
      lastModified: st.mtime.toISOString(),
    };
  }

  async *list(prefix: string): AsyncIterable<ObjectMeta> {
    // Start the walk at the prefix's directory rather than the store root, so a
    // prefixed listing is O(objects under prefix) instead of O(total objects).
    // Keys remain root-relative (walk's `root` arg is unchanged), so the
    // `startsWith(prefix)` filter still handles a partial final path segment.
    const lastSlash = prefix.lastIndexOf("/");
    const dirPrefix = lastSlash === -1 ? "" : prefix.slice(0, lastSlash);
    const startDir = dirPrefix
      ? join(this.root, ...dirPrefix.split("/"))
      : this.root;
    yield* walk(this.root, startDir, prefix);
  }

  /** Readiness probe: is the root directory accessible? Non-mutating. */
  async probe(): Promise<ObjectStoreProbeResult> {
    try {
      await access(this.root);
      return { status: "up" };
    } catch {
      return {
        status: "down",
        detail: `object store root not accessible: ${this.root}`,
      };
    }
  }

  resolve(key: string): string {
    return join(this.root, ...key.split("/"));
  }

  /**
   * Stream `stream` to `filePath`, hashing content as it passes. Returns the quoted
   * sha256 etag. Uses a file handle + chunk loop (no intermediate buffering).
   */
  private async writeStream(
    filePath: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const hash = createHash("sha256");
    const handle = await open(filePath, "w");
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          hash.update(value);
          await handle.write(value);
        }
      }
    } finally {
      reader.releaseLock();
      await handle.close();
    }
    return `"${hash.digest("hex")}"`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject keys that could escape the root: absolute paths, backslashes, or `..` / `.`
 * path segments. Keys use forward slashes per `docs/db-schema.md` §6.
 */
function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error("object store key must not be empty");
  if (key.startsWith("/")) throw new Error(`absolute key not allowed: ${key}`);
  if (key.includes("\\")) throw new Error(`backslash in key not allowed: ${key}`);
  const parts = key.split("/");
  if (parts.some((p) => p === ".." || p === ".")) {
    throw new Error(`invalid path segment in key: ${key}`);
  }
}

/** Compute the quoted-sha256 etag of an existing file, or `undefined` if absent. */
async function computeEtag(filePath: string): Promise<string | undefined> {
  try {
    const handle = await open(filePath, "r");
    const hash = createHash("sha256");
    try {
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return `"${hash.digest("hex")}"`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Recursive directory walk yielding `ObjectMeta` for files whose key matches `prefix`. */
async function* walk(
  root: string,
  dir: string,
  prefix: string,
): AsyncIterable<ObjectMeta> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing dir → empty listing
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(root, full, prefix);
    } else if (ent.isFile()) {
      const rel = relative(root, full).split(sep).join("/");
      if (rel.startsWith(prefix)) {
        const st = await stat(full);
        yield {
          key: rel,
          size: st.size,
          lastModified: st.mtime.toISOString(),
        };
      }
    }
  }
}
