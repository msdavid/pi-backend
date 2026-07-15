/**
 * Skills API (WP-3.5, §8.10, §20).
 *
 * HTTP-level coverage over a real Postgres testcontainer + FakeObjectStore:
 * upload (zip + individual files) → retrieve; `displayTitle` uniqueness (409);
 * list with type filter; versions; delete; cross-tenant isolation.
 *
 * Domain-level coverage (seeding, materialization, rubric-ref) lives in
 * `domain/skill/__tests__/skill.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createApp } from "../../server.js";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "../../infra/db/index.js";
import { loadConfig } from "../../infra/config/index.js";
import { startPostgres, type TestDb } from "../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../domain/tenant/tenant.js";
import { issueApiKey } from "../../domain/tenant/api-key.js";
import { FakeObjectStore } from "@pi-managed/testkit";
import { seedPrebuiltSkills } from "../../domain/skill/index.js";
import type { TenantCtx } from "../../infra/db/pool.js";

/** Build a multipart/form-data body + content-type header from named parts. */
function multipart(
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    data: Buffer | string;
  }>,
): { headers: Record<string, string>; body: Buffer } {
  const boundary = `----piTestBoundary${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) disp += `; filename="${p.filename}"`;
    chunks.push(Buffer.from(`${disp}\r\n`));
    if (p.contentType) chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(typeof p.data === "string" ? Buffer.from(p.data) : p.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  };
}

// ---------------------------------------------------------------------------
// STORE-only ZIP writer (no dep): builds a valid PKZIP for the upload test.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a STORE-only (method 0) zip from relative path → content entries. */
function makeStoreOnlyZip(entries: Array<{ path: string; data: Buffer | string }>): Buffer {
  const enc = (s: string) => Buffer.from(s, "utf8");
  const lfhChunks: Buffer[] = [];
  const cdhChunks: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data) : e.data;
    const name = enc(e.path);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method: store
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // comp size
    lfh.writeUInt32LE(data.length, 22); // uncomp size
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra
    const entry = Buffer.concat([lfh, name, data]);
    lfhChunks.push(entry);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    cdhChunks.push(Buffer.concat([cdh, name]));

    offset += entry.length;
  }
  const cd = Buffer.concat(cdhChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...lfhChunks, cd, eocd]);
}

describe("skills API (HTTP)", () => {
  let db: TestDb;
  let pool: Pool;
  let app: FastifyInstance;
  let apiKey: string;
  let tenantId: string;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const config = loadConfig({ env: { LOG_LEVEL: "error" } });
    app = await createApp({
      config,
      logger: pino({ level: "error" }),
      pool,
      objectStore: new FakeObjectStore(),
    });
    const t = await createTenant(pool, { name: "Skills HTTP Tenant" });
    tenantId = t.id;
    const issued = await issueApiKey(pool, { tenantId: t.id }, { name: "k" });
    apiKey = issued.key;
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  function auth() {
    return { authorization: `Bearer ${apiKey}` };
  }

  const skillMd = (name: string, desc = "A test skill") =>
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nDoes the thing.\n`;

  it("upload requires auth + Idempotency-Key", async () => {
    const mp = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("needs-auth") },
    ]);
    const noAuth = await app.inject({
      method: "POST", url: "/v1/skills", headers: mp.headers, payload: mp.body,
    });
    expect(noAuth.statusCode).toBe(401);
    const noIdem = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), ...mp.headers }, payload: mp.body,
    });
    expect(noIdem.statusCode).toBe(400);
    expect(noIdem.json().error.code).toBe("invalid_request");
  });

  it("upload individual files → retrieve", async () => {
    const mp = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("code-review") },
      { name: "file", filename: "helper.sh", data: "echo hi\n" },
    ]);
    const uploaded = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-files", ...mp.headers },
      payload: mp.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const skill = uploaded.json();
    expect(skill.id).toMatch(/^skill_/);
    expect(skill.displayTitle).toBe("code-review");
    expect(skill.type).toBe("custom");
    expect(skill.versions).toEqual([{ version: 1, createdAt: expect.any(String) }]);

    const got = await app.inject({ method: "GET", url: `/v1/skills/${skill.id}`, headers: auth() });
    expect(got.statusCode).toBe(200);
    expect(got.json().id).toBe(skill.id);

    const vers = await app.inject({
      method: "GET", url: `/v1/skills/${skill.id}/versions`, headers: auth(),
    });
    expect(vers.statusCode).toBe(200);
    expect(vers.json().data).toHaveLength(1);
  });

  it("upload a zip → retrieve", async () => {
    const zip = makeStoreOnlyZip([
      { path: "SKILL.md", data: skillMd("slide-deck", "Build slides") },
      { path: "assets/tpl.txt", data: "template" },
    ]);
    const mp = multipart([
      { name: "file", filename: "skill.zip", contentType: "application/zip", data: zip },
    ]);
    const uploaded = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-zip", ...mp.headers },
      payload: mp.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const skill = uploaded.json();
    expect(skill.displayTitle).toBe("slide-deck");
    expect(skill.versions).toHaveLength(1);
  });

  it("rejects a bundle without SKILL.md (422)", async () => {
    const mp = multipart([
      { name: "file", filename: "README.md", data: "# not a skill" },
    ]);
    const res = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-noskill", ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("displayTitle uniqueness → 409 conflict", async () => {
    const mp1 = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("unique-skill") },
    ]);
    const first = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-uniq-1", ...mp1.headers },
      payload: mp1.body,
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-uniq-2", ...mp1.headers },
      payload: mp1.body,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
    expect(dup.json().error.details.skillId).toBe(first.json().id);
  });

  it("explicit displayTitle overrides derivation", async () => {
    const mp = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("internal-name") },
      { name: "displayTitle", data: "Custom Title" },
    ]);
    const res = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-title", ...mp.headers },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().displayTitle).toBe("Custom Title");
  });

  it("list with type filter + pagination", async () => {
    const ctx: TenantCtx = { tenantId };
    await seedPrebuiltSkills(pool, ctx, new FakeObjectStore());
    const all = await app.inject({ method: "GET", url: "/v1/skills", headers: auth() });
    expect(all.statusCode).toBe(200);
    expect(all.json().data.length).toBeGreaterThanOrEqual(5);

    const prebuilt = await app.inject({
      method: "GET", url: "/v1/skills?type=prebuilt", headers: auth(),
    });
    expect(prebuilt.statusCode).toBe(200);
    expect(prebuilt.json().data.every((s: { type: string }) => s.type === "prebuilt")).toBe(true);
    expect(prebuilt.json().data.length).toBeGreaterThanOrEqual(4);

    const bad = await app.inject({
      method: "GET", url: "/v1/skills?type=bogus", headers: auth(),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("delete → 204 then 404", async () => {
    const mp = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("to-delete") },
    ]);
    const uploaded = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-del", ...mp.headers },
      payload: mp.body,
    });
    const id = uploaded.json().id;

    const deleted = await app.inject({ method: "DELETE", url: `/v1/skills/${id}`, headers: auth() });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/v1/skills/${id}`, headers: auth() });
    expect(gone.statusCode).toBe(404);
  });

  it("cross-tenant: tenant B cannot see tenant A's skill", async () => {
    const mp = multipart([
      { name: "file", filename: "SKILL.md", data: skillMd("private-skill") },
    ]);
    const uploaded = await app.inject({
      method: "POST", url: "/v1/skills",
      headers: { ...auth(), "idempotency-key": "sk-xt", ...mp.headers },
      payload: mp.body,
    });
    const id = uploaded.json().id;

    const tb = await createTenant(pool, { name: "Other Skills Tenant" });
    const bKey = (await issueApiKey(pool, { tenantId: tb.id }, { name: "bk" })).key;
    const got = await app.inject({
      method: "GET", url: `/v1/skills/${id}`,
      headers: { authorization: `Bearer ${bKey}` },
    });
    expect(got.statusCode).toBe(404);
  });
});
