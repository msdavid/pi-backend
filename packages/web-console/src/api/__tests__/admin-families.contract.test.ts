// @vitest-environment node
/**
 * Contract tests for the WP-C3-prep client modules — agents, environments,
 * vaults, api-keys, webhooks, files/skills, tenant — against the REAL
 * in-process backend (CONVENTIONS.md "Fakes at the seam": both sides real —
 * testcontainers Postgres, the real Fastify app on an ephemeral port, real
 * global `fetch`). Seeding happens through the API itself with the admin
 * key, like `jobs-memory.contract.test.ts`.
 *
 * Scope: the READ paths (list/detail) of every new family, plus the
 * security-shaped invariants a read can prove (no secret field in any
 * credential/api-key/webhook read — C§13 §9.3). Mutation coverage arrives
 * with the feature WPs (C3.1–C3.7). Onboarding signup has no read path and
 * is disabled in the harness config; its coverage lands with WP-C3.7.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemObjectStore } from "@pi-managed/backend";
import { File as FileSchema } from "@pi-managed/contracts";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  createAgent,
  getAgent,
  getAgentVersion,
  listAgents,
  listAgentVersions,
} from "../agents.js";
import {
  createEnvironment,
  getEnvironment,
  getWorkStats,
  listEnvironments,
} from "../environments.js";
import { addCredential, createVault, getVault, listCredentials, listVaults } from "../vaults.js";
import { listApiKeys } from "../api-keys.js";
import { getWebhook, listWebhooks, registerWebhook } from "../webhooks.js";
import { getFile, listFiles, listSkills } from "../files-skills.js";
import { getTenant, getTenantUsage } from "../tenant.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console admin-families contract suite");

/** Well-formed but non-existent id (ULID payload). */
const MISSING_SKILL_ID = "skill_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe.skipIf(!RUNTIME)("phase-3 admin family clients ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;
  const objectRoot = mkdtempSync(join(tmpdir(), "pi-console-admin-"));

  beforeAll(async () => {
    backend = await startTestBackend({
      app: { objectStore: new FilesystemObjectStore({ root: objectRoot }) },
    });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
    rmSync(objectRoot, { recursive: true, force: true });
  }, 120_000);

  describe("agents", () => {
    let agentId: string;

    beforeAll(async () => {
      const agent = await createAgent(
        {
          name: "console-admin-agent",
          model: { provider: "anthropic", id: "claude-sonnet-4" },
        },
        admin,
      );
      agentId = agent.id;
    }, 60_000);

    it("list narrows by ?name= server-side and pages with the cursor shape", async () => {
      const page = await listAgents({ name: "console-admin-agent" }, admin);
      expect(page.data.map((a) => a.id)).toEqual([agentId]);
      expect(page.nextCursor).toBeNull();
    });

    it("detail expands the current-version config", async () => {
      const agent = await getAgent(agentId, admin);
      expect(agent.currentVersion).toBe(1);
      expect(agent.status).toBe("active");
      expect(agent.config?.model).toEqual({
        provider: "anthropic",
        id: "claude-sonnet-4",
      });
    });

    it("versions: history lists v1; retrieve returns the config blob", async () => {
      const versions = await listAgentVersions(agentId, {}, admin);
      expect(versions.data.map((v) => v.version)).toEqual([1]);

      const v1 = await getAgentVersion(agentId, 1, admin);
      expect(v1.version).toBe(1);
      expect(v1.config.model.provider).toBe("anthropic");
    });
  });

  describe("environments", () => {
    let cloudId: string;
    let selfHostedId: string;

    beforeAll(async () => {
      cloudId = (
        await createEnvironment(
          { name: "console-admin-cloud", type: "cloud" },
          admin,
        )
      ).id;
      selfHostedId = (
        await createEnvironment(
          { name: "console-admin-workers", type: "self_hosted" },
          admin,
        )
      ).id;
    }, 60_000);

    it("list + ?status= filter parse with the contracts schemas", async () => {
      const page = await listEnvironments({ status: "active" }, admin);
      const ids = page.data.map((e) => e.id);
      expect(ids).toContain(cloudId);
      expect(ids).toContain(selfHostedId);
    });

    it("detail parses; type is preserved", async () => {
      const env = await getEnvironment(selfHostedId, admin);
      expect(env.type).toBe("self_hosted");
      expect(env.status).toBe("active");
    });

    it("work-stats: an idle self-hosted queue answers the zero shape", async () => {
      const stats = await getWorkStats(selfHostedId, admin);
      expect(stats).toEqual({
        depth: 0,
        pending: 0,
        oldestQueuedAt: null,
        workersPolling: 0,
      });
    });
  });

  describe("vaults & credentials (C§13 §9.3: no secret in any read)", () => {
    let vaultId: string;

    beforeAll(async () => {
      vaultId = (await createVault({ name: "console-admin-vault" }, admin)).id;
      // Deliberately fake token — never a real-looking credential in a fixture.
      await addCredential(
        vaultId,
        {
          key: "https://api.example.com",
          category: "static_bearer",
          token: "test-token-not-a-secret",
        },
        admin,
      );
    }, 60_000);

    it("list + detail parse; the small collection does not page", async () => {
      const page = await listVaults(admin);
      expect(page.data.map((v) => v.id)).toContain(vaultId);
      expect(page.nextCursor).toBeNull();

      const vault = await getVault(vaultId, admin);
      expect(vault.name).toBe("console-admin-vault");
      expect(vault.status).toBe("active");
    });

    it("credential records carry NO sensitive field on the wire", async () => {
      const res = await admin.request(
        "GET",
        `/v1/vaults/${vaultId}/credentials`,
      );
      const raw = (await res.json()) as { data: Record<string, unknown>[] };
      expect(raw.data).toHaveLength(1);
      for (const field of [
        "token",
        "accessToken",
        "refreshToken",
        "clientSecret",
        "secretValue",
        "apiKey",
      ]) {
        expect(raw.data[0]).not.toHaveProperty(field);
      }
      // And the typed fetcher parses the same body with the contracts schema.
      const page = await listCredentials(vaultId, admin);
      expect(page.data[0]).toMatchObject({
        key: "https://api.example.com",
        category: "static_bearer",
        status: "active",
      });
    });
  });

  describe("api-keys", () => {
    it("lists the harness keys as records WITHOUT the raw key", async () => {
      const page = await listApiKeys(admin);
      const names = page.data.map((k) => k.name);
      expect(names).toContain("console-admin");
      expect(names).toContain("console-read");
      expect(page.nextCursor).toBeNull();

      const res = await admin.request("GET", "/v1/api-keys");
      const raw = (await res.json()) as { data: Record<string, unknown>[] };
      for (const record of raw.data) {
        expect(record).not.toHaveProperty("key");
      }
    });
  });

  describe("webhooks", () => {
    let webhookId: string;

    beforeAll(async () => {
      const created = await registerWebhook(
        {
          url: "https://hooks.example.com/pi-managed",
          eventTypes: ["session.status_idle", "job.run_failed"],
        },
        admin,
      );
      // Show-once: the signing secret exists ONLY in the create response.
      expect(created.signingSecret).toMatch(/^whsec_/);
      webhookId = created.id;
    }, 60_000);

    it("list + retrieve parse and never return the signing secret", async () => {
      const page = await listWebhooks(admin);
      expect(page.data.map((w) => w.id)).toContain(webhookId);

      const webhook = await getWebhook(webhookId, admin);
      expect(webhook.eventTypes).toContain("job.run_failed");

      const res = await admin.request("GET", `/v1/webhooks/${webhookId}`);
      const raw = (await res.json()) as Record<string, unknown>;
      expect(raw).not.toHaveProperty("signingSecret");
    });
  });

  describe("files & skills", () => {
    let fileId: string;

    beforeAll(async () => {
      // Seed one file through the real multipart route (the console itself
      // does not upload — see src/api/files-skills.ts — so the raw fetch
      // here is seeding, not the subject).
      const form = new FormData();
      form.append(
        "file",
        new Blob(["console contract fixture"], { type: "text/plain" }),
        "notes.txt",
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

    it("files list + metadata parse with the contracts schema", async () => {
      const page = await listFiles({}, admin);
      expect(page.data.map((f) => f.id)).toContain(fileId);

      const file = await getFile(fileId, admin);
      expect(file.name).toBe("notes.txt");
      expect(file.sizeBytes).toBeGreaterThan(0);
    });

    it("skills: empty list parses; missing id → DP-9 error facts", async () => {
      const page = await listSkills({}, admin);
      expect(page).toEqual({ data: [], nextCursor: null });

      const err: unknown = await admin
        .get(`/v1/skills/${MISSING_SKILL_ID}`, {
          parse: (x: unknown) => x,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe("not_found");
      expect(apiErr.requestId).toBeTruthy();
    });
  });

  describe("tenant", () => {
    it("GET /v1/tenant parses TenantInfo incl. quotaUsage vs quotaLimits", async () => {
      const tenant = await getTenant(admin);
      expect(tenant.tenantId).toBe(backend.tenantId);
      expect(tenant.quotaUsage.concurrentSessions).toBe(0);
      // The contracts quotaLimits addition round-trips the real plan envelope.
      expect(tenant.quotaLimits.concurrentSessions).toBeGreaterThan(0);
      expect(tenant.quotaLimits.monthlyTokenSpendUsd).toBeGreaterThan(0);
    });

    it("GET /v1/tenant/usage echoes effective bounds over an empty series", async () => {
      const usage = await getTenantUsage({ granularity: "day" }, admin);
      expect(usage.granularity).toBe("day");
      expect(usage.data).toEqual([]);
      expect(new Date(usage.from).getTime()).toBeLessThan(
        new Date(usage.to).getTime(),
      );
      expect(usage.groupBy).toBeUndefined();
    });
  });
});
