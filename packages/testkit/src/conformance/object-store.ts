/**
 * Conformance test kit for the `ObjectStore` port (WP-5.1, spec §28).
 *
 * A published vitest suite any `ObjectStore` implementation — the testkit
 * `FakeObjectStore` (reference), `FilesystemObjectStore`, `S3ObjectStore`,
 * `GCSObjectStore`, or a
 * third-party plugin — runs to prove it satisfies the contract documented on the
 * `ObjectStore` interface in `@pi-managed/backend` (`domain/ports.ts`).
 *
 * ## Usage
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runObjectStoreConformance } from "@pi-managed/testkit";
 * import { MyObjectStore } from "./my-store.js";
 *
 * describe("MyObjectStore conformance", () => {
 *   runObjectStoreConformance("MyObjectStore", async () => ({
 *     store: new MyObjectStore(),
 *     cleanup: async () => { /* teardown *\/ },
 *   }));
 * });
 * ```
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ObjectMeta,
  ObjectStore,
  PutResult,
} from "@pi-managed/backend";

/** A freshly-constructed store plus its cleanup hook. */
export interface ObjectStoreFixture {
  store: ObjectStore;
  cleanup?: () => Promise<void>;
}

/** Wrap bytes in a `ReadableStream<Uint8Array>`. */
function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}

/** Random bytes as a plain `Uint8Array` (not a Node `Buffer`) for deep-equal parity. */
function rng(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/** Drain a `ReadableStream<Uint8Array>` to a single `Uint8Array`. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
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

/**
 * Run the `ObjectStore` contract suite against a single impl. `make` returns the
 * fixture, or `null` if the impl cannot be provisioned in this environment (e.g. no
 * Docker for an S3/GCS testcontainer) — the suite then skips with a warning.
 */
export function runObjectStoreConformance(
  name: string,
  make: () => Promise<ObjectStoreFixture | null>,
): void {
  describe(name, () => {
    let fixture: ObjectStoreFixture | null = null;
    let store: ObjectStore;

    beforeAll(async () => {
      fixture = await make();
      if (!fixture) return;
      store = fixture.store;
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    /** Skip the test body when the impl couldn't be provisioned. */
    const maybeSkip = (fn: () => Promise<void>) => async () => {
      if (!fixture) {
        console.warn(
          `[objectstore/conformance] skipping ${name} (impl unavailable)`,
        );
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
        await store.conditionalPut(key, byteStream(rng(64)), res.etag!);
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
        expect(got).toEqual(payload);
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
