/**
 * Memory stores + memories + versions integration tests (WP-2.2, §13, §29.3).
 *
 * Covers the done criteria:
 *  - Limits enforced (100 kB content, 2000/store, 8/session, 4096 instructions).
 *  - `contentSha256` optimistic concurrency (409 on mismatch).
 *  - Versions survive memory deletion; 30-day retention (`expires_at`).
 *  - Redact rejects the head of a live memory (409); old version scrubbed.
 *  - Read-only mount enforced (read-only VolumeMount; agent write would fail).
 *  - Write-back round-trip: two sessions sharing a store (fake volume, always).
 *
 * Uses a real Postgres via @testcontainers/postgresql + a FilesystemObjectStore
 * in a tmpdir. Skips without a container runtime (mirrors the db/vault convention).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createPool,
  closePool,
  query,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../../infra/db/index.js";
import { FilesystemObjectStore } from "../../../infra/objectstore/index.js";
import { ApiError } from "../../errors.js";
import { idempotencyMiddleware } from "../../../api/middleware/idempotency.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../../infra/db/__tests__/test-runtime.js";
import { memoryRoutes } from "../../../api/memory-stores.js";
import {
  mountMemoryStores,
  mountPathFor,
  systemPromptNoteFor,
  stageMemoryVolume,
  syncMemoryVolumeBack,
  InMemoryVolumeStore,
  sha256Hex,
  listMemoryVersions,
  getMemoryVersion,
  restoreVersion,
  purgeExpiredVersions,
} from "../index.js";
import type { ObjectStore } from "../../ports.js";

// scopes: ["admin"] — this fixture injects tenantCtx directly (bypassing
// issueApiKey), so it must carry a scope explicitly to pass the
// requireScopeByMethod guard (R0.1) that memoryRoutes registers.
const TENANT: TenantCtx = { tenantId: "tnt_memory_test", scopes: ["admin"] };
const RUNTIME = hasContainerRuntime();

let db: TestDb | undefined;
let pool: Pool | undefined;
let objectStore: FilesystemObjectStore;
let objectRoot: string;
let app: FastifyInstance | undefined;

async function buildApp(p: Pool, store: ObjectStore): Promise<FastifyInstance> {
  const a = Fastify();
  a.addHook("onRequest", async (req) => {
    req.tenantCtx = TENANT;
  });
  a.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({
        error: {
          type: err.statusCode >= 500 ? "server_error" : "request_error",
          code: err.code,
          message: err.message,
          requestId: req.id,
        },
      });
    }
    const message = err instanceof Error ? err.message : "internal error";
    return reply
      .status(500)
      .send({ error: { type: "server_error", code: "internal_error", message, requestId: req.id } });
  });
  idempotencyMiddleware(a, p);
  await a.register(memoryRoutes, { pool: p, objectStore: store });
  return a;
}

beforeAll(async () => {
  if (!RUNTIME) return;
  db = await startPostgres();
  await runMigrations(db.connectionString, "up");
  pool = createPool({ connectionString: db.connectionString });
  await query(
    pool,
    `INSERT INTO tenants (id, name) VALUES ($1, 'Memory Test') ON CONFLICT DO NOTHING`,
    [TENANT.tenantId],
  );
  objectRoot = await mkdtemp(join(tmpdir(), "pi-mem-"));
  objectStore = new FilesystemObjectStore({ root: objectRoot });
  app = await buildApp(pool, objectStore);
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await closePool(pool);
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
  if (db) await db.container.stop();
}, 120_000);

/** Create a store via the API and return its id. */
async function createStore(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app!.inject({
    method: "POST",
    url: "/v1/memory-stores",
    headers: { "idempotency-key": `store-${title}`, "content-type": "application/json" },
    payload: JSON.stringify({ displayTitle: title, ...extra }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return JSON.parse(res.body).id;
}

/** Create a memory via the API. */
async function createMemory(storeId: string, path: string, content: string, idem: string) {
  return app!.inject({
    method: "POST",
    url: `/v1/memory-stores/${storeId}/memories`,
    headers: { "idempotency-key": idem, "content-type": "application/json" },
    payload: JSON.stringify({ path, content }),
  });
}

// ---------------------------------------------------------------------------
// Store CRUD + limits
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("memory store CRUD", () => {
  it("creates, lists, gets, patches, and deletes a store", async () => {
    const id = await createStore("Conventions", { instructions: "be consistent" });
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${id}` });
    expect(got.statusCode).toBe(200);
    expect(JSON.parse(got.body).displayTitle).toBe("Conventions");
    expect(JSON.parse(got.body).instructions).toBe("be consistent");
    expect(JSON.parse(got.body).mountPath).toBeNull(); // §13.3: on session, not store

    const patched = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${id}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ instructions: "updated instructions" }),
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body).instructions).toBe("updated instructions");

    const listed = await app!.inject({ method: "GET", url: "/v1/memory-stores" });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).data.some((s: { id: string }) => s.id === id)).toBe(true);

    const del = await app!.inject({ method: "DELETE", url: `/v1/memory-stores/${id}` });
    expect(del.statusCode).toBe(204);
  }, 60_000);

  it("rejects a duplicate displayTitle with 409", async () => {
    await createStore("Unique Title");
    const second = await app!.inject({
      method: "POST",
      url: "/v1/memory-stores",
      headers: { "idempotency-key": "dup", "content-type": "application/json" },
      payload: JSON.stringify({ displayTitle: "Unique Title" }),
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe("conflict");
  }, 60_000);

  it("rejects instructions over 4096 chars with 422", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/v1/memory-stores",
      headers: { "idempotency-key": "long", "content-type": "application/json" },
      payload: JSON.stringify({ displayTitle: "LongInstr", instructions: "x".repeat(4097) }),
    });
    expect(res.statusCode).toBe(422);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Memory CRUD + optimistic concurrency + versions survive deletion
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("memory CRUD + concurrency", () => {
  let storeId: string;

  beforeAll(async () => {
    storeId = await createStore("Crud Store");
  }, 60_000);

  it("creates a memory and retrieves it with content", async () => {
    const res = await createMemory(storeId, "notes.md", "first content", "mem-1");
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.path).toBe("notes.md");
    expect(body.content).toBe("first content");
    expect(body.contentSha256).toBe(sha256Hex("first content"));

    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/notes.md` });
    expect(got.statusCode).toBe(200);
    expect(JSON.parse(got.body).content).toBe("first content");
  }, 60_000);

  it("rejects a duplicate path with 409", async () => {
    const res = await createMemory(storeId, "notes.md", "dup", "mem-dup");
    expect(res.statusCode).toBe(409);
  }, 60_000);

  it("updates with the correct contentSha256 and rejects a mismatch with 409", async () => {
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/notes.md` });
    const { contentSha256 } = JSON.parse(got.body);

    // Wrong sha → 409 (§13.4).
    const bad = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${storeId}/memories/notes.md`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "raced", contentSha256: sha256Hex("wrong") }),
    });
    expect(bad.statusCode).toBe(409);
    expect(JSON.parse(bad.body).error.code).toBe("conflict");

    // Correct sha → 200.
    const ok = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${storeId}/memories/notes.md`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "second content", contentSha256 }),
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).content).toBe("second content");
    expect(JSON.parse(ok.body).contentSha256).toBe(sha256Hex("second content"));
  }, 60_000);

  it("rejects content over 100 kB with 422", async () => {
    const res = await createMemory(storeId, "big.md", "x".repeat(100 * 1024 + 1), "mem-big");
    expect(res.statusCode).toBe(422);
  }, 60_000);

  it("versions survive memory deletion (§13.5)", async () => {
    const created = await createMemory(storeId, "ephemeral.md", "v1", "mem-eph");
    expect(created.statusCode).toBe(201);

    // Two versions exist (create + the update path above is a different path).
    const before = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/versions?memoryPath=ephemeral.md` });
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body).data.length).toBe(1);

    const del = await app!.inject({ method: "DELETE", url: `/v1/memory-stores/${storeId}/memories/ephemeral.md` });
    expect(del.statusCode).toBe(204);

    // Memory is gone (404).
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/ephemeral.md` });
    expect(got.statusCode).toBe(404);

    // But the version audit trail survives (now 2 rows: original + tombstone).
    const after = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/versions?memoryPath=ephemeral.md` });
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body).data.length).toBe(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Redact (§13.6)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("version redact (§13.6)", () => {
  let storeId: string;

  beforeAll(async () => {
    storeId = await createStore("Redact Store");
  }, 60_000);

  it("rejects redacting the head of a live memory with 409", async () => {
    await createMemory(storeId, "live.md", "head", "redact-1");
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "live.md" });
    const headId = versions.data[0].id;

    const res = await app!.inject({
      method: "POST",
      url: `/v1/memory-stores/${storeId}/versions/${headId}/redact`,
      headers: { "idempotency-key": `redact-head-${headId}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("conflict");
  }, 60_000);

  it("redacts an old (non-head) version: scrubs content, keeps audit", async () => {
    // Create v1, then update to v2 (v1 becomes non-head).
    const c = await createMemory(storeId, "hist.md", "v1", "redact-2");
    expect(c.statusCode).toBe(201);
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/hist.md` });
    const sha = JSON.parse(got.body).contentSha256;
    const upd = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${storeId}/memories/hist.md`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "v2", contentSha256: sha }),
    });
    expect(upd.statusCode).toBe(200);

    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "hist.md" });
    // Newest first: [v2, v1]. Redact v1 (the old head).
    const oldVersion = versions.data[1];
    expect(oldVersion.redacted).toBe(false);

    const res = await app!.inject({
      method: "POST",
      url: `/v1/memory-stores/${storeId}/versions/${oldVersion.id}/redact`,
      headers: { "idempotency-key": `redact-old-${oldVersion.id}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const redacted = JSON.parse(res.body);
    expect(redacted.redacted).toBe(true);

    // Audit row preserved.
    const fetched = await getMemoryVersion(pool!, TENANT, storeId, oldVersion.id);
    expect(fetched?.redacted).toBe(true);
    // Live memory still readable.
    const live = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/hist.md` });
    expect(live.statusCode).toBe(200);
    expect(JSON.parse(live.body).content).toBe("v2");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Restore (WP-C4.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("version restore (WP-C4.0)", () => {
  let storeId: string;

  beforeAll(async () => {
    storeId = await createStore("Restore Store");
  }, 60_000);

  /** POST the restore op for a version id. */
  async function restore(versionId: string) {
    return app!.inject({
      method: "POST",
      url: `/v1/memory-stores/${storeId}/versions/${versionId}/restore`,
      headers: { "idempotency-key": `restore-${versionId}` },
    });
  }

  it("creates a NEW head version with the old version's content", async () => {
    await createMemory(storeId, "doc.md", "v1", "restore-1");
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/doc.md` });
    const sha1 = JSON.parse(got.body).contentSha256;
    const upd = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${storeId}/memories/doc.md`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "v2", contentSha256: sha1 }),
    });
    expect(upd.statusCode).toBe(200);

    // Newest first: [v2, v1]. Restore v1 (the old version).
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "doc.md" });
    const oldV = versions.data[1];
    expect(oldV.contentSha256).toBe(sha256Hex("v1"));

    const res = await restore(oldV.id);
    expect(res.statusCode, res.body).toBe(201);
    const restored = JSON.parse(res.body);
    expect(restored.id).not.toBe(oldV.id); // NEW version — history preserved
    expect(restored.memoryPath).toBe("doc.md");
    expect(restored.contentSha256).toBe(sha256Hex("v1"));
    expect(restored.redacted).toBe(false);

    // The restored version is the live head with identical content.
    const live = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/doc.md` });
    expect(live.statusCode).toBe(200);
    expect(JSON.parse(live.body).content).toBe("v1");

    // Nothing rewritten: [restored, v2, v1].
    const after = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "doc.md" });
    expect(after.data.length).toBe(3);
    expect(after.data[0].id).toBe(restored.id);
  }, 60_000);

  it("undeletes: restoring a pre-delete version makes the path live again", async () => {
    await createMemory(storeId, "gone.md", "keep me", "restore-2");
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "gone.md" });
    const original = versions.data[0];
    const del = await app!.inject({ method: "DELETE", url: `/v1/memory-stores/${storeId}/memories/gone.md` });
    expect(del.statusCode).toBe(204);

    const res = await restore(original.id);
    expect(res.statusCode, res.body).toBe(201);
    const live = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/gone.md` });
    expect(live.statusCode).toBe(200);
    expect(JSON.parse(live.body).content).toBe("keep me");

    // Restoring the deletion tombstone itself is a 409 (no content to restore).
    const afterDel = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "gone.md" });
    // Newest first: [restored, tombstone, original].
    const tombstone = afterDel.data[1];
    const rejected = await restore(tombstone.id);
    expect(rejected.statusCode).toBe(409);
    expect(JSON.parse(rejected.body).error.code).toBe("conflict");
  }, 60_000);

  it("rejects restoring a redacted version (content gone) with 409", async () => {
    await createMemory(storeId, "red.md", "secret v1", "restore-3");
    const got = await app!.inject({ method: "GET", url: `/v1/memory-stores/${storeId}/memories/red.md` });
    const sha = JSON.parse(got.body).contentSha256;
    const upd = await app!.inject({
      method: "PATCH",
      url: `/v1/memory-stores/${storeId}/memories/red.md`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "clean v2", contentSha256: sha }),
    });
    expect(upd.statusCode).toBe(200);
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "red.md" });
    const oldV = versions.data[1];
    const red = await app!.inject({
      method: "POST",
      url: `/v1/memory-stores/${storeId}/versions/${oldV.id}/redact`,
      headers: { "idempotency-key": `redact-restore-${oldV.id}` },
    });
    expect(red.statusCode, red.body).toBe(200);

    const res = await restore(oldV.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("conflict");
  }, 60_000);

  it("404 on an unknown version id", async () => {
    const res = await restore("memver_does_not_exist");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  }, 60_000);

  it("does not leak across tenants: another tenant's ctx gets 404", async () => {
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 1 });
    const versionId = versions.data[0].id;
    const OTHER: TenantCtx = { tenantId: "tnt_memory_other", scopes: ["admin"] };
    await expect(
      restoreVersion(pool!, OTHER, objectStore, storeId, versionId),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Retention (§13.5)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("version retention (§13.5)", () => {
  it("sets expires_at 30 days out and keeps recent versions on purge", async () => {
    const sid = await createStore("Retention Store");
    await createMemory(sid, "r.md", "c", "ret-1");

    const versions = await listMemoryVersions(pool!, TENANT, sid, { limit: 50 });
    const v = versions.data[0];
    expect(v.expiresAt).not.toBeNull();
    const expiresAt = new Date(v.expiresAt!);
    const thirtyDays = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    // Within a minute of now+30d.
    expect(Math.abs(expiresAt.getTime() - thirtyDays.getTime())).toBeLessThan(60_000);

    // Force-expire two old versions and purge; recent-always-kept must survive.
    await query(
      pool!,
      `UPDATE memory_versions SET expires_at = now() - interval '1 day'
        WHERE tenant_id = $1 AND store_id = $2`,
      [TENANT.tenantId, sid],
    );
    const purged = await purgeExpiredVersions(pool!, objectStore, { keepRecent: 10 });
    expect(purged).toBe(0); // all are "recent" (≤10) → kept regardless of expiry
    const after = await listMemoryVersions(pool!, TENANT, sid, { limit: 50 });
    expect(after.data.length).toBe(versions.data.length);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Mount pipeline (§13.1–13.3) — pure, no DB
// ---------------------------------------------------------------------------

describe("mount pipeline (§13.1–13.3)", () => {
  const rw = { id: "mem_rw", displayTitle: "Project Notes", access: "read_write" as const, status: "active" as const, mountPath: null, createdAt: "2026-07-13T00:00:00Z", updatedAt: "2026-07-13T00:00:00Z" };
  const ro = { ...rw, id: "mem_ro", displayTitle: "Untrusted Context", access: "read_only" as const };

  it("derives /mnt/memory/<slug>/ mount paths", () => {
    expect(mountPathFor(rw)).toBe("/mnt/memory/project-notes/");
    expect(mountPathFor(ro)).toBe("/mnt/memory/untrusted-context/");
  });

  it("enforces read-only at the mount level (§13.2)", () => {
    const mounts = mountMemoryStores(TENANT, [rw, ro]);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].readOnly).toBe(false);
    expect(mounts[1].readOnly).toBe(true); // read_only → read-only mount
    expect(mounts[0].guestPath).toBe("/mnt/memory/project-notes/");
  });

  it("rejects more than 8 stores per session with 422 (§13.2)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...rw, id: `mem_${i}`, displayTitle: `S${i}` }));
    expect(() => mountMemoryStores(TENANT, nine)).toThrow();
    // Exactly 8 is allowed.
    const eight = nine.slice(0, 8);
    expect(mountMemoryStores(TENANT, eight)).toHaveLength(8);
  });

  it("emits a system-prompt note per mount (§13.1)", () => {
    const notes = systemPromptNoteFor(ro);
    expect(notes).toContain("read-only");
    expect(notes).toContain("/mnt/memory/untrusted-context/");
    expect(notes).toContain("writes will fail at the mount level");
  });

  it("read-only mount source points at the store object prefix", () => {
    const [m] = mountMemoryStores(TENANT, [rw]);
    expect(m.source).toBe(`tenants/${TENANT.tenantId}/memory/mem_rw`);
  });
});

// ---------------------------------------------------------------------------
// Write-back round-trip: two sessions sharing a store (fake volume, §29.3)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNTIME)("write-back round-trip (two sessions, one store)", () => {
  it("session A edits the volume; on idle sync writes back; session B reads it", async () => {
    const storeId = await createStore("Shared Store");
    await createMemory(storeId, "README.md", "original", "wb-1");

    // Session A: stage live memories into its volume, then the agent edits.
    const volA = new InMemoryVolumeStore();
    await stageMemoryVolume(pool!, TENANT, objectStore, storeId, volA);
    expect(await volA.readFile("README.md")).toEqual(Buffer.from("original", "utf8"));
    // Agent edits the file in the mounted volume.
    volA.write("README.md", "edited by session A");
    // On idle → write-back sync to the object store (new version).
    await syncMemoryVolumeBack({
      pool: pool!,
      tenantCtx: TENANT,
      objectStore,
      storeId,
      volume: volA,
    });

    // Session B: stage fresh from the object store and observe A's edit.
    const volB = new InMemoryVolumeStore();
    await stageMemoryVolume(pool!, TENANT, objectStore, storeId, volB);
    expect((await volB.readFile("README.md")).toString("utf8")).toBe("edited by session A");

    // And via the API: a new version was created.
    const versions = await listMemoryVersions(pool!, TENANT, storeId, { limit: 50, memoryPath: "README.md" });
    expect(versions.data.length).toBe(2); // create + write-back
  }, 60_000);
});
