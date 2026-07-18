// @vitest-environment node
/**
 * Contract tests for the WP-C3.3 vault mutations — `src/api/vaults.ts`
 * against the REAL in-process backend (CONVENTIONS.md "Fakes at the seam":
 * both sides real — testcontainers Postgres, the real Fastify app on an
 * ephemeral port, real global `fetch`). Read-path coverage lives in
 * `admin-families.contract.test.ts`; this suite covers create vault, add
 * credential per category, validate, archive-credential (secret purged, key
 * freed — §12.7), archive vault (cascade), and hard delete.
 *
 * Validate (§12.5) is exercised DETERMINISTICALLY, no external network:
 * - `environment_variable` has no remote to probe → always `unknown`;
 * - `static_bearer` probes the credential key (the server URL), so keys
 *   pointing at the harness backend itself pin the outcome: the public
 *   `/healthz` (always `200 ok`; `/readyz` is 503 here — the harness wires
 *   no sandbox/object-store readiness) → `valid`; an authed route with a
 *   garbage bearer answers 401 → `invalid`.
 *
 * SECRETS (C§13): every secret in this file is an obviously-fake
 * placeholder; responses are asserted to never carry one back.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import {
  addCredential,
  archiveVault,
  createVault,
  deleteCredential,
  deleteVault,
  getVault,
  listCredentials,
  validateCredential,
} from "../vaults.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console vaults contract suite");

describe.skipIf(!RUNTIME)("vault mutations ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;
  let vaultId: string;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    const vault = await createVault({ name: "console-vaults-wp" }, admin);
    expect(vault.status).toBe("active");
    vaultId = vault.id;
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("adds one credential per category; records come back without secrets", async () => {
    const provider = await addCredential(
      vaultId,
      {
        key: "anthropic",
        category: "model_provider_key",
        apiKey: "test-placeholder-not-a-key",
      },
      admin,
    );
    expect(provider).toMatchObject({
      vaultId,
      key: "anthropic",
      category: "model_provider_key",
      status: "active",
    });

    await addCredential(
      vaultId,
      {
        key: "GIT_TOKEN",
        category: "environment_variable",
        secretValue: "test-placeholder-not-a-secret",
      },
      admin,
    );

    // The §12.4 write-only invariant, on the raw wire after several writes.
    const res = await admin.request("GET", `/v1/vaults/${vaultId}/credentials`);
    const raw = (await res.json()) as { data: Record<string, unknown>[] };
    expect(raw.data.length).toBeGreaterThanOrEqual(2);
    for (const record of raw.data) {
      for (const field of [
        "token",
        "accessToken",
        "refreshToken",
        "clientSecret",
        "secretValue",
        "apiKey",
      ]) {
        expect(record).not.toHaveProperty(field);
      }
    }
  });

  it("duplicate key in the same vault → 409 conflict (§12.4)", async () => {
    const err: unknown = await addCredential(
      vaultId,
      {
        key: "anthropic",
        category: "model_provider_key",
        apiKey: "test-placeholder-not-a-key",
      },
      admin,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect((err as ConsoleApiError).status).toBe(409);
  });

  describe("validate (§12.5) — deterministic outcomes", () => {
    it("environment_variable has no remote to probe → unknown", async () => {
      const { status } = await validateCredential(vaultId, "GIT_TOKEN", admin);
      expect(status).toBe("unknown");
    });

    it("static_bearer probing a live endpoint (the harness /healthz) → valid", async () => {
      await addCredential(
        vaultId,
        {
          key: `${backend.baseUrl}/healthz`,
          category: "static_bearer",
          token: "test-placeholder-bearer",
        },
        admin,
      );
      const { status } = await validateCredential(
        vaultId,
        `${backend.baseUrl}/healthz`,
        admin,
      );
      expect(status).toBe("valid");
    });

    it("static_bearer whose grant the server rejects (401) → invalid", async () => {
      await addCredential(
        vaultId,
        {
          key: `${backend.baseUrl}/v1/vaults`,
          category: "static_bearer",
          token: "test-placeholder-rejected-bearer",
        },
        admin,
      );
      const { status } = await validateCredential(
        vaultId,
        `${backend.baseUrl}/v1/vaults`,
        admin,
      );
      expect(status).toBe("invalid");
    });
  });

  it("archiving a credential purges the secret; the key stays reserved", async () => {
    await deleteCredential(vaultId, "GIT_TOKEN", admin);

    // The record remains, archived (audit trail, §12.7)…
    const afterDelete = await listCredentials(vaultId, admin);
    expect(
      afterDelete.data.find(
        (c) => c.key === "GIT_TOKEN" && c.status === "archived",
      ),
    ).toBeDefined();

    // …and — DOC GAP vs api-reference §12.7 "freed for a replacement": the
    // `(vault_id, key)` unique index (008) has no status filter, so
    // re-adding the archived key answers `409 conflict`. Surfaced to a
    // backend-lane WP; the console copy states the reserved-key reality.
    const err: unknown = await addCredential(
      vaultId,
      {
        key: "GIT_TOKEN",
        category: "environment_variable",
        secretValue: "test-placeholder-rotated-secret",
      },
      admin,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsoleApiError);
    expect((err as ConsoleApiError).status).toBe(409);
  });

  it("archive vault cascades: all credentials archived (§12.7)", async () => {
    const archived = await archiveVault(vaultId, admin);
    expect(archived.status).toBe("archived");

    const vault = await getVault(vaultId, admin);
    expect(vault.status).toBe("archived");

    const credentials = await listCredentials(vaultId, admin);
    expect(credentials.data.length).toBeGreaterThan(0);
    for (const record of credentials.data) {
      expect(record.status).toBe("archived");
    }
  });

  it("hard delete removes the vault outright with DP-9 error facts on reads", async () => {
    const doomed = await createVault({ name: "console-vaults-doomed" }, admin);
    await deleteVault(doomed.id, admin);

    const err: unknown = await getVault(doomed.id, admin).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConsoleApiError);
    const apiErr = err as ConsoleApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.requestId).toBeTruthy();
  });
});
