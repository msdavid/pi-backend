/**
 * File upload streaming (PERF-5): `uploadFile` must pipe the content straight to the
 * object store while counting bytes in-flight for `size_bytes`, never buffering the
 * whole payload. A multi-chunk `ReadableStream` proves the byte count is accumulated
 * across chunks and the content reaches the store intact.
 *
 * Uses a real testcontainers Postgres (seeded tenant) because `uploadFile` now makes
 * an atomic `maxFileStorageBytes` reservation (ROB-15) that needs the real quota
 * schema. Skips without a container runtime.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uploadFile, fileObjectKey } from "../file.js";
import { FakeObjectStore } from "@pi-managed/testkit";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";

const RUNTIME = hasContainerRuntime();

/** A stream that emits each chunk separately, forcing a multi-chunk drain. */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

describe.skipIf(!RUNTIME)("uploadFile — streaming size measurement (PERF-5)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Upload Streaming", quotaPlan: "free" });
    ctx = { tenantId: t.id };
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("counts sizeBytes across multiple chunks and stores the exact content", async () => {
    const store = new FakeObjectStore();
    const parts = [Buffer.from("abc"), Buffer.from("defgh"), Buffer.from("ij")];
    const expected = Buffer.concat(parts);

    const file = await uploadFile(pool, ctx, store, {
      name: "chunked.txt",
      stream: chunkedStream(parts.map((p) => new Uint8Array(p))),
    });

    expect(file.sizeBytes).toBe(expected.byteLength);

    const stored = await drain(await store.get(fileObjectKey(ctx.tenantId, file.id)));
    expect(stored.equals(expected)).toBe(true);
  });
});
