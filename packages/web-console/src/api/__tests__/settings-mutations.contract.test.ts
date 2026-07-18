// @vitest-environment node
/**
 * WP-C3.4 contract tests — the API-keys and webhooks MUTATION paths against
 * the REAL in-process backend (CONVENTIONS.md "Fakes at the seam": both sides
 * real — testcontainers Postgres, the real Fastify app on an ephemeral port,
 * real global `fetch`). Read-path coverage for these families lives in
 * `admin-families.contract.test.ts` (WP-C3-prep).
 *
 * The wire invariants the §9.7/§9.8 screens depend on, proven end-to-end:
 * issue defaults to `["read"]` (opt-up), the raw key exists ONLY in the
 * create response, a revoked key 401s immediately (the console-session death
 * the DP-7 dialog names), the `whsec_` secret exists ONLY in the register
 * response, and test-delivery reports honest delivery state.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleApiClient, ConsoleApiError } from "../client.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../api-keys.js";
import {
  deleteWebhook,
  getWebhook,
  registerWebhook,
  testWebhook,
} from "../webhooks.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console settings-mutations contract suite");

describe.skipIf(!RUNTIME)("api-keys + webhooks mutations ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed client (admin scope) — an init override, not a transport fake. */
  let admin: ConsoleApiClient;

  beforeAll(async () => {
    backend = await startTestBackend();
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
  }, 120_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  describe("api-keys (§9.7, W9)", () => {
    it("issue defaults to [read] when no scopes are passed (opt-up, never opt-out)", async () => {
      const issued = await issueApiKey({ name: "wp-c34-default" }, admin);
      expect(issued.scopes).toEqual(["read"]);
      expect(issued.key).toMatch(/^pmb_/);
    });

    it("issue → authenticate → revoke → 401: the raw key exists only in the create response and dies with revocation", async () => {
      const issued = await issueApiKey(
        { name: "wp-c34-roundtrip", scopes: ["read", "write"] },
        admin,
      );
      expect(issued.scopes).toEqual(["read", "write"]);

      // The list shows the record — never the raw key (show-once, DP-8).
      const page = await listApiKeys(admin);
      const record = page.data.find((k) => k.id === issued.id);
      expect(record).toMatchObject({ name: "wp-c34-roundtrip" });
      expect(record).not.toHaveProperty("key");
      expect(record?.revokedAt).toBeUndefined();

      // The issued key authenticates…
      const issuedClient = new ConsoleApiClient({
        baseUrl: backend.baseUrl,
        headers: { Authorization: `Bearer ${issued.key}` },
      });
      await expect(listApiKeys(issuedClient)).resolves.toMatchObject({
        nextCursor: null,
      });

      // …until revoked, after which it 401s immediately — the consequence
      // the DP-7 dialog names (console sessions riding the key die too:
      // console-session resolution joins api_keys and fails on revoked_at).
      await revokeApiKey(issued.id, admin);
      const err: unknown = await listApiKeys(issuedClient).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConsoleApiError);
      expect((err as ConsoleApiError).status).toBe(401);

      // The record survives as terminal state for the list's revoked chip.
      const after = await listApiKeys(admin);
      expect(
        after.data.find((k) => k.id === issued.id)?.revokedAt,
      ).toBeTruthy();
    });
  });

  describe("webhooks (§9.8, W13)", () => {
    it("register → whsec_ once → test-delivery reports honest state → delete removes it", async () => {
      // `.invalid` is reserved (RFC 2606): guaranteed non-resolvable, so the
      // test delivery is deterministic without leaving the host.
      const created = await registerWebhook(
        {
          url: "https://wp-c34.invalid/hook",
          eventTypes: ["session.status_idle", "job.run_failed"],
        },
        admin,
      );
      expect(created.signingSecret).toMatch(/^whsec_/);
      expect(created.status).toBe("active");

      // Retrieve never returns the secret (show-once).
      const fetched = await getWebhook(created.id, admin);
      expect(fetched).not.toHaveProperty("signingSecret");

      // Send-test before trusting (W13): an unreachable endpoint reports
      // not-delivered with no response code — the UI renders exactly that.
      const result = await testWebhook(created.id, admin);
      expect(result.delivered).toBe(false);
      expect(result.responseCode).toBeUndefined();

      // Delete (the §9.8 re-enable path's first half) removes the endpoint.
      await deleteWebhook(created.id, admin);
      const err: unknown = await getWebhook(created.id, admin).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConsoleApiError);
      expect((err as ConsoleApiError).status).toBe(404);
    }, 60_000);
  });
});
