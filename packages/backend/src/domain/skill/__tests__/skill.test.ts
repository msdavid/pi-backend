/**
 * Skills domain (WP-3.5): seeding idempotency, materialization (≤20 limit,
 * latest vs pinned), rubric-ref file fetch. Real Postgres testcontainer +
 * FakeObjectStore.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPool,
  closePool,
  runMigrations,
  type Pool,
} from "../../../infra/db/index.js";
import { startPostgres, type TestDb } from "../../../infra/db/__tests__/test-runtime.js";
import { createTenant } from "../../tenant/tenant.js";
import { uploadFile } from "../../file/index.js";
import { FakeObjectStore } from "@pi-managed/testkit";
import {
  uploadSkill,
  seedPrebuiltSkills,
  resolveSessionSkills,
  materializeSessionSkillsToDirectory,
  MAX_SKILLS_PER_SESSION,
} from "../index.js";
import { getRubricFileContent, isRubricFileRef } from "../../file/rubric-ref.js";
import type { TenantCtx } from "../../../infra/db/pool.js";
import type { SkillRef } from "@pi-managed/contracts";

const skillMd = (name: string, desc = "A skill") =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nBody.\n`;

describe("skill seeding (idempotent)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Seed Tenant" });
    ctx = { tenantId: t.id };
  }, 120_000);
  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("seeds the four default pre-built skills", async () => {
    const seeded = await seedPrebuiltSkills(pool, ctx, new FakeObjectStore());
    expect(seeded).toHaveLength(4);
    expect(seeded.map((s) => s.displayTitle).sort()).toEqual(
      ["PDF", "PowerPoint", "Spreadsheet", "Word Document"],
    );
    expect(seeded.every((s) => s.type === "prebuilt")).toBe(true);
  });

  it("is idempotent (second seed returns the same skills, no new rows)", async () => {
    const before = await seedPrebuiltSkills(pool, ctx, new FakeObjectStore());
    const after = await seedPrebuiltSkills(pool, ctx, new FakeObjectStore());
    expect(after).toHaveLength(4);
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
  });
});

describe("skill materialization", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let store: FakeObjectStore;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Materialize Tenant" });
    ctx = { tenantId: t.id };
    store = new FakeObjectStore();
  }, 120_000);
  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  async function makeSkill(name: string): Promise<string> {
    const s = await uploadSkill(pool, ctx, store, {
      files: [{ path: "SKILL.md", data: skillMd(name) }],
    });
    return s.id;
  }

  it("resolves attached skills (latest version) + writes them to a directory", async () => {
    const id = await makeSkill("mat-latest");
    const refs: SkillRef[] = [{ type: "custom", skillId: id }];
    const resolved = await resolveSessionSkills(pool, ctx, store, refs);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].version).toBe(1);
    expect(resolved[0].name).toBe("mat-latest");
    expect(resolved[0].files.some((f) => f.path === "SKILL.md")).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), "pi-skills-"));
    const staged = await materializeSessionSkillsToDirectory(resolved, dir);
    expect(staged).toHaveLength(1);
    const text = await readFile(join(staged[0].dir, "SKILL.md"), "utf8");
    expect(text).toContain("mat-latest");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects > 20 skills per session (§20.3)", async () => {
    const ids = await Promise.all(
      Array.from({ length: MAX_SKILLS_PER_SESSION + 1 }, (_, i) => makeSkill(`over-${i}`)),
    );
    const refs: SkillRef[] = ids.map((skillId) => ({ type: "custom", skillId }));
    await expect(resolveSessionSkills(pool, ctx, store, refs)).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_request",
    });
  });

  it("pinned version resolves exactly that version", async () => {
    const id = await makeSkill("mat-pinned");
    const refs: SkillRef[] = [{ type: "custom", skillId: id, version: 1 }];
    const resolved = await resolveSessionSkills(pool, ctx, store, refs);
    expect(resolved[0].version).toBe(1);
  });

  it("missing skill → 404; missing version → 404", async () => {
    await expect(
      resolveSessionSkills(pool, ctx, store, [
        { type: "custom", skillId: "skill_missing" },
      ]),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });

    const id = await makeSkill("mat-badver");
    await expect(
      resolveSessionSkills(pool, ctx, store, [
        { type: "custom", skillId: id, version: 99 },
      ]),
    ).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });
});

describe("rubric-ref file fetch (§16.2)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let store: FakeObjectStore;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    const t = await createTenant(pool, { name: "Rubric Tenant" });
    ctx = { tenantId: t.id };
    store = new FakeObjectStore();
  }, 120_000);
  afterAll(async () => {
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("fetches a file referenced as an outcome rubric", async () => {
    const rubric = "## Criteria\n- All callbacks converted to async/await\n";
    const file = await uploadFile(pool, ctx, store, {
      name: "rubric.md",
      contentType: "text/markdown",
      stream: new Response(rubric).body as ReadableStream<Uint8Array>,
    });
    expect(isRubricFileRef({ type: "file", fileId: file.id })).toBe(true);
    expect(isRubricFileRef({ type: "text", content: "x" })).toBe(false);

    const { content } = await getRubricFileContent(pool, ctx, store, file.id);
    expect(content).toBe(rubric);
  });

  it("missing rubric file → 404", async () => {
    await expect(getRubricFileContent(pool, ctx, store, "file_missing")).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
  });
});
