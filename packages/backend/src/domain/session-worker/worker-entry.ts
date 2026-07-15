/**
 * Session-worker child entry (R7.1, `SESSION_WORKER_MODE=pool`).
 *
 * This module is the process the pool forks. It owns the {@link ManagedSessionRuntime}s
 * for the sessions sharded onto it: it builds the SAME collaborator graph the composition
 * root builds in-process (Postgres pool, object store, sandbox provider, session store,
 * event projection, usage recorder, vault secret store, provider-key resolver, MCP
 * credential resolver, memory mounts, skill materializer, self-hosted channel), so the
 * runtime code path is byte-for-byte the in-process one — only the *process* differs.
 *
 * **Events.** The runtime persists every outbound event to the `session_events` projection
 * from HERE (the child holds its own pg pool), exactly as it does in-process: the
 * projection stays the single numbering + durability authority (R4.1/R4.2). Each event is
 * *additionally* streamed to the parent over IPC purely so the parent's SSE fan-out can
 * serve live subscribers. See `remote-runtime.ts` for why that split is the safe one.
 *
 * **Blast radius.** An uncaught exception / unhandled rejection anywhere in the harness
 * kills THIS process only. The parent detects the exit, forgets the sessions this child
 * owned, respawns a child, and re-wakes those sessions on the next `getOrCreate` — which
 * re-attaches their surviving detached VMs (R2.9). Sessions on other children never notice.
 */

import { pathToFileURL } from "node:url";
import pino, { type Logger } from "pino";
import type { Config } from "../../infra/config/index.js";
import { createPool, closePool, type Pool } from "../../infra/db/index.js";
import { objectStoreFromConfig } from "../../infra/objectstore/index.js";
import { MicrosandboxProvider } from "../../infra/sandbox/provider.js";
import { DbSessionStore } from "../session/db-session-store.js";
import { createUsageRecorder } from "../usage/usage-recorder.js";
import { createVaultSecretStore } from "../vault/secret-store.js";
import { createProviderKeyResolver } from "../vault/provider-keys.js";
import { createVaultSecretResolver } from "../vault/secret-resolver.js";
import { createVaultMcpCredentialResolver } from "../mcp/credential-resolver.js";
import { createMemoryMountService } from "../memory/mount.js";
import { createSkillMaterializer } from "../skill/materialize.js";
import { createSelfHostedChannelFactory } from "../self-hosted/work-queue.js";
import {
  ManagedSessionRuntime,
  PiAgentSessionFactory,
  SessionEventsStore,
} from "../session-manager/index.js";
import type { AgentSessionFactory } from "../session-manager/types.js";
import type { SandboxProvider, SessionId } from "../ports.js";
import type { PositionedOutboundEvent } from "../event-stream/stream.js";
import type { ChildMessage, ParentMessage, RemoteSessionState } from "./protocol.js";

/**
 * Test/packaging seam: a module named by `SESSION_WORKER_OVERRIDES_MODULE` may replace the
 * child's sandbox provider and/or agent-session factory — the two collaborators the
 * in-process composition root accepts as `createManagedApp({ sandboxProvider, factory })`
 * but which cannot cross a process boundary as objects. Mirrors the plugin registry
 * (`plugins/registry.ts`): the pool itself is never faked, only these collaborators.
 */
export interface SessionWorkerOverrides {
  sandboxProvider?: SandboxProvider;
  factory?: AgentSessionFactory;
}

/** The contract an overrides module must export. */
export interface SessionWorkerOverridesModule {
  createSessionWorkerOverrides(ctx: {
    config: Config;
    logger: Logger;
    pool: Pool;
  }): Promise<SessionWorkerOverrides> | SessionWorkerOverrides;
}

/** Everything the child needs to construct a runtime (the child's composition root). */
interface WorkerDeps {
  pool: Pool;
  runtimeOptions: Omit<
    ConstructorParameters<typeof ManagedSessionRuntime>[0],
    "sandbox"
  > & { sandbox: SandboxProvider };
}

async function buildDeps(config: Config, logger: Logger): Promise<WorkerDeps> {
  if (!config.dbUrl) throw new Error("session worker: config.dbUrl is required");
  const pool = createPool({ connectionString: config.dbUrl });
  const overrides = await loadOverrides(config, logger, pool);

  const objects = await objectStoreFromConfig(config);
  const sandbox =
    overrides.sandboxProvider ??
    (config.sandboxRuntime === "enabled"
      ? new MicrosandboxProvider({ secretResolver: createVaultSecretResolver(pool) })
      : undefined);
  if (!sandbox) {
    throw new Error(
      "session worker: no sandbox runtime (SANDBOX_RUNTIME=disabled and no " +
        "SESSION_WORKER_OVERRIDES_MODULE) — a worker with no sandbox can run nothing",
    );
  }

  return {
    pool,
    runtimeOptions: {
      sandbox,
      objects,
      usage: createUsageRecorder({ pool }),
      secrets: createVaultSecretStore(pool),
      sessions: new DbSessionStore(pool, { localDir: config.sessionLocalDir }),
      factory: overrides.factory ?? new PiAgentSessionFactory(),
      events: new SessionEventsStore(pool),
      providerKeyResolver: createProviderKeyResolver(pool),
      mcpCredentialResolver: createVaultMcpCredentialResolver(pool),
      memory: createMemoryMountService({ pool, objectStore: objects }),
      skills: createSkillMaterializer({ pool, objectStore: objects }),
      selfHosted: createSelfHostedChannelFactory(pool),
    },
  };
}

async function loadOverrides(
  config: Config,
  logger: Logger,
  pool: Pool,
): Promise<SessionWorkerOverrides> {
  const path = config.sessionWorkerOverridesModule;
  if (!path) return {};
  const mod = (await import(pathToFileURL(path).href)) as SessionWorkerOverridesModule;
  if (typeof mod.createSessionWorkerOverrides !== "function") {
    throw new Error(
      `session worker: ${path} does not export createSessionWorkerOverrides()`,
    );
  }
  return mod.createSessionWorkerOverrides({ config, logger, pool });
}

/** The child's live runtimes, keyed by session id. */
const runtimes = new Map<SessionId, ManagedSessionRuntime>();
let deps: WorkerDeps | undefined;
let log: Logger = pino({ level: "silent" });

function send(msg: ChildMessage): void {
  process.send?.(msg);
}

function stateOf(rt: ManagedSessionRuntime): RemoteSessionState {
  return {
    status: rt.status(),
    ...(rt.sandboxHandle ? { sandboxHandle: rt.sandboxHandle } : {}),
    ...(rt.sessionContext ? { sessionContext: rt.sessionContext } : {}),
  };
}

/** Stream one session's outbound events up to the parent for the SSE fan-out. */
async function forwardEvents(
  sessionId: SessionId,
  rt: ManagedSessionRuntime,
): Promise<void> {
  for await (const event of rt.subscribe()) {
    send({
      t: "event",
      sessionId,
      event: event as PositionedOutboundEvent,
      state: stateOf(rt),
    });
  }
}

async function handleRpc(msg: Extract<ParentMessage, { t: "rpc" }>): Promise<void> {
  const d = deps;
  if (!d) throw new Error("session worker: not initialized");
  const { sessionId } = msg;

  switch (msg.op) {
    case "wake": {
      let rt = runtimes.get(sessionId);
      if (!rt) {
        rt = new ManagedSessionRuntime(d.runtimeOptions);
        runtimes.set(sessionId, rt);
        // Subscribe BEFORE wake so the events wake itself emits reach the parent.
        void forwardEvents(sessionId, rt).catch((err: unknown) => {
          log.warn(
            { sessionId, err: (err as Error).message },
            "session worker: event forwarding stopped",
          );
        });
        try {
          await rt.wake(sessionId);
        } catch (err) {
          runtimes.delete(sessionId);
          rt.dispose();
          throw err;
        }
      }
      send({ t: "reply", id: msg.id, ok: true, value: stateOf(rt), state: stateOf(rt) });
      return;
    }
    case "sendEvent": {
      const rt = requireRuntime(sessionId);
      await rt.sendEvent(msg.event);
      send({ t: "reply", id: msg.id, ok: true, value: null, state: stateOf(rt) });
      return;
    }
    case "interrupt": {
      const rt = requireRuntime(sessionId);
      await rt.interrupt();
      send({ t: "reply", id: msg.id, ok: true, value: null, state: stateOf(rt) });
      return;
    }
    case "getEntries": {
      const rt = requireRuntime(sessionId);
      const entries = await rt.getEntries(msg.range);
      send({ t: "reply", id: msg.id, ok: true, value: entries, state: stateOf(rt) });
      return;
    }
    case "dispose": {
      const rt = runtimes.get(sessionId);
      runtimes.delete(sessionId);
      rt?.dispose();
      send({ t: "reply", id: msg.id, ok: true, value: null });
      return;
    }
  }
}

function requireRuntime(sessionId: SessionId): ManagedSessionRuntime {
  const rt = runtimes.get(sessionId);
  if (!rt) throw new Error(`session worker: session ${sessionId} is not awake here`);
  return rt;
}

process.on("message", (msg: ParentMessage) => {
  if (msg.t === "init") {
    log = pino({
      level: msg.config.logLevel,
      name: `session-worker-${msg.workerIndex}`,
    });
    void buildDeps(msg.config, log)
      .then((d) => {
        deps = d;
        send({ t: "ready", pid: process.pid });
      })
      .catch((err: unknown) => {
        send({ t: "init_error", message: (err as Error).message });
        process.exit(1);
      });
    return;
  }
  if (msg.t !== "rpc") return;
  void handleRpc(msg).catch((err: unknown) => {
    send({ t: "reply", id: msg.id, ok: false, error: (err as Error).message });
  });
});

// A harness fault kills ONE worker (the whole point of R7.1): exit non-zero so the parent
// detects the crash, forgets this child's sessions, respawns, and re-attaches their VMs.
process.on("uncaughtException", (err) => {
  log.error({ err: err.message }, "session worker: uncaught exception — exiting");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.error({ err: String(err) }, "session worker: unhandled rejection — exiting");
  process.exit(1);
});

process.on("SIGTERM", () => {
  for (const rt of runtimes.values()) {
    try {
      rt.dispose();
    } catch {
      /* best-effort teardown */
    }
  }
  runtimes.clear();
  const p = deps?.pool;
  void (p ? closePool(p) : Promise.resolve()).finally(() => process.exit(0));
});
