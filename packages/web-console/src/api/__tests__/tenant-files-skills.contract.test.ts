// @vitest-environment node
/**
 * WP-C3.6 contract tests — tenant usage-over-time with SEEDED spend, the
 * files/skills read+delete surfaces, and the C§5.1 health probes — against
 * the REAL in-process backend (CONVENTIONS.md "Fakes at the seam": both
 * sides real — testcontainers Postgres, the real Fastify app on an ephemeral
 * port, real global `fetch`).
 *
 * Usage seeding follows the WP-C3.0 backend suite
 * (`backend/src/api/__tests__/tenant-usage.test.ts`): rows go through the
 * production `PgUsageRecorder` with a deterministic price table, then each
 * row's `recorded_at` is pinned to an explicit UTC instant so bucket math is
 * exact. File/skill seeding goes through the real multipart routes (the
 * console itself does not upload — see `src/api/files-skills.ts` — so the
 * raw fetch there is seeding, not the subject).
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FilesystemObjectStore,
  createAgent,
  createEnvironment,
  createSession,
  createUsageRecorder,
  tenantScopedQuery,
  type PriceTable,
  type TenantCtx,
} from "@pi-managed/backend";
import { File as FileSchema, Skill as SkillSchema } from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import { getTenantUsage } from "../tenant.js";
import {
  deleteFile,
  deleteSkill,
  fileContentDownloadUrl,
  getFile,
  getSkill,
  listFiles,
  listSkills,
  listSkillVersions,
} from "../files-skills.js";
import { createHealthProber, getHealthz, getReadyz } from "../health.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console WP-C3.6 contract suite");

/** Deterministic per-token rates (every seeded model falls back to
 * `unknown-model`; seeds carry input tokens only → cost = tokens × 3e-6). */
const PRICES: PriceTable = {
  "unknown-model": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0,
    cacheReadPerToken: 0,
  },
};

/** A wide query window containing every seeded row. */
const WINDOW = {
  from: "2026-06-01T00:00:00Z",
  to: "2026-08-01T00:00:00Z",
};

describe.skipIf(!RUNTIME)("WP-C3.6 clients ↔ real backend", () => {
  let backend: TestBackend;
  let admin: ConsoleApiClient;
  let ctx: TenantCtx;
  let agentA: string;
  let agentB: string;
  const objectRoot = mkdtempSync(join(tmpdir(), "pi-console-c36-"));

  /** Seed one usage row through the production recorder, then pin its
   * `recorded_at` (defaults to now()) to a fixed UTC instant. */
  async function seedUsage(
    sessionId: string,
    model: string,
    inputTokens: number,
    recordedAt: string,
  ) {
    const recorder = createUsageRecorder({
      pool: backend.pool,
      priceTable: PRICES,
    });
    await recorder.record(sessionId, model, {
      inputTokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    await tenantScopedQuery(
      backend.pool,
      ctx,
      `UPDATE usage_records SET recorded_at = $2
       WHERE tenant_id = $1 AND session_id = $3 AND model = $4`,
      [ctx.tenantId, recordedAt, sessionId, model],
    );
  }

  beforeAll(async () => {
    backend = await startTestBackend({
      app: { objectStore: new FilesystemObjectStore({ root: objectRoot }) },
    });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    ctx = { tenantId: backend.tenantId };

    // Two agents, three sessions (one carries metadata.userId), four rows
    // across two UTC days — enough to prove buckets + both breakdowns.
    const env = await createEnvironment(backend.pool, ctx, {
      name: "c36-usage-env",
      type: "cloud",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "unrestricted" },
    });
    const agentConfig = (name: string) => ({
      name,
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      systemPrompt: "You are a careful assistant.",
      tools: {
        defaultConfig: {
          enabled: true,
          permissionPolicy: "always_allow" as const,
        },
        configs: {},
      },
      skills: [],
      extensions: [],
      mcpServers: [],
      multiagent: { roster: [] },
      metadata: {},
    });
    agentA = (await createAgent(backend.pool, ctx, agentConfig("c36-agent-a"))).id;
    agentB = (await createAgent(backend.pool, ctx, agentConfig("c36-agent-b"))).id;

    const s1 = (
      await createSession(backend.pool, ctx, {
        agent: agentA,
        environmentId: env.id,
        metadata: { userId: "u_alice" },
      })
    ).id;
    const s2 = (
      await createSession(backend.pool, ctx, {
        agent: agentB,
        environmentId: env.id,
      })
    ).id;
    await seedUsage(s1, "c36-seed-1", 1000, "2026-07-01T10:00:00Z");
    await seedUsage(s2, "c36-seed-2", 2000, "2026-07-01T11:00:00Z");
    await seedUsage(s2, "c36-seed-3", 4000, "2026-07-02T12:00:00Z");
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
    rmSync(objectRoot, { recursive: true, force: true });
  }, 120_000);

  describe("tenant usage over time (C§9.9 data; WP-C3.0 endpoint)", () => {
    it("day buckets: UTC-aligned, ascending, with the recorder's USD costs", async () => {
      const usage = await getTenantUsage(
        { granularity: "day", ...WINDOW },
        admin,
      );
      expect(usage.granularity).toBe("day");
      expect(usage.groupBy).toBeUndefined();
      expect(
        usage.data.map((row) => [row.bucketStart, row.inputTokens]),
      ).toEqual([
        ["2026-07-01T00:00:00.000Z", 3000],
        ["2026-07-02T00:00:00.000Z", 4000],
      ]);
      expect(usage.data[0]!.usdCost).toBeCloseTo(0.009, 6);
      expect(usage.data[1]!.usdCost).toBeCloseTo(0.012, 6);
    });

    it("month granularity folds both days into one bucket", async () => {
      const usage = await getTenantUsage(
        { granularity: "month", ...WINDOW },
        admin,
      );
      expect(
        usage.data.map((row) => [row.bucketStart, row.inputTokens]),
      ).toEqual([["2026-07-01T00:00:00.000Z", 7000]]);
    });

    it("groupBy=agent splits buckets by agentId (the console's breakdown)", async () => {
      const usage = await getTenantUsage(
        { granularity: "day", groupBy: "agent", ...WINDOW },
        admin,
      );
      expect(usage.groupBy).toBe("agent");
      const rows = usage.data.map((row) => ({
        bucket: row.bucketStart,
        agent: row.agentId,
        tokens: row.inputTokens,
      }));
      expect(rows).toContainEqual({
        bucket: "2026-07-01T00:00:00.000Z",
        agent: agentA,
        tokens: 1000,
      });
      expect(rows).toContainEqual({
        bucket: "2026-07-01T00:00:00.000Z",
        agent: agentB,
        tokens: 2000,
      });
      expect(rows).toContainEqual({
        bucket: "2026-07-02T00:00:00.000Z",
        agent: agentB,
        tokens: 4000,
      });
    });

    it("groupBy=user attributes by metadata.userId, null for unattributed", async () => {
      const usage = await getTenantUsage(
        { granularity: "day", groupBy: "user", ...WINDOW },
        admin,
      );
      const rows = usage.data.map((row) => ({
        user: row.userId,
        tokens: row.inputTokens,
      }));
      expect(rows).toContainEqual({ user: "u_alice", tokens: 1000 });
      expect(rows).toContainEqual({ user: null, tokens: 2000 });
      expect(rows).toContainEqual({ user: null, tokens: 4000 });
    });
  });

  describe("files (C§9.5): read + content anchor target + hard delete", () => {
    let fileId: string;

    beforeAll(async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob(["console c3.6 fixture"], { type: "text/plain" }),
        "c36-notes.txt",
      );
      const res = await fetch(`${backend.baseUrl}/v1/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${backend.adminKey}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: form,
      });
      expect(res.status).toBe(201);
      fileId = FileSchema.parse(await res.json()).id;
    }, 60_000);

    it("list + metadata parse; the download URL serves the raw content", async () => {
      const page = await listFiles({}, admin);
      expect(page.data.map((f) => f.id)).toContain(fileId);
      const file = await getFile(fileId, admin);
      expect(file.name).toBe("c36-notes.txt");
      expect(file.sizeBytes).toBeGreaterThan(0);

      // The exact URL the console renders as its <a href> (same client,
      // same origin) answers the bytes.
      const res = await admin.request("GET", fileContentDownloadUrl(fileId));
      expect(await res.text()).toBe("console c3.6 fixture");
    });

    it("delete is a hard 204: the next retrieve is a DP-9 404", async () => {
      await deleteFile(fileId, admin);
      const err: unknown = await getFile(fileId, admin).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsoleApiError);
      expect((err as ConsoleApiError).status).toBe(404);
      expect((err as ConsoleApiError).code).toBe("not_found");
    });
  });

  describe("skills (C§9.5): read + versions + hard delete", () => {
    let skillId: string;

    beforeAll(async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob(
          [
            "---\nname: c36-contract-skill\ndescription: A test skill\n---\n\n# c36\n\nDoes the thing.\n",
          ],
          { type: "text/markdown" },
        ),
        "SKILL.md",
      );
      const res = await fetch(`${backend.baseUrl}/v1/skills`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${backend.adminKey}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: form,
      });
      expect(res.status).toBe(201);
      skillId = SkillSchema.parse(await res.json()).id;
    }, 60_000);

    it("list narrows by ?type=; detail + versions parse ({data}, no cursor)", async () => {
      const page = await listSkills({ type: "custom" }, admin);
      expect(page.data.map((s) => s.id)).toContain(skillId);

      const skill = await getSkill(skillId, admin);
      expect(skill.displayTitle).toBe("c36-contract-skill");
      expect(skill.type).toBe("custom");

      const versions = await listSkillVersions(skillId, admin);
      expect(versions.data.map((v) => v.version)).toEqual([1]);
      expect(versions).not.toHaveProperty("nextCursor");
    });

    it("delete is a hard 204: the next retrieve is a 404", async () => {
      await deleteSkill(skillId, admin);
      const err: unknown = await getSkill(skillId, admin).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConsoleApiError);
      expect((err as ConsoleApiError).status).toBe(404);
    });
  });

  describe("health probes (C§5.1): the widget's transport against the real app", () => {
    it("healthz + readyz parse; both outcomes of readyz are readable", async () => {
      const prober = createHealthProber(backend.baseUrl);
      const healthz = await getHealthz(prober);
      expect(healthz.status).toBe("ok");

      // Whatever readiness this boot reports (200 ready / 503 not_ready),
      // the snapshot parses and carries the per-dependency checks — the 503
      // body being readable is the reason this transport exists.
      const readyz = await getReadyz(prober);
      expect(typeof readyz.ready).toBe("boolean");
      expect(readyz.checks.length).toBeGreaterThan(0);
      for (const check of readyz.checks) {
        expect(check.name).toBeTruthy();
        expect(["up", "down"]).toContain(check.status);
      }
    });
  });
});
