/**
 * Idle policy loop (§6.3, §10.3).
 *
 * After `idleTimeout` (from the environment config, in seconds) elapses with the
 * session in `idle`, the policy checkpoints the sandbox via `provider.stop(handle)`
 * (config + filesystem persisted; VM stops). On resume (`user.message`), the runtime
 * calls {@link IdlePolicy.cancel} + the provider `start(handle)` (cold reboot) and
 * surfaces "processes not preserved" to the model in the resume context (§10.3).
 *
 * Timers use `setTimeout`; the clock is injectable for deterministic tests via
 * {@link IdlePolicy.trigger} (fire immediately) and {@link IdlePolicy.pending}.
 */

import type { SandboxHandle, SandboxProvider, SessionId } from "../ports.js";

/** Options for {@link IdlePolicy.schedule}. */
export interface IdleScheduleOptions {
  sessionId: SessionId;
  handle: SandboxHandle;
  /** Idle timeout in milliseconds. */
  idleTimeoutMs: number;
}

/** Bounded retries for a failed idle checkpoint (ROB-6: a `stop()` reject must not kill the turn). */
const CHECKPOINT_RETRIES = 2;

/** Backoff (ms) between checkpoint retries. */
const CHECKPOINT_RETRY_MS = 250;

/**
 * One idle-policy loop per runtime. Holds at most one pending timer; scheduling while
 * one is pending is a no-op (the soonest deadline wins — if the new timeout is sooner,
 * the caller should {@link cancel} first).
 */
export class IdlePolicy {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSession: SessionId | null = null;
  /** The handle the pending timer would checkpoint (so {@link dispose} can flush it). */
  private pendingHandle: SandboxHandle | null = null;
  /** The in-flight `provider.stop()` checkpoint, or null. Awaited by {@link settleStop} (ROB-18). */
  private stopping: Promise<void> | null = null;
  /** Recorded calls for assertions. */
  readonly calls: Array<{ kind: "schedule"; sessionId: SessionId; ms: number } | { kind: "stop"; sessionId: SessionId } | { kind: "cancel"; sessionId: SessionId }> = [];

  constructor(private readonly provider: SandboxProvider) {}

  /** True iff an idle-stop timer is currently pending. */
  get hasPending(): boolean {
    return this.timer !== null;
  }

  /** The session id the pending timer targets (undefined if none). */
  get pending(): SessionId | null {
    return this.pendingSession;
  }

  /** Schedule the idle-stop checkpoint after `idleTimeoutMs`. */
  schedule(opts: IdleScheduleOptions, onStopped?: () => void): void {
    if (this.timer !== null) return; // already pending; first deadline wins
    const { sessionId, handle, idleTimeoutMs } = opts;
    this.pendingSession = sessionId;
    this.pendingHandle = handle;
    this.calls.push({ kind: "schedule", sessionId, ms: idleTimeoutMs });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingHandle = null;
      // `fire` catches its own errors, so the `void` here can never leak an unhandled
      // rejection into the process (worker-entry turns those into process.exit(1), ROB-6).
      void this.fire(sessionId, handle, onStopped);
    }, idleTimeoutMs);
  }

  /** Cancel a pending idle-stop (called on resume before `provider.start`). */
  cancel(sessionId: SessionId): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSession = null;
    this.pendingHandle = null;
    this.calls.push({ kind: "cancel", sessionId });
  }

  /**
   * Await any in-flight checkpoint (ROB-18). A `user.message` that races an idle-stop must
   * wait for the `provider.stop()` to finish before it reads the sandbox status + restarts,
   * else it reads "running" (stop not done yet), skips `start()`, and the completing stop
   * leaves the new turn's execs hitting a stopped VM.
   */
  async settleStop(): Promise<void> {
    if (this.stopping) {
      try {
        await this.stopping;
      } catch {
        /* the checkpoint's own retry/logging already ran in `fire` */
      }
    }
  }

  /** Fire the checkpoint immediately (test helper / forced idle). */
  async trigger(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sessionId = this.pendingSession;
    const handle = this.pendingHandle;
    this.pendingSession = null;
    this.pendingHandle = null;
    return sessionId ? this.fire(sessionId, handle, undefined) : Promise.resolve();
  }

  /**
   * Dispose the idle loop (runtime teardown / eviction). If an idle-stop was still pending —
   * the session is idle but its VM is STILL running — checkpoint it before dropping instead
   * of cancelling, so eviction does not leak a running VM (ROB-4). Best-effort + fire-and-
   * forget: `dispose()` is synchronous, and `fire` swallows its own errors.
   */
  dispose(): void {
    const flushHandle = this.timer !== null ? this.pendingHandle : null;
    const flushSession = this.pendingSession;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSession = null;
    this.pendingHandle = null;
    if (flushHandle && flushSession) {
      void this.fire(flushSession, flushHandle, undefined);
    }
  }

  private async fire(
    sessionId: SessionId,
    handle: SandboxHandle | null,
    onStopped?: () => void,
  ): Promise<void> {
    if (handle) {
      this.calls.push({ kind: "stop", sessionId });
      // Retain the checkpoint promise so a racing resume can await it (ROB-18), and retry a
      // transient failure rather than letting it reject unhandled (ROB-6).
      this.stopping = this.checkpoint(handle);
      try {
        await this.stopping;
      } finally {
        this.stopping = null;
      }
    }
    onStopped?.();
  }

  /** Checkpoint `handle` with bounded retries; the final failure is swallowed (best-effort). */
  private async checkpoint(handle: SandboxHandle): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.provider.stop(handle);
        return;
      } catch {
        if (attempt >= CHECKPOINT_RETRIES) {
          // Exhausted retries: the VM stays running until the next wake re-attaches +
          // re-schedules it. Swallow so the reject never reaches worker-entry (ROB-6).
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CHECKPOINT_RETRY_MS));
      }
    }
  }
}

/** Default idle timeout (ms) when the environment omits `idleTimeout` (§6.3). */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Convert an environment `idleTimeout` (seconds) to ms, with a default. */
export function idleTimeoutMsFromEnv(envIdleTimeoutSeconds: number | undefined): number {
  if (envIdleTimeoutSeconds === undefined || envIdleTimeoutSeconds <= 0) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }
  return envIdleTimeoutSeconds * 1000;
}
