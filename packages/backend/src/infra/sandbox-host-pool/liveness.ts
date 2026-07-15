/**
 * Liveness monitor (WP-4.3, §7.2).
 *
 * Periodically probes each host's `/healthz`. On repeated failure it marks the host
 * `unhealthy` (removing it from placement rotation), logs the transition, and alerts
 * via the {@link WebhookSink} with a `sandbox.host_unhealthy` event (§23.2).
 *
 * See `docs/multi-host-design.md` §7.
 */

import type { Logger } from "../telemetry/index.js";
import type { WebhookEvent, WebhookSink } from "../../domain/ports.js";
import type { SandboxHost, LivenessRegistryPort } from "./types.js";
import type { HostAgentTokenSource } from "./auth.js";

/** Options for {@link LivenessMonitor}. */
export interface LivenessMonitorOptions {
  /** Probe interval in ms (default 10_000). */
  intervalMs?: number;
  /** Consecutive failures before marking unhealthy (default 3). */
  failureThreshold?: number;
  /** Per-probe timeout in ms (default 2_000). */
  probeTimeoutMs?: number;
  /** Structured logger. */
  logger?: Logger;
  /** Webhook sink for alerting (§23.2). Optional — alerts are best-effort. */
  webhookSink?: WebhookSink;
  /**
   * Per-host secret source for the authenticated `/healthz` probe (§6.1). Required by the
   * default probe (the channel is never unauthenticated); ignored when {@link probe} is
   * injected. Sourced from config via `createHostAgentTokenSource`.
   */
  tokenSource?: HostAgentTokenSource;
  /** Injectable probe fn (default: authenticated `GET <endpoint>/healthz`). */
  probe?: (host: SandboxHost, timeoutMs: number) => Promise<boolean>;
}

/**
 * Probes the host pool on a timer and removes failing hosts from rotation.
 *
 * The monitor is the authority that flips a host `healthy → unhealthy`; placement
 * (`placement.ts`) only considers `healthy` hosts, so an unhealthy host is immediately
 * out of rotation.
 */
export class LivenessMonitor {
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private readonly probeTimeoutMs: number;
  private readonly logger?: Logger;
  private readonly webhookSink?: WebhookSink;
  private readonly probe: (host: SandboxHost, timeoutMs: number) => Promise<boolean>;
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly registry: LivenessRegistryPort,
    opts: LivenessMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2_000;
    this.logger = opts.logger;
    this.webhookSink = opts.webhookSink;
    const tokenSource = opts.tokenSource;
    this.probe =
      opts.probe ?? ((host, timeoutMs) => defaultProbe(host, timeoutMs, tokenSource));
  }

  /** Start the periodic probe loop. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.probeOnce(), this.intervalMs);
    // Don't keep the event loop alive solely for liveness probing.
    this.timer.unref?.();
  }

  /** Stop the periodic probe loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Probe every host once. Exposed for deterministic tests (call instead of `start`). */
  async probeOnce(): Promise<void> {
    const hosts = await this.registry.listHosts(false);
    await Promise.allSettled(hosts.map((h) => this.probeHost(h)));
  }

  private async probeHost(host: SandboxHost): Promise<void> {
    let ok: boolean;
    try {
      ok = await this.probe(host, this.probeTimeoutMs);
    } catch {
      ok = false;
    }
    if (ok) {
      this.failures.set(host.id, 0);
      if (host.status === "unhealthy") {
        await this.registry.markHealthy(host.id);
        this.logger?.info({ hostId: host.id }, "sandbox host recovered");
      }
      await this.registry.updateHeartbeat(host.id);
      return;
    }
    const n = (this.failures.get(host.id) ?? 0) + 1;
    this.failures.set(host.id, n);
    this.logger?.warn({ hostId: host.id, failures: n }, "sandbox host healthz failed");
    if (n >= this.failureThreshold) {
      await this.registry.markUnhealthy(host.id, {
        type: "healthz_failed",
        detail: `${n} consecutive probe failures`,
        at: new Date().toISOString(),
      });
      this.failures.set(host.id, 0);
      this.logger?.error({ hostId: host.id }, "sandbox host removed from rotation");
      await this.alert(host.id);
    }
  }

  /** Best-effort alert via the webhook sink (§23.2). */
  private async alert(hostId: string): Promise<void> {
    if (!this.webhookSink) return;
    const event: WebhookEvent = {
      type: "sandbox.host_unhealthy",
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.webhookSink.dispatch(event);
    } catch (err) {
      // Alerting is best-effort; never let it crash the monitor.
      this.logger?.warn({ hostId, err: String(err) }, "webhook alert failed");
    }
  }
}

/**
 * Default probe: authenticated `GET <endpoint>/healthz` expecting 2xx within the timeout.
 * The host-agent channel is authenticated on every request (§6.1), `/healthz` included,
 * so the probe sends the host's shared secret as a bearer token. Fails closed: if no
 * `tokenSource` is configured, the probe returns `false` (host treated as unreachable)
 * rather than sending an unauthenticated request.
 */
async function defaultProbe(
  host: SandboxHost,
  timeoutMs: number,
  tokenSource?: HostAgentTokenSource,
): Promise<boolean> {
  if (!tokenSource) return false;
  const token = tokenSource(host);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host.endpoint.replace(/\/$/, "")}/healthz`, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } finally {
    clearTimeout(t);
  }
}
