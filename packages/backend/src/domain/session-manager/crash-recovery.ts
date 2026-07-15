/**
 * Crash recovery (§10.3, Appendix A.1 #9).
 *
 * Polls `provider.status(handle)` on an interval while the session is running. On
 * `crashed` (the VM died unexpectedly), re-provisions from the image/snapshot and
 * resumes from the JSONL log — transparent to the client. The session's `wake()`
 * re-binds a fresh `AgentSession` to the existing JSONL, so recovery = re-provision +
 * `provider.start` + continue. The client sees no error unless re-provision fails.
 *
 * Polling uses `setInterval`; tests use {@link CrashRecovery.pollOnce} for determinism.
 */

import type {
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "../ports.js";

/** Options for {@link CrashRecovery.start}. */
export interface CrashRecoveryOptions {
  handle: SandboxHandle;
  /** Spec to re-provision from on crash (the original `ProvisionSpec`). */
  provisionSpec: ProvisionSpec;
  /** Poll interval in ms (default 10s). */
  pollIntervalMs?: number;
}

/** Recorded crash-recovery events for assertions. */
export type CrashRecoveryEvent =
  | { kind: "poll"; status: SandboxStatus }
  | { kind: "crashed" }
  | { kind: "reprovisioned"; handle: SandboxHandle }
  | { kind: "started"; handle: SandboxHandle }
  | { kind: "error"; message: string };

/**
 * One crash-recovery poller per runtime. Started after `wake()`; stopped on dispose.
 * On crash, calls `provider.provision(spec)` (re-create), then `provider.start(handle)`
 * (cold reboot from checkpoint), then invokes `onRecovered` so the runtime can resume.
 */
export class CrashRecovery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private recovering = false;
  readonly events: CrashRecoveryEvent[] = [];

  constructor(private readonly provider: SandboxProvider) {}

  get isPolling(): boolean {
    return this.timer !== null;
  }

  /** Begin periodic polling. `onRecovered` is invoked after a successful re-provision. */
  start(opts: CrashRecoveryOptions, onRecovered?: (handle: SandboxHandle) => void): void {
    if (this.timer !== null) return;
    const interval = opts.pollIntervalMs ?? 10_000;
    let currentHandle = opts.handle;
    this.timer = setInterval(() => {
      void this.pollOnce({
        handle: currentHandle,
        provisionSpec: opts.provisionSpec,
      }).then((newHandle) => {
        if (newHandle) {
          currentHandle = newHandle;
          onRecovered?.(newHandle);
        }
      });
    }, interval);
  }

  /** Poll once (test-friendly). Returns a new handle if recovery occurred, else null. */
  async pollOnce(opts: {
    handle: SandboxHandle;
    provisionSpec: ProvisionSpec;
  }): Promise<SandboxHandle | null> {
    if (this.recovering) return null;
    let status: SandboxStatus;
    try {
      status = await this.provider.status(opts.handle);
    } catch (err) {
      this.events.push({ kind: "error", message: toMessage(err) });
      return null;
    }
    this.events.push({ kind: "poll", status });
    if (status !== "crashed") return null;

    this.recovering = true;
    this.events.push({ kind: "crashed" });
    try {
      // Re-provision from the original spec (create-or-recreate, detached).
      const handle = await this.provider.provision(opts.provisionSpec);
      this.events.push({ kind: "reprovisioned", handle });
      // Cold-reboot the (fresh) checkpoint: fs preserved, processes lost (§10.3).
      await this.provider.start(handle);
      this.events.push({ kind: "started", handle });
      return handle;
    } catch (err) {
      this.events.push({ kind: "error", message: toMessage(err) });
      return null;
    } finally {
      this.recovering = false;
    }
  }

  /** Stop polling (runtime teardown). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
