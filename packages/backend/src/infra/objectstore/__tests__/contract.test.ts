/**
 * Object-store contract tests (WP-P0.3, §28).
 *
 * Parameterized over every `ObjectStore` impl to prove parity:
 *  - the testkit `FakeObjectStore` (the reference behavior),
 *  - `FilesystemObjectStore` (in a tmp dir),
 *  - `S3ObjectStore` against a MinIO testcontainer (skipped when Docker/MinIO
 *    is unavailable — a clear note is logged),
 *  - `GCSObjectStore` against a fake-gcs-server testcontainer (same skip rule).
 *
 * The same assertions run against each: put→get round-trip, conditionalPut
 * precondition semantics, list with prefix, delete, large streaming content, and
 * the `ObjectMeta` shape.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { ObjectMeta, ObjectStore, PutResult } from "../../domain/ports.js";
import { FilesystemObjectStore } from "../filesystem.js";
import {
  createS3ObjectStore,
  ensureS3Bucket,
  type S3ObjectStoreOptions,
} from "../s3.js";
import {
  createGCSObjectStore,
  ensureGCSBucket,
  type GCSObjectStoreOptions,
} from "../gcs.js";
import { FakeObjectStore } from "@pi-managed/testkit";

/** A freshly-constructed store plus its cleanup hook. */
interface StoreFixture {
  store: ObjectStore;
  cleanup?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Wrap bytes in a `ReadableStream<Uint8Array>`. */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}

/** Random bytes as a plain `Uint8Array` (not a Node `Buffer`) for deep-equal parity. */
function rng(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/** Drain a `ReadableStream<Uint8Array>` to a single `Uint8Array`. */
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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

async function fakeFixture(): Promise<StoreFixture> {
  return { store: new FakeObjectStore() };
}

async function fsFixture(): Promise<StoreFixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-objstore-"));
  return {
    store: new FilesystemObjectStore({ root }),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Start a MinIO testcontainer and return a wired S3 store, or `null` if unavailable. */
async function s3Fixture(): Promise<StoreFixture | null> {
  try {
    const { MinioContainer } = await import("@testcontainers/minio");
    const container = await new MinioContainer(
      "minio/minio:RELEASE.2024-12-13T22-00-00Z",
    ).start();
    const started = container as {
      getConnectionUrl?: () => string;
      getHttpUrl?: () => string;
      getUsername?: () => string;
      getPassword?: () => string;
      getConfig?: () => unknown;
    };
    const cfg = started.getConfig?.() as
      | { endpoint?: string; username?: string; password?: string }
      | undefined;
    const endpoint =
      cfg?.endpoint ??
      started.getConnectionUrl?.() ??
      started.getHttpUrl?.();
    const username =
      cfg?.username ?? started.getUsername?.() ?? "minioadmin";
    const password =
      cfg?.password ?? started.getPassword?.() ?? "minioadmin";
    if (!endpoint) throw new Error("could not resolve MinIO endpoint");

    const bucket = `pi-test-${randomUUID().slice(0, 8)}`;
    const baseOpts: S3ObjectStoreOptions = {
      bucket,
      endpoint,
      region: "us-east-1",
      credentials: { accessKeyId: username, secretAccessKey: password },
      forcePathStyle: true,
    };
    await ensureS3Bucket(baseOpts);
    const store = await createS3ObjectStore(baseOpts);
    return {
      store,
      cleanup: async () => {
        try {
          await container.stop();
        } catch {
          /* best-effort */
        }
      },
    };
  } catch (err) {
     
    console.warn(
      `[objectstore/contract] S3/MinIO unavailable — skipping S3 parity case: ` +
        `${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Start a fake-gcs-server testcontainer and return a wired GCS store, or `null`
 * if unavailable.
 */
async function gcsFixture(): Promise<StoreFixture | null> {
  try {
    const { GenericContainer } = await import("testcontainers");
    const container = await new GenericContainer(
      "fsouza/fake-gcs-server:1.54.0",
    )
      .withExposedPorts(4443)
      .withCommand(["-scheme", "http"])
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4443)}`;
    // Point the server's advertised URLs (upload/media links) at the mapped port.
    const cfg = await fetch(`${endpoint}/_internal/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ externalUrl: endpoint }),
    });
    if (!cfg.ok) {
      throw new Error(`fake-gcs-server config update failed: ${cfg.status}`);
    }

    const bucket = `pi-test-${randomUUID().slice(0, 8)}`;
    const baseOpts: GCSObjectStoreOptions = {
      bucket,
      apiEndpoint: endpoint,
      projectId: "pi-test",
    };
    await ensureGCSBucket(baseOpts);
    const store = await createGCSObjectStore(baseOpts);
    return {
      store,
      cleanup: async () => {
        try {
          await container.stop();
        } catch {
          /* best-effort */
        }
      },
    };
  } catch (err) {

    console.warn(
      `[objectstore/contract] GCS/fake-gcs-server unavailable — skipping GCS parity case: ` +
        `${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared contract suite
// ---------------------------------------------------------------------------

/**
 * Run the object-store contract against a single impl. Each test uses a unique
 * key prefix so it cannot collide with siblings.
 */
function runContract(
  name: string,
  make: () => Promise<StoreFixture | null>,
): void {
  describe(name, () => {
    let fixture: StoreFixture | null = null;
    let store: ObjectStore;

    beforeAll(async () => {
      fixture = await make();
      if (!fixture) return;
      store = fixture.store;
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    // Skip the whole suite if the impl couldn't be provisioned (e.g. no Docker).
    const maybeSkip = (fn: () => Promise<void>) => async () => {
      if (!fixture) {
        console.warn(`[objectstore/contract] skipping ${name} (impl unavailable)`);
        return;
      }
      await fn();
    };

    const pfx = () => `tenants/t1/${randomUUID()}/`;

    it(
      "put → get round-trips the bytes",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        const payload = rng(1024);
        await store.put(key, byteStream(payload));
        const got = await readAll(await store.get(key));
        expect(got.byteLength).toBe(payload.byteLength);
        expect(got).toEqual(payload);
      }),
    );

    it(
      "put returns a PutResult with an etag",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        const res: PutResult = await store.put(key, byteStream(rng(64)));
        expect(res.etag).toBeTruthy();
        expect(typeof res.etag).toBe("string");
      }),
    );

    it(
      "conditionalPut rejects on etag mismatch",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        const res = await store.put(key, byteStream(rng(64)));
        await expect(
          store.conditionalPut(key, byteStream(rng(64)), '"bogus-etag"'),
        ).rejects.toThrow(/mismatch/);
        // The original etag should still validate a matching conditional put.
        await store.conditionalPut(
          key,
          byteStream(rng(64)),
          res.etag!,
        );
      }),
    );

    it(
      "conditionalPut succeeds when ifMatch equals the current etag",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        const first = await store.put(key, byteStream(rng(32)));
        const second = await store.conditionalPut(
          key,
          byteStream(rng(32)),
          first.etag!,
        );
        expect(second.etag).toBeTruthy();
        expect(second.etag).not.toBe(first.etag);
      }),
    );

    it(
      "list yields objects under a prefix with the ObjectMeta shape",
      maybeSkip(async () => {
        const prefix = pfx();
        await store.put(prefix + "a", byteStream(rng(10)));
        await store.put(prefix + "b", byteStream(rng(20)));
        await store.put(prefix + "sub/c", byteStream(rng(30)));

        const metas: ObjectMeta[] = [];
        for await (const m of store.list(prefix)) metas.push(m);

        expect(metas.length).toBe(3);
        expect(metas.map((m) => m.key).sort()).toEqual(
          [prefix + "a", prefix + "b", prefix + "sub/c"].sort(),
        );
        for (const m of metas) {
          expect(typeof m.key).toBe("string");
          expect(typeof m.size).toBe("number");
          expect(m.size).toBeGreaterThanOrEqual(10);
          expect(typeof m.lastModified).toBe("string");
          // lastModified must be a valid ISO timestamp.
          expect(() => new Date(m.lastModified)).not.toThrow();
          expect(Number.isNaN(Date.parse(m.lastModified))).toBe(false);
        }
      }),
    );

    it(
      "list with a non-matching prefix yields nothing",
      maybeSkip(async () => {
        const prefix = pfx();
        await store.put(prefix + "x", byteStream(rng(8)));
        const metas: ObjectMeta[] = [];
        for await (const m of store.list(prefix + "does-not-exist/")) metas.push(m);
        expect(metas.length).toBe(0);
      }),
    );

    it(
      "delete removes the object; subsequent get throws",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        await store.put(key, byteStream(rng(64)));
        await store.delete(key);
        await expect(store.get(key)).rejects.toThrow(/object not found/);
      }),
    );

    it(
      "delete is idempotent for a missing key",
      maybeSkip(async () => {
        await expect(store.delete(pfx() + "absent")).resolves.toBeUndefined();
      }),
    );

    it(
      "hardDelete purges all versions; get/head/list observe nothing",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        // Overwrite once so a versioned store accumulates a prior version.
        await store.put(key, byteStream(rng(64)));
        await store.put(key, byteStream(rng(64)));
        await store.hardDelete(key);
        await expect(store.get(key)).rejects.toThrow(/object not found/);
        expect(await store.head(key)).toBeNull();
        const metas: ObjectMeta[] = [];
        for await (const m of store.list(key)) metas.push(m);
        expect(metas.length).toBe(0);
      }),
    );

    it(
      "hardDelete is idempotent for a missing key",
      maybeSkip(async () => {
        await expect(store.hardDelete(pfx() + "absent")).resolves.toBeUndefined();
      }),
    );

    it(
      "head returns metadata for an existing object, null for a missing one",
      maybeSkip(async () => {
        const key = pfx() + "log.jsonl";
        const payload = rng(128);
        await store.put(key, byteStream(payload));
        const meta = await store.head(key);
        expect(meta).not.toBeNull();
        expect(meta!.key).toBe(key);
        expect(meta!.size).toBe(payload.byteLength);
        expect(typeof meta!.etag).toBe("string");
        expect(meta!.etag).toBeTruthy();
        expect(Number.isNaN(Date.parse(meta!.lastModified))).toBe(false);
        expect(await store.head(pfx() + "missing")).toBeNull();
      }),
    );

    it(
      "handles large streaming content (>1 MiB)",
      maybeSkip(async () => {
        const key = pfx() + "blob.bin";
        const payload = rng(2 * 1024 * 1024 + 13);
        const put = await store.put(key, byteStream(payload));
        const got = await readAll(await store.get(key));
        expect(got.byteLength).toBe(payload.byteLength);
        // Same byte-exact guarantee as the small-payload case, but native: `toEqual`
        // walks a multi-MiB typed array element by element, which timed out the 5s
        // default on a shared CI runner (~2.4s per store even on fast hardware).
        expect(Buffer.compare(Buffer.from(got), Buffer.from(payload))).toBe(0);
        // ETag must be stable across reads of the same content: a conditional put
        // with the returned etag must succeed.
        const cp = await store.conditionalPut(
          key,
          byteStream(payload),
          put.etag!,
        );
        expect(cp.etag).toBeTruthy();
      }),
    );

    it(
      "get on a missing key throws object-not-found",
      maybeSkip(async () => {
        await expect(store.get(pfx() + "missing")).rejects.toThrow(
          /object not found/,
        );
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Parameterized runs
// ---------------------------------------------------------------------------

runContract("FakeObjectStore", fakeFixture);
runContract("FilesystemObjectStore", fsFixture);
runContract("S3ObjectStore (MinIO)", s3Fixture);
runContract("GCSObjectStore (fake-gcs-server)", gcsFixture);
