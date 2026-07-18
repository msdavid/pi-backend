// @vitest-environment node
/**
 * Phase-4 gate — the implementation plan's gate flow, scripted (`@kvm`):
 * "on a machine with no Pi: wake idle session, multi-turn conversation incl.
 * one requires_action answer + one interrupt, hand back to CLI with state
 * intact."
 *
 * **How real this is.** The full production composition boots:
 * `createManagedApp` (the deployment factory) with a real Postgres
 * testcontainer, real migrations, a real filesystem object store, the REAL
 * `SessionManager` → `ManagedSessionRuntime`, and the REAL
 * `MicrosandboxProvider` — the first `user.message` to the idle session
 * cold-provisions an actual microVM on this host's KVM. Every request in
 * the flow crosses the real Fastify routes over real HTTP through the
 * console's own client (cookie console session + CSRF + auto
 * Idempotency-Key — exactly what the browser sends).
 *
 * **The one collaborator.** The model brain (`AgentSessionFactory`) is
 * scripted — a real agent turn would spend a live model-provider key, which
 * neither CI nor this repo's fixtures may hold (CONVENTIONS.md §4.2). The
 * stand-in stands behind the SAME documented factory seam the production
 * `PiAgentSessionFactory` implements, and it exercises the runtime the way
 * Pi does: it registers the managed extensions off the material it is
 * handed (the production permission-gate wiring — same mechanics as
 * `backend/src/domain/session-manager/__tests__/permission-gate-roundtrip`),
 * invokes the captured `tool_call` hook for the `always_ask` tool so the
 * REAL confirmation coordinator drives `requires_action`, appends its turns
 * to the session's REAL local JSONL (which the runtime's JsonlSync pushes to
 * the object store — the durable state `/remote:resume` and `/messages`
 * read), and resolves its in-flight prompt on `abort()` as Pi does under
 * interrupt.
 *
 * What remains genuinely manual (no way to script "no Pi installed" +
 * a human phone) is listed in this gate's README.
 *
 * Gating: KVM + msb runtime AND a container runtime, else a loud skip
 * (hard failure under `PI_REQUIRE_INTEGRATION=kvm` / `containers`
 * respectively — `./helpers.ts`, `src/api/__tests__/harness.ts`).
 */
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, Environment, Session } from "@pi-managed/contracts";
import {
  createLogger,
  createManagedApp,
  createTenant,
  issueApiKey,
  loadConfig,
  type AgentSessionEventLike,
  type AgentSessionFactory,
  type AgentSessionLike,
  type CreateAgentSessionOptions,
  type ManagedApp,
} from "@pi-managed/backend";

import { ConsoleApiClient } from "../../src/api/client.js";
import { listSessionMessages } from "../../src/api/conversation.js";
import { sendSessionEvent } from "../../src/api/session-events.js";
import { getSession } from "../../src/api/sessions.js";
import { streamSessionEvents, type SseFrame } from "../../src/api/stream.js";
import { signInCookie } from "../../src/api/__tests__/collaborators.js";
import { requireContainers } from "../../src/api/__tests__/harness.js";
import { kvmRuntimeAvailable } from "./helpers.js";

const SUITE = "phase-4 gate: continue-anywhere flow (@kvm)";
const KVM = kvmRuntimeAvailable(SUITE);
const CONTAINERS = requireContainers(SUITE);
const RUN = KVM && CONTAINERS;

/** microVM boot + cold wake can take minutes on a cold image cache. */
const BOOT_TIMEOUT = 300_000;
const STEP_TIMEOUT = 600_000;

type ToolCallHandler = (event: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<unknown> | unknown;

/**
 * The scripted brain. Each `prompt()` shifts one step off {@link script}
 * and drives the REAL runtime exactly where Pi would:
 *  - `reply`: append user + assistant entries to the real local JSONL and
 *    resolve (a completed turn);
 *  - `gated`: first run the registered `tool_call` hooks for `bash` (an
 *    `always_ask` tool) — the REAL confirmation coordinator blocks the turn
 *    as `requires_action` until the operator's `user.tool_confirmation` —
 *    then append and resolve;
 *  - `hang`: append the user entry and stay in flight until `abort()`
 *    (the interrupt path) resolves it, as Pi's abort does.
 */
class ScriptedBrain implements AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  isStreaming = false;
  readonly script: Array<"reply" | "gated" | "hang"> = [];
  /** `tool_call` hooks registered by the material's extension factories. */
  private readonly toolCallHandlers: ToolCallHandler[] = [];
  private listener: ((event: AgentSessionEventLike) => void) | undefined;
  private abortResolve: (() => void) | undefined;
  private entrySeq = 0;
  private lastEntryId: string | null = null;
  private readonly jsonlPath: string;

  constructor(options: CreateAgentSessionOptions) {
    this.jsonlPath = options.localJsonlPath;
    this.sessionId = options.localJsonlPath;
    this.sessionFile = options.localJsonlPath;
    // Register the managed extensions the way Pi's resource loader does —
    // the permission gate's `tool_call` hook is what makes requires_action
    // REAL in this flow (same registration mechanics as the backend's
    // permission-gate round-trip suite).
    const handlers = this.toolCallHandlers;
    const pi = new Proxy(
      {
        on: (event: string, handler: unknown): void => {
          if (event === "tool_call") handlers.push(handler as ToolCallHandler);
        },
      } as Record<string, unknown>,
      { get: (target, prop: string) => target[prop] ?? (() => undefined) },
    );
    for (const factory of options.material.extensionFactories ?? []) {
      (factory as unknown as (api: unknown) => void)(pi);
    }
  }

  /** Append one Pi session-format `message` entry to the REAL local log. */
  private appendMessage(role: string, content: unknown): void {
    this.entrySeq += 1;
    const id = `gate_e${this.entrySeq}`;
    mkdirSync(dirname(this.jsonlPath), { recursive: true });
    appendFileSync(
      this.jsonlPath,
      `${JSON.stringify({
        type: "message",
        id,
        parentId: this.lastEntryId,
        timestamp: new Date().toISOString(),
        message: { role, content },
      })}\n`,
    );
    this.lastEntryId = id;
  }

  async prompt(content: string): Promise<void> {
    const step = this.script.shift() ?? "reply";
    this.appendMessage("user", content);
    if (step === "hang") {
      await new Promise<void>((resolve) => {
        this.abortResolve = resolve;
      });
      return;
    }
    if (step === "gated") {
      // Pi runs every registered `tool_call` hook before executing a tool;
      // the gate's hook suspends here until the operator answers. The id is
      // the blocking event id the client round-trips (`evt_` per the wire
      // contract's `eventId`).
      expect(this.toolCallHandlers.length).toBeGreaterThan(0);
      for (const handler of this.toolCallHandlers) {
        await handler({
          toolCallId: `evt_gate_tc${this.entrySeq}`,
          toolName: "bash",
          input: { command: "rm -rf build/" },
        });
      }
    }
    this.appendMessage("assistant", [
      { type: "text", text: `ack: ${content}` },
    ]);
    this.listener?.({ type: "message_end" } as AgentSessionEventLike);
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(listener: (event: AgentSessionEventLike) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async abort(): Promise<void> {
    this.abortResolve?.();
    this.abortResolve = undefined;
  }
  dispose(): void {}
  getEntries(): never[] {
    return [];
  }
}

class ScriptedBrainFactory implements AgentSessionFactory {
  last: ScriptedBrain | undefined;
  create(options: CreateAgentSessionOptions): Promise<AgentSessionLike> {
    this.last = new ScriptedBrain(options);
    return Promise.resolve(this.last as unknown as AgentSessionLike);
  }
}

describe.skipIf(!RUN)("phase-4 gate — W5 continue-anywhere flow (@kvm)", () => {
  let db: StartedPostgreSqlContainer;
  let managed: ManagedApp;
  let baseUrl: string;
  let cookie: string;
  /** Cookie console client for the writing browser user (real CSRF path). */
  let writer: ConsoleApiClient;
  let session: Session;
  const factory = new ScriptedBrainFactory();

  beforeAll(async () => {
    process.env.ALLOW_EPHEMERAL_VAULT_KEY ??= "true";
    db = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("pitest")
      .withUsername("pitest")
      .withPassword("pitest")
      .start();
    const objectStoreDir = mkdtempSync(join(tmpdir(), "pi-gate-w5-obj-"));
    const config = loadConfig({
      env: {
        DB_URL: db.getConnectionUri(),
        OBJECT_STORE_ROOT: objectStoreDir,
        SANDBOX_RUNTIME: "enabled", // → the REAL MicrosandboxProvider
        // Local JSONL staging dir (defaults to ./data/sessions — keep test
        // artifacts out of the repo tree).
        PI_SESSION_LOCAL_DIR: mkdtempSync(join(tmpdir(), "pi-gate-w5-jsonl-")),
        LOG_LEVEL: "error",
      },
    });
    managed = await createManagedApp({
      config,
      logger: createLogger(config),
      objectStoreConfig: { kind: "filesystem", root: objectStoreDir },
      factory,
    });
    await managed.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = managed.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const tenant = await createTenant(managed.pool, { name: "gate-w5" });
    const apiKey = (
      await issueApiKey(
        managed.pool,
        { tenantId: tenant.id },
        { name: "gate-w5-admin", scopes: ["admin"] },
      )
    ).key;
    const admin = new ConsoleApiClient({
      baseUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // The browser's auth: a real cookie console session (+ CSRF on writes).
    cookie = await signInCookie(baseUrl, apiKey);
    writer = new ConsoleApiClient({ baseUrl, headers: { Cookie: cookie } });

    // Seed agent (bash = always_ask → the REAL permission gate arms) +
    // a small real-VM environment + one idle session, via the public API.
    const agent = await admin.post(
      "/v1/agents",
      {
        name: "gate-w5-agent",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        tools: {
          defaultConfig: { enabled: true, permissionPolicy: "always_allow" },
          configs: { bash: { enabled: true, permissionPolicy: "always_ask" } },
        },
      },
      Agent,
    );
    const env = await admin.post(
      "/v1/environments",
      {
        name: "gate-w5-env",
        type: "cloud",
        image: "ubuntu:22.04",
        resources: { cpus: 1, memoryMiB: 512, diskMiB: 10240 },
        networking: { mode: "unrestricted" },
        idleTimeout: 3600,
      },
      Environment,
    );
    session = await admin.post(
      "/v1/sessions",
      { agent: agent.id, environmentId: env.id, title: "gate-w5" },
      Session,
    );
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    // Destroy the real microVM so KVM sandboxes don't leak.
    try {
      const handle = managed?.sessionManager?.getRuntime(
        session?.id ?? "",
      )?.sandboxHandle;
      if (handle) await managed.sandboxProvider?.destroy(handle);
    } catch {
      /* best-effort */
    }
    if (managed) await managed.close().catch(() => {});
    if (db) await db.stop().catch(() => {});
  }, BOOT_TIMEOUT);

  /** Poll the detail read (the console's refetch) for a settled state. */
  async function untilSession(
    predicate: (s: Session) => boolean,
    timeoutMs = STEP_TIMEOUT,
  ): Promise<Session> {
    const start = Date.now();
    for (;;) {
      const s = await getSession(session.id, writer);
      if (predicate(s)) return s;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `session never reached the expected state (status=${s.status}, ` +
            `stopReason=${String(s.stopReason)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Poll `/messages` until it reflects the synced JSONL (see above). */
  async function untilMessages(
    predicate: (messages: unknown[]) => boolean,
    timeoutMs = 30_000,
  ): Promise<unknown[]> {
    const start = Date.now();
    for (;;) {
      const messages = await listSessionMessages(session.id, writer);
      if (predicate(messages)) return messages;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `/messages never reflected the synced JSONL (${messages.length} messages)`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Read the persisted event story the way the console's stream does: a
   * fresh SSE connection replays the projection from position 0; collect
   * until `enough` says stop (or the stream idles out), then abort.
   */
  async function replayFrames(
    enough: (frames: SseFrame[]) => boolean,
    timeoutMs = 30_000,
  ): Promise<SseFrame[]> {
    const frames: SseFrame[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = streamSessionEvents(
      session.id,
      {
        onFrame: (frame) => {
          frames.push(frame);
          if (enough(frames)) controller.abort();
        },
      },
      { signal: controller.signal, baseUrl, headers: { Cookie: cookie } },
    );
    await done.catch(() => {});
    clearTimeout(timer);
    if (!enough(frames)) {
      throw new Error(
        `stream replay ended after ${frames.length} frames without the expected events`,
      );
    }
    return frames;
  }

  it(
    "wake: the first user.message cold-provisions a real microVM and runs turn 1",
    { timeout: STEP_TIMEOUT },
    async () => {
      expect(session.status).toBe("idle"); // the wake case: no runtime yet

      // F1 — the cold-wake observation loop the console's page-owned stream
      // runs. The session is idle with NO live runtime, so the backend serves
      // a history-only stream and closes it cleanly; a plain consumer would
      // latch "ended" and never see the wake. This persistent consumer opts
      // into the idle reconnect (`shouldReconnectOnClose` + a snappy
      // `idleReconnectMs`) — exactly what `useSessionStream` passes — so the
      // wake the send below triggers becomes observable WITHOUT any manual
      // reconnect. It is opened BEFORE the send, then left running.
      const observed: SseFrame[] = [];
      const obsController = new AbortController();
      const observing = streamSessionEvents(
        session.id,
        { onFrame: (frame) => observed.push(frame) },
        {
          signal: obsController.signal,
          baseUrl,
          headers: { Cookie: cookie },
          shouldReconnectOnClose: () => true, // non-terminal → keep observing
          idleReconnectMs: 250,
        },
      );

      const accepted = await sendSessionEvent(
        session.id,
        { type: "user.message", content: "pick up where we left off" },
        writer,
      );
      expect(accepted).toEqual({ accepted: true });

      // The REAL wake: SessionManager.getOrCreate → wake() → microVM
      // provision → turn 1 through the scripted brain → settle idle.
      const settled = await untilSession(
        (s) => s.status === "idle" && s.stopReason === "completed",
      );
      expect(settled.stopReason).toBe("completed");
      // A real sandbox handle exists for this session — the VM booted.
      expect(
        managed.sessionManager.getRuntime(session.id)?.sandboxHandle,
      ).toBeTruthy();

      // The turn's transcript is durable: JsonlSync pushes the log on the
      // idle transition and /messages (the Conversation tab's seed) sees it.
      // The push starts right AFTER the row flips idle, so poll briefly —
      // the same freshness model the tab documents (catch up at turn end).
      const messages = await untilMessages((m) => m.length >= 2);
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // The persistent, reconnecting stream — NOT a fresh replay — saw the
      // wake's status transitions live. This is the W5 loop F1 fixes: without
      // the idle reconnect the consumer would have ended on the first clean
      // close and this would time out.
      const wakeObserved = async (): Promise<boolean> =>
        ["session.status_run_started", "session.status_idle"].every((e) =>
          observed.some((f) => f.event === e),
        );
      const deadline = Date.now() + 30_000;
      while (!(await wakeObserved())) {
        if (Date.now() > deadline) {
          throw new Error(
            `the reconnecting stream never observed the wake (saw: ${observed
              .map((f) => f.event)
              .join(", ")})`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      obsController.abort();
      await observing.catch(() => {});
      expect(observed.map((f) => f.event)).toContain(
        "session.status_run_started",
      );
      expect(observed.map((f) => f.event)).toContain("session.status_idle");
    },
  );

  it(
    "requires_action: an always_ask tool blocks turn 2; the console's allow answer resumes it",
    { timeout: STEP_TIMEOUT },
    async () => {
      factory.last!.script.push("gated");
      await sendSessionEvent(
        session.id,
        { type: "user.message", content: "clean the build directory" },
        writer,
      );

      // The REAL confirmation coordinator parks the turn: idle with
      // stopReason requires_action, blocking ids advertised on the stream —
      // the same payload the composer's BlockingRequests panel acts on.
      await untilSession(
        (s) => s.status === "idle" && s.stopReason === "requires_action",
      );
      const frames = await replayFrames((fs) =>
        fs.some(
          (f) =>
            f.event === "session.status_idle" &&
            (f.data as { stopReason?: string }).stopReason === "requires_action",
        ),
      );
      const blockFrame = [...frames]
        .reverse()
        .find(
          (f) =>
            f.event === "session.status_idle" &&
            (f.data as { stopReason?: string }).stopReason ===
              "requires_action",
        );
      const blockingIds = (
        blockFrame?.data as { blockingEventIds?: string[] } | undefined
      )?.blockingEventIds;
      expect(blockingIds).toHaveLength(1);

      // The W5 answer, from the composer area: allow.
      await sendSessionEvent(
        session.id,
        {
          type: "user.tool_confirmation",
          eventId: blockingIds![0]!,
          decision: "allow",
        },
        writer,
      );
      const settled = await untilSession(
        (s) => s.status === "idle" && s.stopReason === "completed",
      );
      expect(settled.stopReason).toBe("completed");
    },
  );

  it(
    "interrupt: one click stops turn 3 as user_interrupt",
    { timeout: STEP_TIMEOUT },
    async () => {
      factory.last!.script.push("hang");
      await sendSessionEvent(
        session.id,
        { type: "user.message", content: "rewrite everything" },
        writer,
      );
      await untilSession((s) => s.status === "running");

      await sendSessionEvent(session.id, { type: "user.interrupt" }, writer);
      const settled = await untilSession(
        (s) => s.status === "idle" && s.stopReason === "user_interrupt",
      );
      expect(settled.stopReason).toBe("user_interrupt");
    },
  );

  it(
    "hand back: the durable log holds the whole multi-turn conversation for /remote:resume",
    { timeout: STEP_TIMEOUT },
    async () => {
      // What the CLI's `/remote:resume <id>` resumes FROM is the synced
      // JSONL — the same object /messages serves. All three turns' user
      // messages are there, in order, and the session sits idle for pickup.
      const messages = (await untilMessages(
        (m) =>
          (m as Array<{ role?: string }>).filter((x) => x.role === "user")
            .length >= 3,
      )) as Array<{ role?: string; content?: unknown }>;
      const userContents = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content);
      expect(userContents).toEqual([
        "pick up where we left off",
        "clean the build directory",
        "rewrite everything",
      ]);

      const final = await getSession(session.id, writer);
      expect(final.status).toBe("idle");
    },
  );
});
