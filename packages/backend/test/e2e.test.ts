/**
 * E2E assembly test (WP-1.13) — the full HTTP path through the composed app.
 *
 * Exercises the real composition root (`createManagedApp`) against:
 *   - a real Postgres testcontainer (pool + migrations on boot),
 *   - a real filesystem object store,
 *   - the real `MicrosandboxProvider` on a KVM runner,
 *   - real Fastify bound to an ephemeral port (real HTTP `fetch`, not inject).
 *
 * The only seam mocked is the model `AgentSession` (a real provider key is not
 * available in CI): a canned brain that, on `user.message`, writes a file into
 * the live sandbox via the real `MicrosandboxProvider.exec`. Everything else —
 * auth, tenant/api-key, agents/environments/sessions/events/files routes, the
 * `SessionManager` registry, the `ManagedSessionRuntime` state machine, SSE
 * streaming, sandbox lifecycle — is real.
 *
 * Gating: the whole suite skips cleanly unless `/dev/kvm` + the msb runtime are
 * present AND a container runtime is available for Postgres. `pnpm test` stays
 * green on non-KVM/dev machines.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import {
  createManagedApp,
  type ManagedApp,
  SessionManager,
} from "../src/app.js";
import { MicrosandboxProvider } from "../src/infra/sandbox/provider.js";
import { loadConfig } from "../src/infra/config/index.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../src/infra/db/__tests__/test-runtime.js";
import { createTenant, issueApiKey } from "../src/index.js";
import type {
  AgentSessionFactory,
  AgentSessionLike,
  AgentSessionEventLike,
  CreateAgentSessionOptions,
} from "../src/domain/session-manager/types.js";
import type { SandboxProvider } from "../src/domain/ports.js";
import { kvmRuntimeAvailable } from "../src/infra/sandbox/__tests__/kvm-gate.js";

const SUITE = "E2E: composed app (@kvm) — real microVM + Postgres";

/**
 * Capability gates. Both hard-fail (instead of skipping) under
 * `PI_REQUIRE_INTEGRATION` — see `src/infra/sandbox/__tests__/kvm-gate.ts` and
 * `src/infra/db/__tests__/test-runtime.ts` (R1.2).
 */
const KVM = kvmRuntimeAvailable(SUITE);
const CONTAINER = hasContainerRuntime(SUITE);
const RUN = KVM && CONTAINER;

/** Generous timeouts — ubuntu:22.04 boot + multiple turns can take minutes. */
const BOOT_TIMEOUT = 300_000;
const STEP_TIMEOUT = 600_000;

/**
 * Canned brain factory. On each `prompt(content)` it writes/appends a file in
 * the live sandbox via the real provider, then emits a buffered `agent.message`.
 * The handle is read from the live runtime via the {@link SessionManager}
 * (populated by `wake()` before the first turn runs).
 */
class MockBrainFactory implements AgentSessionFactory {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly getManager: () => SessionManager | undefined,
  ) {}

  async create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    const sessionId = basename(dirname(options.localJsonlPath));
    let listener: ((event: AgentSessionEventLike) => void) | undefined;
    let turns = 0;
    const provider = this.provider;
    const getManager = this.getManager;

    return {
      sessionId,
      sessionFile: options.localJsonlPath,
      isStreaming: false,
      async prompt(_content: string) {
        const handle = getManager()?.getRuntime(sessionId)?.sandboxHandle;
        if (!handle) {
          throw new Error("mock brain: no sandbox handle (wake() did not provision?)");
        }
        turns += 1;
        // First turn writes "hello world"; subsequent turns append " again".
        const cmd =
          turns === 1
            ? "mkdir -p /mnt/session/outputs && printf 'hello world' > /mnt/session/outputs/hello.txt"
            : "printf ' again' >> /mnt/session/outputs/hello.txt";
        await provider.exec(handle, { cmd });
        // Surface a buffered assistant message so the SSE stream carries an
        // agent.message frame alongside the lifecycle events.
        listener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "done" },
        });
        listener?.({ type: "message_end" });
      },
      async steer() {
        /* noop */
      },
      async followUp() {
        /* noop */
      },
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async abort() {
        /* noop */
      },
      dispose() {
        /* noop */
      },
      getEntries() {
        return [];
      },
    };
  }
}

describe.skipIf(!RUN)("E2E: composed app (WP-1.13, @kvm)", () => {
  let db: TestDb;
  let managed: ManagedApp;
  let provider: MicrosandboxProvider;
  let baseUrl: string;
  let apiKey: string;
  let objectStoreDir: string;

  beforeAll(async () => {
    db = await startPostgres();
    objectStoreDir = mkdtempSync(join(tmpdir(), "pi-e2e-obj-"));
    const config = loadConfig({
      env: {
        DB_URL: db.connectionString,
        OBJECT_STORE_ROOT: objectStoreDir,
        SANDBOX_RUNTIME: "enabled",
        LOG_LEVEL: "error",
      },
    });
    provider = new MicrosandboxProvider();
    const holder: { mgr?: SessionManager } = {};
    const factory = new MockBrainFactory(provider, () => holder.mgr);
    managed = await createManagedApp({
      config,
      logger: pino({ level: "error" }),
      objectStoreConfig: { kind: "filesystem", root: objectStoreDir },
      sandboxProvider: provider,
      factory,
    });
    holder.mgr = managed.sessionManager;

    // Bind a real port (full HTTP path via fetch, including SSE).
    await managed.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = managed.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const tenant = await createTenant(managed.pool, { name: "e2e-tenant" });
    const issued = await issueApiKey(
      managed.pool,
      { tenantId: tenant.id },
      { name: "e2e-key" },
    );
    apiKey = issued.key;
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    // Best-effort: destroy the provisioned sandbox so KVM VMs don't leak.
    try {
      for (const id of sessionIdCleanup) {
        const handle = managed?.sessionManager?.getRuntime(id)?.sandboxHandle;
        if (handle) await provider?.destroy(handle).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
    if (managed) await managed.close().catch(() => {});
    if (db) await db.container.stop().catch(() => {});
  });

  /** Track session ids whose sandboxes we must destroy in afterAll. */
  const sessionIdCleanup: string[] = [];

  /** Authenticated JSON fetch helper. */
  async function api(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  /**
   * Last SSE `id:` seen per session, carried across {@link waitForIdle} calls.
   * Each call opens a FRESH connection, and without `Last-Event-ID` the events
   * route replays the full history from position 0 — so a second waitForIdle
   * would return on the REPLAYED `session.status_idle` of the previous turn
   * and race the still-processing one. Resuming after the last seen id keeps
   * every wait anchored to events this test has not observed yet.
   */
  const lastSeenEventId = new Map<string, number>();

  /** Read the SSE stream until a `session.status_idle` frame arrives. */
  async function waitForIdle(
    sessionId: string,
    timeoutMs = 180_000,
  ): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${apiKey}`,
      };
      const resumeAfter = lastSeenEventId.get(sessionId);
      if (resumeAfter !== undefined) {
        headers["last-event-id"] = String(resumeAfter);
      }
      const res = await fetch(`${baseUrl}/v1/sessions/${sessionId}/stream`, {
        headers,
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const id = /^id:\s*(\d+)/m.exec(frame);
          if (id) lastSeenEventId.set(sessionId, Number(id[1]));
          if (/^event:\s*session\.status_idle/m.test(frame)) return;
        }
      }
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  it(
    "full lifecycle: agent → environment → session → message → outputs → resume → fork",
    async () => {
      // 1. Create agent.
      const agentRes = await api("POST", "/v1/agents", {
        idempotencyKey: "e2e-agent",
        body: {
          name: "e2e-agent",
          model: { provider: "anthropic", id: "claude-sonnet-4" },
          systemPrompt: "You write files.",
          tools: {
            defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
            configs: {},
          },
          skills: [],
          extensions: [],
          mcpServers: [],
          multiagent: { roster: [] },
          metadata: {},
        },
      });
      expect(agentRes.status).toBe(201);
      const agent = await agentRes.json();

      // 2. Create environment (ubuntu:22.04; long idle timeout so the sandbox
      //    stays running while we fetch outputs).
      const envRes = await api("POST", "/v1/environments", {
        idempotencyKey: "e2e-env",
        body: {
          name: "e2e-env",
          type: "cloud",
          image: "ubuntu:22.04",
          resources: { cpus: 1, memoryMiB: 512, diskMiB: 10240 },
          networking: { mode: "unrestricted" },
          packages: [],
          mounts: [],
          idleTimeout: 3600,
        },
      });
      expect(envRes.status).toBe(201);
      const env = await envRes.json();

      // 3. Create session (lazy sandbox — no work yet).
      const sessRes = await api("POST", "/v1/sessions", {
        idempotencyKey: "e2e-sess",
        body: { agent: agent.id, environmentId: env.id, title: "e2e" },
      });
      expect(sessRes.status).toBe(201);
      const sess = await sessRes.json();
      sessionIdCleanup.push(sess.id);
      expect(sess.status).toBe("idle");

      // 4. Send user.message → agent writes hello.txt → idle.
      const msgRes = await api("POST", `/v1/sessions/${sess.id}/events`, {
        idempotencyKey: "e2e-msg-1",
        body: {
          type: "user.message",
          content: "write 'hello world' to /mnt/session/outputs/hello.txt",
        },
      });
      expect(msgRes.status).toBe(202);

      // 5. Stream until session.status_idle.
      await waitForIdle(sess.id);

      // 6. Fetch outputs → hello.txt exists with the right content.
      const outRes = await api("GET", `/v1/sessions/${sess.id}/outputs`);
      expect(outRes.status).toBe(200);
      const outputs = await outRes.json();
      expect(outputs.data.map((o: { name: string }) => o.name)).toContain(
        "hello.txt",
      );
      const dlRes = await fetch(
        `${baseUrl}/v1/sessions/${sess.id}/outputs/hello.txt`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      expect(dlRes.status).toBe(200);
      expect(await dlRes.text()).toBe("hello world");

      // 7. Resume: append " again" → idle → content is now "hello world again".
      const msg2Res = await api("POST", `/v1/sessions/${sess.id}/events`, {
        idempotencyKey: "e2e-msg-2",
        body: { type: "user.message", content: "append ' again'" },
      });
      expect(msg2Res.status).toBe(202);
      await waitForIdle(sess.id);
      const dl2Res = await fetch(
        `${baseUrl}/v1/sessions/${sess.id}/outputs/hello.txt`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      expect(dl2Res.status).toBe(200);
      expect(await dl2Res.text()).toBe("hello world again");

      // 8. Fork — new session sharing the JSONL tree up to the fork point.
      const forkRes = await api("POST", `/v1/sessions/${sess.id}/fork`, {
        idempotencyKey: "e2e-fork",
        body: {},
      });
      expect(forkRes.status).toBe(201);
      const forked = await forkRes.json();
      expect(forked.id).not.toBe(sess.id);
      expect(forked.forkedFromSessionId).toBe(sess.id);
    },
    STEP_TIMEOUT,
  );
});
