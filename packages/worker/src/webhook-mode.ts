/**
 * Webhook-triggered mode (WP-4.2, §10.4).
 *
 * The subscriber registers a webhook (§23) for `session.status_run_started`
 * pointing at a local script that pings the worker. Because the worker never
 * listens (outbound-HTTPS-only), the "ping" is an in-process trigger: the
 * subscriber's webhook-receiver script calls {@link WebhookMode.wake} (the
 * worker exposes it via the CLI's `--webhook-pipe` mode or by embedding the
 * worker in a tiny local HTTP shim the subscriber owns).
 *
 * This reduces idle polling: instead of polling every `pollingIntervalMs`, the
 * worker sleeps for a long `safetyIntervalMs` (default 60s) and wakes
 * immediately on a webhook. The safety poll is a fallback in case a webhook is
 * missed (delivered-at-most-once webhooks can be lost).
 */

import type { WorkerConfig } from "./config.js";
import type { Executor } from "./control-levels.js";
import { Poller, type PollerOptions } from "./poller.js";

/** A handle that lets the host ping the worker awake. */
export interface WakeSignal {
  /** Wake the worker: trigger an immediate claim attempt. */
  wake(): void;
}

/** Options for {@link WebhookMode}. */
export interface WebhookModeOptions extends PollerOptions {
  /** Safety-poll interval when no webhooks arrive (default 60000). */
  safetyIntervalMs?: number;
}

/**
 * Webhook-triggered worker. Wraps a {@link Poller}; on each loop iteration it
 * races a long safety-sleep against an explicit {@link wake} call. On wake (or
 * timeout) it runs one claim→execute→postResult tick.
 */
export class WebhookMode implements WakeSignal {
  private readonly poller: Poller;
  private readonly signal?: AbortSignal;
  private readonly safetyMs: number;
  /** Resolved by {@link wake}; recreated each iteration. */
  private wakeResolve?: () => void;

  constructor(cfg: WorkerConfig, executor: Executor, opts: WebhookModeOptions = {}) {
    this.poller = new Poller(cfg, executor, opts);
    this.signal = opts.signal;
    this.safetyMs = opts.safetyIntervalMs ?? 60_000;
  }

  /** Wake the worker: resolve the current safety sleep so it polls now. */
  wake(): void {
    this.wakeResolve?.();
  }

  /** Run the wake-or-safety loop until aborted. */
  async start(): Promise<void> {
    while (!this.signal?.aborted) {
      try {
        await this.poller.pollOnce();
      } catch (err) {
        // Reuse the poller's logger-less error path: keep looping.
        void err;
      }
      if (this.signal?.aborted) break;
      await this.raceWake(this.safetyMs);
    }
  }

  /** A single webhook-triggered tick (claim→execute→postResult). */
  async tick(): Promise<boolean> {
    return this.poller.pollOnce();
  }

  /** Resolve on wake, on timeout, or on abort. */
  private raceWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.wakeResolve = undefined;
        clearTimeout(t);
        this.signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.wakeResolve = finish;
      const t = setTimeout(finish, ms);
      this.signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
