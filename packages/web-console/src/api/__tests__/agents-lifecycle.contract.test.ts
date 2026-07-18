// @vitest-environment node
/**
 * WP-C3.1 contract tests: the agents WRITE lifecycle the console management
 * surface drives (console-spec §9.1, journey W10) against the REAL
 * in-process backend (CONVENTIONS.md "Fakes at the seam") — create, PATCH
 * (creates immutable version n+1; running sessions keep theirs), archive
 * (terminal, idempotent, still readable — the console renders archived
 * detail read-only). Read-path coverage lives in
 * `admin-families.contract.test.ts`.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  archiveAgent,
  createAgent,
  getAgent,
  getAgentVersion,
  listAgentVersions,
  updateAgent,
} from "../agents.js";
import { issueApiKey } from "../api-keys.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console agents-lifecycle contract suite");

describe.skipIf(!RUNTIME)("agents lifecycle client ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed clients — an init override, not a transport fake. */
  let admin: ConsoleApiClient;
  let read: ConsoleApiClient;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    read = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.readKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("create → PATCH → archive round-trip with the version bump the UI narrates", async () => {
    const created = await createAgent(
      {
        name: "lifecycle-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        systemPrompt: "Review with care.",
        tools: {
          defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
          configs: { bash: { permissionPolicy: "always_ask" } },
        },
      },
      admin,
    );
    expect(created.currentVersion).toBe(1);
    expect(created.status).toBe("active");

    // PATCH a subset: creates version 2; omitted fields keep their value
    // (backend field-level merge) — the edit dialog's promise.
    const updated = await updateAgent(
      created.id,
      { systemPrompt: "Review faster." },
      admin,
    );
    expect(updated.currentVersion).toBe(2);
    expect(updated.config?.systemPrompt).toBe("Review faster.");
    expect(updated.config?.model.id).toBe("claude-sonnet-4");
    expect(updated.config?.tools?.configs.bash?.permissionPolicy).toBe(
      "always_ask",
    );

    // Version history: newest first, both immutable configs retrievable.
    const versions = await listAgentVersions(created.id, {}, admin);
    expect(versions.data.map((v) => v.version)).toEqual([2, 1]);
    const v1 = await getAgentVersion(created.id, 1, admin);
    expect(v1.config.systemPrompt).toBe("Review with care.");
    const v2 = await getAgentVersion(created.id, 2, admin);
    expect(v2.config.systemPrompt).toBe("Review faster.");

    // Archive: terminal…
    const archived = await archiveAgent(created.id, admin);
    expect(archived.status).toBe("archived");
    // …idempotent (a second archive returns the archived resource)…
    const again = await archiveAgent(created.id, admin);
    expect(again.status).toBe("archived");
    // …still readable (the console renders archived detail read-only)…
    const detail = await getAgent(created.id, admin);
    expect(detail.status).toBe("archived");
    expect(detail.currentVersion).toBe(2);
    // …and read-only: a PATCH now 409s with the machine code the UI maps.
    const patchArchived = await updateAgent(
      created.id,
      { systemPrompt: "no" },
      admin,
    ).catch((error: unknown) => error);
    expect(patchArchived).toBeInstanceOf(ConsoleApiError);
    expect((patchArchived as ConsoleApiError).status).toBe(409);
    expect((patchArchived as ConsoleApiError).code).toBe("resource_archived");
  });

  it("create validation is the shared contracts schema (422 from the same zod shape)", async () => {
    const invalid = await createAgent(
      // Violates the contracts `Name` charset — the same schema the form
      // validates with client-side, so the console never gets this far.
      {
        name: "no/slashes",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      admin,
    ).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(ConsoleApiError);
    expect((invalid as ConsoleApiError).status).toBe(422);
  });

  it("agent mutations require the write scope (§6.2): read is denied 403", async () => {
    const denied = await createAgent(
      {
        name: "read-cannot-create",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      read,
    ).catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ConsoleApiError);
    expect((denied as ConsoleApiError).status).toBe(403);
  });

  it("a write-scoped key CAN mutate (§6.2 — write, not admin, is the bar the UI gates on)", async () => {
    // Issued through the real admin surface, then used end-to-end: the exact
    // key shape the console's canWrite() gating promises can create agents.
    const issued = await issueApiKey(
      { name: "write-can-create", scopes: ["read", "write"] },
      admin,
    );
    const writer = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${issued.key}` },
    });
    const created = await createAgent(
      {
        name: "created-by-write-key",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
      },
      writer,
    );
    expect(created.status).toBe("active");
    // …and the write key can read its creation back (["read", "write"]).
    const fetched = await getAgent(created.id, writer);
    expect(fetched.name).toBe("created-by-write-key");
  });
});
