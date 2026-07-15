/**
 * `SessionWorkerPool` — the parent (control-plane) half of the session-worker process
 * pool (R7.1, `SESSION_WORKER_MODE=pool`).
 *
 * ## Why
 *
 * Every tenant's Pi `AgentSession` runs in ONE Node process today: isolation exists at the
 * VM layer (each session's tools execute in its own microVM) but NOT at the harness layer.
 * One session's heap leak, event-loop block, or an uncaught throw inside the Pi SDK
 * degrades — or kills — every other tenant's session in the process. This pool bounds that
 * blast radius: N child processes own the {@link ManagedSessionRuntime}s, sessions are
 * sharded deterministically across them, and a child crash takes down only the sessions on
 * that child.
 *
 * ## Shape
 *
 * - **Bounded.** `workers = min(os.cpus().length, config.sessionWorkerCount)`, and each
 *   worker accepts at most `config.sessionWorkerMaxSessions` live sessions (the pool
 *   refuses past that rather than silently over-subscribing a process).
 * - **Deterministic sharding.** `shardFor(sessionId)` (FNV-1a % width) — the same session
 *   always lands on the same worker, so two concurrent `getOrCreate`s can never wake one
 *   session in two processes.
 * - **Crash detection + respawn.** A child `exit` rejects its in-flight RPCs, marks its
 *   session proxies lost (ending their SSE iterators), reports the lost session ids to the
 *   registry (which forgets them), and respawns a fresh child at the same index. Because
 *   the sandbox handle + status are persisted (R2.8) and the VM is detached (§10.1), the
 *   next `getOrCreate` re-wakes the session on the new child and re-attaches the SAME
 *   surviving VM through the boot-reattach path (R2.9) — no work is lost, no VM orphaned.
 * - **Interface-preserving.** `wake()` returns a {@link RemoteSessionRuntime} that
 *   implements the `SessionRuntime` port, so routes, the event projection and the SSE
 *   fan-out are unchanged (see `remote-runtime.ts` for the event/`status()` semantics).
 *
 * ## Limits (honest scope, see docs/session-worker-pool.md)
 *
 * - `SANDBOX_MODE=multi` in pool mode is refused at construction: the multi-host provider's
 *   boot (host registry + per-host token fail-closed) has not been re-verified inside a
 *   child, so the pool fails closed instead of silently booting an unauthenticated path.
 * - The child is a compiled entry (`dist/domain/session-worker/worker-entry.js`) — Node
 *   cannot execute the TypeScript sources directly. `pnpm --filter @pi-managed/backend
 *   build` must have run (it has, in any deployed artifact; the pool test builds it).
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { Config } from "../../infra/config/index.js";
import type {
  EntryRange,
  InboundEvent,
  SessionEntry,
  SessionId,
} from "../ports.js";
import { maxOutboundFromEnv } from "../session-manager/runtime.js";
import { RemoteSessionRuntime } from "./remote-runtime.js";
import {
  shardFor,
  type ChildMessage,
  type ParentMessage,
  type RemoteSessionState,
} from "./protocol.js";

/** Default worker count when `SESSION_WORKER_COUNT` is unset (capped by CPU count). */
export const DEFAULT_SESSION_WORKERS = 4;
/** Default per-worker session cap when `SESSION_WORKER_MAX_SESSIONS` is unset. */
export const DEFAULT_SESSIONS_PER_WORKER = 64;
/** Delay before respawning a crashed child (avoids a hot crash loop). */
export const RESPAWN_DELAY_MS = 250;

export interface SessionWorkerPoolOptions {
  config: Config;
  logger: Logger;
  /** Override the child entry (absolute path to a JS module). Tests / packaging. */
  workerEntry?: string;
  /** Override the per-subscriber outbound bound (R4.3). */
  maxOutboundEvents?: number;
}

/** One child process and the sessions it owns. */
interface Worker {
  index: number;
  child: ChildProcess;
  /** Resolves when the child answered `ready`; rejects on `init_error` / early exit. */
  ready: Promise<void>;
  alive: boolean;
  /** In-flight RPCs by id. */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Live session proxies owned by this child. */
  sessions: Map<SessionId, RemoteSessionRuntime>;
}

export class SessionWorkerPool {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly entry: string;
  private readonly maxOutbound: number;
  /** Bounded width: `min(cpus, config.sessionWorkerCount)` (R7.1). */
  readonly workerCount: number;
  /** Bounded per-worker session cap (R7.1). */
  readonly maxSessionsPerWorker: number;

  private readonly workers: Array<Worker | undefined>;
  /** In-flight (re)spawns, so concurrent callers share one child. */
  private readonly spawning = new Map<number, Promise<Worker>>();
  private readonly lostListeners = new Set<(sessionIds: SessionId[]) => void>();
  private nextRpcId = 1;
  private shuttingDown = false;

  constructor(opts: SessionWorkerPoolOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    if (this.config.sandboxMode === "multi") {
      throw new Error(
        "SESSION_WORKER_MODE=pool does not support SANDBOX_MODE=multi yet " +
          "(the multi-host provider's fail-closed boot is not verified inside a worker); " +
          "run SESSION_WORKER_MODE=inproc",
      );
    }
    this.entry = opts.workerEntry ?? this.config.sessionWorkerEntry ?? defaultWorkerEntry();
    this.maxOutbound = opts.maxOutboundEvents ?? maxOutboundFromEnv();
    this.workerCount = Math.max(
      1,
      Math.min(
        cpus().length || 1,
        this.config.sessionWorkerCount ?? DEFAULT_SESSION_WORKERS,
      ),
    );
    this.maxSessionsPerWorker =
      this.config.sessionWorkerMaxSessions ?? DEFAULT_SESSIONS_PER_WORKER;
    this.workers = new Array<Worker | undefined>(this.workerCount).fill(undefined);
  }

  /** Spawn every worker and await its `ready`. Called by the composition root at boot. */
  async start(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.workerCount }, (_, i) => this.ensureWorker(i)),
    );
  }

  /**
   * Wake `sessionId` in its shard's child process and return a {@link SessionRuntime}
   * proxy. The caller (the `SessionManager` registry) is unchanged: it holds the proxy
   * exactly as it holds an in-process runtime.
   */
  async wake(sessionId: SessionId): Promise<RemoteSessionRuntime> {
    if (this.shuttingDown) throw new Error("SessionWorkerPool: shutting down");
    const index = shardFor(sessionId, this.workerCount);
    const worker = await this.ensureWorker(index);
    const existing = worker.sessions.get(sessionId);
    if (existing) return existing;
    if (worker.sessions.size >= this.maxSessionsPerWorker) {
      throw new Error(
        `session worker ${index} is at capacity ` +
          `(${this.maxSessionsPerWorker} sessions); refusing to over-subscribe the process`,
      );
    }
    const runtime = new RemoteSessionRuntime({
      sessionId,
      maxOutboundEvents: this.maxOutbound,
      workerPid: worker.child.pid,
      transport: {
        wake: (id) => this.rpc<RemoteSessionState>(worker, { op: "wake", sessionId: id }),
        sendEvent: async (id, event) => {
          await this.rpc(worker, { op: "sendEvent", sessionId: id, event });
        },
        interrupt: async (id) => {
          await this.rpc(worker, { op: "interrupt", sessionId: id });
        },
        getEntries: (id, range) =>
          this.rpc<SessionEntry[]>(worker, {
            op: "getEntries",
            sessionId: id,
            ...(range ? { range } : {}),
          }),
        dispose: (id) => {
          worker.sessions.delete(id);
          void this.rpc(worker, { op: "dispose", sessionId: id }).catch(() => {
            /* best-effort: a dead child has already dropped the session */
          });
        },
      },
    });
    // Register BEFORE the wake RPC so events emitted during wake are routed to the proxy.
    worker.sessions.set(sessionId, runtime);
    try {
      await runtime.wake(sessionId);
    } catch (err) {
      worker.sessions.delete(sessionId);
      throw err;
    }
    return runtime;
  }

  /**
   * Subscribe to session-loss notifications (a child crashed). The registry forgets the
   * ids so the next `getOrCreate` re-wakes them on the respawned worker.
   */
  onSessionsLost(listener: (sessionIds: SessionId[]) => void): void {
    this.lostListeners.add(listener);
  }

  /** PIDs of the live workers (observability + tests). */
  pids(): Array<number | undefined> {
    return this.workers.map((w) => (w?.alive ? w.child.pid : undefined));
  }

  /** The PID of the child that owns `sessionId`'s shard (observability + tests). */
  pidFor(sessionId: SessionId): number | undefined {
    const w = this.workers[shardFor(sessionId, this.workerCount)];
    return w?.alive ? w.child.pid : undefined;
  }

  /** Number of live sessions on each worker (observability + tests). */
  sessionCounts(): number[] {
    return this.workers.map((w) => w?.sessions.size ?? 0);
  }

  /** Kill every child (graceful shutdown). Idempotent. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const exits = this.workers.map(async (w) => {
      if (!w || !w.alive) return;
      const exited = new Promise<void>((resolve) => w.child.once("exit", () => resolve()));
      w.child.kill("SIGTERM");
      const timer = setTimeout(() => w.child.kill("SIGKILL"), 2_000);
      timer.unref?.();
      await exited;
      clearTimeout(timer);
    });
    await Promise.all(exits);
  }

  // -- workers ---------------------------------------------------------------

  private async ensureWorker(index: number): Promise<Worker> {
    const current = this.workers[index];
    if (current?.alive) {
      await current.ready;
      return current;
    }
    const inFlight = this.spawning.get(index);
    if (inFlight) return inFlight;
    const p = this.spawn(index).finally(() => this.spawning.delete(index));
    this.spawning.set(index, p);
    return p;
  }

  private async spawn(index: number): Promise<Worker> {
    const child = fork(this.entry, [], {
      // The child reads config from the `init` message, not argv. `stdio: inherit` keeps
      // the worker's pino output on the parent's streams (one log stream per node).
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: process.env,
    });
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const worker: Worker = {
      index,
      child,
      alive: true,
      pending,
      sessions: new Map(),
      ready: Promise.resolve(),
    };
    worker.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: ChildMessage): void => {
        if (msg.t === "ready") {
          child.off("message", onMessage);
          resolve();
        } else if (msg.t === "init_error") {
          child.off("message", onMessage);
          reject(new Error(`session worker ${index} failed to init: ${msg.message}`));
        }
      };
      child.on("message", onMessage);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `session worker ${index} exited before ready (code=${code} signal=${signal})`,
          ),
        );
      });
    });

    child.on("message", (msg: ChildMessage) => this.onChildMessage(worker, msg));
    child.on("exit", (code, signal) => this.onChildExit(worker, code, signal));
    child.send({ t: "init", workerIndex: index, config: this.config } as ParentMessage);

    this.workers[index] = worker;
    try {
      await worker.ready;
    } catch (err) {
      worker.alive = false;
      throw err;
    }
    this.logger.info(
      { workerIndex: index, pid: child.pid },
      "session worker started (SESSION_WORKER_MODE=pool)",
    );
    return worker;
  }

  private onChildMessage(worker: Worker, msg: ChildMessage): void {
    switch (msg.t) {
      case "reply": {
        const p = worker.pending.get(msg.id);
        if (!p) return;
        worker.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
        return;
      }
      case "event": {
        worker.sessions.get(msg.sessionId)?.onRemoteEvent(msg.event, msg.state);
        return;
      }
      case "state": {
        worker.sessions.get(msg.sessionId)?.onRemoteState(msg.state);
        return;
      }
      default:
        return;
    }
  }

  /**
   * A child died (crash, OOM-kill, or our own SIGTERM at shutdown). Bounded blast radius:
   * only this child's sessions are affected. Reject its in-flight RPCs, mark its session
   * proxies lost (their SSE iterators end; clients reconnect and replay from the
   * projection), tell the registry to forget them, and respawn.
   */
  private onChildExit(
    worker: Worker,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (!worker.alive) return;
    worker.alive = false;
    const lost = [...worker.sessions.keys()];
    for (const rt of worker.sessions.values()) rt.onWorkerCrashed();
    worker.sessions.clear();
    for (const p of worker.pending.values()) {
      p.reject(
        new Error(
          `session worker ${worker.index} died (code=${code} signal=${signal}) ` +
            `with the request in flight`,
        ),
      );
    }
    worker.pending.clear();
    if (this.workers[worker.index] === worker) this.workers[worker.index] = undefined;

    if (this.shuttingDown) return;
    this.logger.error(
      { workerIndex: worker.index, pid: worker.child.pid, code, signal, lost: lost.length },
      "session worker died; respawning (sessions re-wake + re-attach on next getOrCreate)",
    );
    for (const listener of this.lostListeners) {
      try {
        listener(lost);
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message },
          "session-worker loss listener threw",
        );
      }
    }
    const timer = setTimeout(() => {
      if (this.shuttingDown) return;
      void this.ensureWorker(worker.index).catch((err: unknown) => {
        this.logger.error(
          { workerIndex: worker.index, err: (err as Error).message },
          "session worker respawn failed",
        );
      });
    }, RESPAWN_DELAY_MS);
    timer.unref?.();
  }

  /**
   * One RPC. No timeout by design: a turn legitimately runs for minutes (a model call plus
   * tool executions), and the failure mode this pool exists to bound — a dead or wedged
   * child — is detected at the process level (`exit`), which rejects everything in flight.
   */
  private rpc<T>(
    worker: Worker,
    req:
      | { op: "wake"; sessionId: SessionId }
      | { op: "sendEvent"; sessionId: SessionId; event: InboundEvent }
      | { op: "interrupt"; sessionId: SessionId }
      | { op: "getEntries"; sessionId: SessionId; range?: EntryRange }
      | { op: "dispose"; sessionId: SessionId },
  ): Promise<T> {
    if (!worker.alive) {
      return Promise.reject(
        new Error(`session worker ${worker.index} is not running`),
      );
    }
    const id = this.nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      worker.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.child.send({ t: "rpc", id, ...req } as ParentMessage, (err) => {
        if (!err) return;
        worker.pending.delete(id);
        reject(err);
      });
    });
  }
}

/**
 * The compiled child entry. Node cannot execute the TypeScript sources (parameter
 * properties are not erasable, and `.js` specifiers do not resolve to `.ts`), so the child
 * always runs the tsc output. When the parent itself runs from `dist/` the sibling module
 * IS the entry; when it runs from `src/` (vitest), map the path into `dist/`.
 */
export function defaultWorkerEntry(): string {
  const here = fileURLToPath(new URL("./worker-entry.js", import.meta.url));
  if (existsSync(here)) return here;
  const dist = here.replace(`${sep}src${sep}`, `${sep}dist${sep}`);
  if (existsSync(dist)) return dist;
  throw new Error(
    `SESSION_WORKER_MODE=pool: no compiled worker entry at ${here} or ${dist}. ` +
      `Build the backend (pnpm --filter @pi-managed/backend build) or set SESSION_WORKER_ENTRY.`,
  );
}
