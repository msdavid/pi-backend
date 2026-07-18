// @vitest-environment node
/**
 * Session-messages contract tests (WP-C4.1; console-spec §10.1 seed): the
 * `listSessionMessages` fetcher against the REAL in-process backend over
 * real HTTP — real Postgres (testcontainer), real Fastify app, real global
 * `fetch`, a real cookie console session for the browser read path, and a
 * real `FilesystemObjectStore` behind the JSONL-backed `/messages` read
 * (CONVENTIONS.md "Fakes at the seam": the client↔server wire is the
 * subject, so both sides are real).
 *
 * Covers:
 *  - a fresh session (no log yet) → the empty list, parsed through the
 *    contracts envelope;
 *  - a seeded JSONL log → exactly the message-bearing entries, in log
 *    order, over the cookie-authed read (what the Conversation tab rides);
 *  - the forked-session seed boundary: the fork SHARES the parent's JSONL
 *    tree, so its `/messages` serves the inherited history — the claim the
 *    tab's fork microcopy makes.
 *
 * Run with `PI_REQUIRE_INTEGRATION=containers` so a missing container
 * runtime fails instead of silently skipping.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "@pi-managed/contracts";
import { fetchSessionRow, FilesystemObjectStore } from "@pi-managed/backend";

import { ConsoleApiClient } from "../client.js";
import { listSessionMessages } from "../conversation.js";
import { forkSession } from "../sessions.js";
import { seedSession as seedSessionAs, signInCookie } from "./collaborators.js";
import {
  requireContainers,
  startTestBackend,
  type TestBackend,
} from "./harness.js";

const RUNTIME = requireContainers("web-console session-messages contract suite");

describe.skipIf(!RUNTIME)("session messages ↔ real backend", () => {
  let backend: TestBackend;
  /** Bearer-authed admin client — seeding + the fork write. */
  let admin: ConsoleApiClient;
  /** Cookie-only client (read key) — the browser's read path. */
  let reader: ConsoleApiClient;
  let store: FilesystemObjectStore;

  const seedSession = (name: string): Promise<Session> =>
    seedSessionAs(admin, name);

  /** Write JSONL lines to a session's log object (the `/messages` source). */
  async function writeLog(sessionId: string, lines: object[]): Promise<void> {
    const row = await fetchSessionRow(
      backend.pool,
      { tenantId: backend.tenantId },
      sessionId,
    );
    const key = (row as { jsonl_object_key: string }).jsonl_object_key;
    const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
    const bytes = new TextEncoder().encode(text);
    await store.put(
      key,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  }

  beforeAll(async () => {
    store = new FilesystemObjectStore({
      root: mkdtempSync(join(tmpdir(), "pi-console-messages-jsonl-")),
    });
    backend = await startTestBackend({ app: { objectStore: store } });
    admin = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Authorization: `Bearer ${backend.adminKey}` },
    });
    // Real cookie sign-in with the read key — the browser's auth path.
    const cookie = await signInCookie(backend.baseUrl, backend.readKey);
    reader = new ConsoleApiClient({
      baseUrl: backend.baseUrl,
      headers: { Cookie: cookie },
    });
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.stop();
  }, 120_000);

  it("a fresh session (no log yet) answers the empty message list", async () => {
    const session = await seedSession("messages-empty");
    expect(await listSessionMessages(session.id, reader)).toEqual([]);
  });

  it("serves exactly the message-bearing entries, in log order, over the cookie read", async () => {
    const session = await seedSession("messages-seeded");
    // A realistic slice of a Pi session log (session-format): `message`
    // entries carry the AgentMessage; other entry kinds carry none.
    await writeLog(session.id, [
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-07-13T12:00:00Z",
        message: { role: "user", content: "Fix the login bug" },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-07-13T12:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "On it." }],
        },
      },
      // A non-message entry (e.g. a custom entry) MUST NOT surface.
      { type: "custom", id: "e3", parentId: "e2", timestamp: "2026-07-13T12:00:02Z" },
    ]);

    const messages = await listSessionMessages(session.id, reader);
    expect(messages).toEqual([
      { role: "user", content: "Fix the login bug" },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
    ]);
  });

  it(
    "forked-session seed boundary: the fork's /messages serves the shared history",
    { timeout: 30_000 },
    async () => {
      const parent = await seedSession("messages-fork-parent");
      await writeLog(parent.id, [
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: "2026-07-13T12:00:00Z",
          message: { role: "user", content: "inherited turn" },
        },
      ]);

      const fork = await forkSession(parent.id, admin);
      expect(fork.forkedFromSessionId).toBe(parent.id);

      // Pi-native tree fork: the JSONL is SHARED up to the fork point, so
      // both transcripts serve the same seed (the Conversation tab states
      // this boundary on forks).
      const inherited = [{ role: "user", content: "inherited turn" }];
      expect(await listSessionMessages(fork.id, reader)).toEqual(inherited);
      expect(await listSessionMessages(parent.id, reader)).toEqual(inherited);
    },
  );
});
