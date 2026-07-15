/**
 * R6.5b — skills materialized at session start (§20.3, §20.4).
 *
 * `skill/materialize.ts` existed but no session ever called it, so an agent's `skills[]`
 * never reached the model. This drives the real path the composition root wires:
 * `createSkillMaterializer` (real Postgres + object store) → staged `.pi/skills/<name>/`
 * → the REAL Pi `DefaultResourceLoader` the session is built with (`buildResourceLoader`),
 * whose `getSkills()` is what Pi puts in the system prompt (progressive disclosure: name
 * + description in context, `SKILL.md` read on demand).
 *
 * Also covers the ≤20-per-session cap (§20.3) and pre-built seeding being invoked for a
 * newly created tenant (R6.5c — `seedPrebuiltSkills` was dead code before).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { FakeObjectStore } from "@pi-managed/testkit";
import { ApiError } from "../../errors.js";
import {
  createTenant,
  setTenantSeedHook,
  clearTenantSeedHook,
} from "../../tenant/tenant.js";
import { uploadSkill } from "../skill.js";
import { seedPrebuiltSkills } from "../seed.js";
import { createSkillMaterializer } from "../materialize.js";
import { listSkills } from "../index.js";
import { buildResourceLoader } from "../../session-manager/materialize.js";
import type { AgentConfig } from "@pi-managed/contracts";
import type { ResolvedAgentMaterial } from "../../session-manager/types.js";

const RUNTIME = hasContainerRuntime();

const skillMd = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nStep 1. Do the thing.\n`;

describe.skipIf(!RUNTIME)("session skills at wake (R6.5b)", () => {
  let db: TestDb;
  let pool: Pool;
  let ctx: TenantCtx;
  let store: FakeObjectStore;

  beforeAll(async () => {
    db = await startPostgres();
    pool = createPool({ connectionString: db.connectionString });
    await runMigrations(db.connectionString, "up");
    store = new FakeObjectStore();
    const t = await createTenant(pool, { name: "Skills Tenant" });
    ctx = { tenantId: t.id };
  }, 120_000);

  afterAll(async () => {
    clearTenantSeedHook();
    if (pool) await closePool(pool);
    if (db) await db.container.stop();
  });

  it("materializes a skill into .pi/skills and Pi's loader discovers it", async () => {
    const uploaded = await uploadSkill(pool, ctx, store, {
      files: [
        {
          path: "SKILL.md",
          data: Buffer.from(skillMd("invoice-audit", "Audit an invoice PDF."), "utf8"),
        },
        { path: "checklist.md", data: Buffer.from("- totals\n", "utf8") },
      ],
      displayTitle: "Invoice Audit",
    });

    const materializer = createSkillMaterializer({ pool, objectStore: store });
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-skills-"));
    const root = join(sessionDir, ".pi", "skills");
    const skills = await materializer.materialize(
      ctx.tenantId,
      [{ skillId: uploaded.id }],
      root,
    );

    // 1. Staged on disk under `.pi/skills/<name>/`, SKILL.md at the dir root (Pi's
    //    discovery requires exactly this layout).
    expect(skills).toHaveLength(1);
    const skillMdPath = join(root, "invoice-audit", "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    expect(await readFile(join(root, "invoice-audit", "checklist.md"), "utf8")).toBe(
      "- totals\n",
    );
    expect(skills[0].filePath).toBe(skillMdPath);

    // 2. The REAL Pi resource loader the session is constructed with surfaces it — this
    //    is what feeds progressive disclosure into the system prompt.
    const material: ResolvedAgentMaterial = {
      agentConfig: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      } as AgentConfig,
      providerKeys: { anthropic: "sk-test" },
      cwd: sessionDir,
      skills,
    };
    const loader = buildResourceLoader(material, mkdtempSync(join(tmpdir(), "pi-ad-")));
    await loader.reload();
    const loaded = loader.getSkills().skills;
    const found = loaded.find((s) => s.name === "invoice-audit");
    expect(found).toBeDefined();
    // Description (from the frontmatter) is what the model sees up front; the body is
    // only read on demand from `filePath`.
    expect(found!.description).toBe("Audit an invoice PDF.");
    expect(found!.filePath).toBe(skillMdPath);
    expect(await readFile(found!.filePath, "utf8")).toContain("Step 1. Do the thing.");
  });

  it("enforces the ≤20 skills-per-session cap (§20.3)", async () => {
    const materializer = createSkillMaterializer({ pool, objectStore: store });
    const refs = Array.from({ length: 21 }, (_, i) => ({ skillId: `skill_${i}` }));
    const root = join(await mkdtemp(join(tmpdir(), "pi-skills-cap-")), ".pi", "skills");
    await expect(
      materializer.materialize(ctx.tenantId, refs, root),
    ).rejects.toMatchObject({ statusCode: 422 } as Partial<ApiError>);
  });

  it("seeds the pre-built skill set into a newly created tenant (R6.5c)", async () => {
    // The composition root's registration (app.ts wires exactly this hook).
    setTenantSeedHook(async (seedPool, tenantId) => {
      await seedPrebuiltSkills(seedPool, { tenantId }, store);
    });
    const fresh = await createTenant(pool, { name: "Fresh Tenant" });
    const listed = await listSkills(pool, { tenantId: fresh.id }, { limit: 50 });
    expect(listed.data.map((s) => s.displayTitle).sort()).toEqual([
      "PDF",
      "PowerPoint",
      "Spreadsheet",
      "Word Document",
    ]);
    expect(listed.data.every((s) => s.type === "prebuilt")).toBe(true);
    clearTenantSeedHook();
  });
});
