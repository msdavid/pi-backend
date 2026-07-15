/**
 * `MultiHostSandboxProvider` (WP-4.3, §7.2, §4.2).
 *
 * A {@link SandboxProvider} that routes each operation to the owning host's local
 * `MicrosandboxProvider`. microsandbox itself has no multi-host scheduler — the backend
 * owns placement routing (§7.2). The {@link SessionRuntime} (`session-manager/runtime.ts`)
 * is unchanged: it still calls the `SandboxProvider` interface and never learns a host
 * pool exists; composition swaps the single-host provider for this one.
 *
 * Each host runs a small HTTP "host agent" wrapping its local `MicrosandboxProvider`.
 * The {@link HostAgent} abstraction decouples routing from transport: production uses
 * {@link HttpHostAgent} (Node `fetch`, no new deps); tests use a mock host (Node `http`).
 *
 * See `docs/multi-host-design.md`.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type {
  ExecChunk,
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxMetrics,
  SandboxProvider,
  SandboxStatus,
  SecretBinding,
} from "../../domain/ports.js";
import { chooseHost } from "../sandbox-host-pool/placement.js";
import type { EnvLike } from "../sandbox-host-pool/auth.js";
import type { SandboxHost, HostRegistryPort } from "../sandbox-host-pool/types.js";

// Re-exported for callers that want the port type from the provider surface.
export type { HostRegistryPort } from "../sandbox-host-pool/types.js";


// ---------------------------------------------------------------------------
// HostAgent — a single host's local SandboxProvider, over the wire or in-process.
// ---------------------------------------------------------------------------

/**
 * A single host's sandbox surface. Mirrors {@link SandboxProvider} minus the
 * pool-level `reattachByLabels` (replaced by {@link listByLabels}) plus a `healthz`
 * probe. The multi-host provider delegates to one of these per host.
 */
export interface HostAgent {
  readonly hostId: string;
  healthz(): Promise<boolean>;
  provision(spec: ProvisionSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult>;
  execStream(handle: SandboxHandle, opts: ExecOptions): AsyncIterable<ExecChunk>;
  stop(handle: SandboxHandle): Promise<void>;
  start(handle: SandboxHandle): Promise<void>;
  snapshot(handle: SandboxHandle): Promise<string>;
  destroy(handle: SandboxHandle): Promise<void>;
  status(handle: SandboxHandle): Promise<SandboxStatus>;
  registerSecretBinding(handle: SandboxHandle, binding: SecretBinding): Promise<void>;
  /** List VMs on this host by tenant/session labels (for pool re-attach, §5). */
  listByLabels(
    labels: { tenant: string; session?: string },
  ): Promise<SandboxHandle[]>;
  /**
   * Point-in-time metrics for a VM on this host (§26.4). Optional: a host agent that
   * predates the `POST /metrics` route reports nothing, and an agent that cannot sample
   * returns `null` — both mean "no metrics", never an error.
   */
  metrics?(handle: SandboxHandle): Promise<SandboxMetrics | null>;
}

/** Factory: build a {@link HostAgent} for a host endpoint. */
export type HostAgentFactory = (host: SandboxHost) => HostAgent;

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/** JSON-RPC-style request body for exec. */
interface ExecRequest {
  handle: SandboxHandle;
  opts: ExecOptions;
}

/** Wraps a handle arg for single-handle ops (stop/start/destroy/snapshot/status). */
interface HandleRequest {
  handle: SandboxHandle;
}

/** Wraps a binding arg for registerSecretBinding. */
interface BindingRequest {
  handle: SandboxHandle;
  binding: SecretBinding;
}

/** Options for {@link HttpHostAgent}. */
export interface HttpHostAgentOptions {
  /**
   * Per-host shared secret sent as `Authorization: Bearer <token>` on every request
   * (§6.1 trust model). Required — the channel is privileged and never unauthenticated.
   * Sourced from config via `createHostAgentTokenSource`; never hardcoded, never logged.
   */
  token: string;
  /** Injectable `fetch` for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Mutual-TLS client agent (§6.1). When set, requests are made over `node:https` with
   * this agent, presenting the backend's client key+cert and pinning the host's CA — so a
   * stolen bearer token alone cannot reach the channel. Build it from env via
   * {@link createHostAgentTlsAgent}. When absent, the plain `fetchImpl` transport is used
   * (single-host bootstrap / tests over HTTP). Node's global `fetch` (undici) does not
   * accept a Node TLS agent, so the mTLS path uses `node:https` directly.
   */
  tlsAgent?: https.Agent;
}

/**
 * Build the mutual-TLS client agent from env (§6.1). Presents the backend's client
 * cert+key and pins the host CA, all read from PEM file paths:
 * `HOST_AGENT_TLS_CERT`, `HOST_AGENT_TLS_KEY`, `HOST_AGENT_TLS_CA`. Returns `undefined`
 * when none are configured (single-host bootstrap / plain-HTTP tests). The resulting
 * agent is passed to {@link HttpHostAgent} via {@link HttpHostAgentOptions.tlsAgent}.
 */
export function createHostAgentTlsAgent(
  env: EnvLike = process.env,
): https.Agent | undefined {
  const certPath = env.HOST_AGENT_TLS_CERT;
  const keyPath = env.HOST_AGENT_TLS_KEY;
  const caPath = env.HOST_AGENT_TLS_CA;
  if (!certPath || !keyPath || !caPath) return undefined;
  return new https.Agent({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: readFileSync(caPath),
  });
}

/**
 * Talks to a host agent over HTTPS (or HTTP) using Node's global `fetch`. No new deps.
 *
 * The host-agent channel is privileged (arbitrary exec, cross-tenant VM enumeration,
 * secret binding), so every request — `/healthz` included — carries the host's shared
 * secret as a bearer token (§6.1). Production additionally terminates mutual TLS.
 *
 * Wire contract: see `docs/spec/multi-host-design.md` §6.
 */
export class HttpHostAgent implements HostAgent {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tlsAgent: https.Agent | undefined;

  constructor(
    public readonly hostId: string,
    private readonly endpoint: string,
    opts: HttpHostAgentOptions,
  ) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tlsAgent = opts.tlsAgent;
  }

  /**
   * Perform a request. With an mTLS agent configured (§6.1), use `node:https` so the
   * client cert is presented and the host CA pinned; otherwise use the `fetch` transport.
   */
  private request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    if (this.tlsAgent) return nodeRequest(url, init, this.tlsAgent);
    return this.fetchImpl(url, init);
  }

  /** Auth header sent on every request (§6.1). Kept off log lines and error text. */
  private authHeader(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  private get base(): string {
    return this.endpoint.replace(/\/$/, "");
  }

  async healthz(): Promise<boolean> {
    const res = await this.request(`${this.base}/healthz`, {
      headers: this.authHeader(),
    });
    return res.ok;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    return this.post("/provision", spec);
  }

  async exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    return this.post("/exec", { handle, opts } satisfies ExecRequest);
  }

  async *execStream(
    handle: SandboxHandle,
    opts: ExecOptions,
  ): AsyncIterable<ExecChunk> {
    // v1: the network transport is buffered (real-time streaming is a §1 non-goal).
    // The host agent's /exec returns the full result; we yield stdout then stderr.
    const out = await this.exec(handle, opts);
    if (out.stdout) yield { stream: "stdout", data: out.stdout };
    if (out.stderr) yield { stream: "stderr", data: out.stderr };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    await this.post("/stop", { handle } satisfies HandleRequest);
  }

  async start(handle: SandboxHandle): Promise<void> {
    await this.post("/start", { handle } satisfies HandleRequest);
  }

  async snapshot(handle: SandboxHandle): Promise<string> {
    const out = await this.post<{ id: string }>("/snapshot", {
      handle,
    } satisfies HandleRequest);
    return out.id;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.post("/destroy", { handle } satisfies HandleRequest);
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    return this.post("/status", { handle } satisfies HandleRequest);
  }

  async registerSecretBinding(
    handle: SandboxHandle,
    binding: SecretBinding,
  ): Promise<void> {
    await this.post("/register-secret-binding", {
      handle,
      binding,
    } satisfies BindingRequest);
  }

  async listByLabels(labels: {
    tenant: string;
    session?: string;
  }): Promise<SandboxHandle[]> {
    return this.post("/list-by-labels", labels);
  }

  /**
   * Sample a VM's metrics on the owning host (§26.4).
   *
   * Deliberately tolerant, because metrics are observability and must never take a
   * request down: a host agent that does not serve `/metrics` (`404`) and a host that has
   * no live VM for the handle (`204` / empty body) both yield `null`, not an error. Any
   * other non-2xx is a real failure and propagates via {@link post}.
   *
   * NOTE (unproven here): the host-agent HTTP server in this tree does not yet serve
   * `POST /metrics` — that route belongs to `infra/sandbox-host-pool/server.ts`, outside
   * this work package. Until it lands, this method returns `null` against a current host
   * agent (a `404` from its catch-all), so `GET /v1/sessions/:id/metrics` reports no
   * metrics in `SANDBOX_MODE=multi`. The client half of the contract is here and needs no
   * change when the route is added. See `docs/api-reference.md`.
   */
  async metrics(handle: SandboxHandle): Promise<SandboxMetrics | null> {
    const res = await this.request(`${this.base}/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeader() },
      body: JSON.stringify({ handle } satisfies HandleRequest),
    });
    if (res.status === 404) return null; // host agent has no metrics route
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HostAgent ${this.hostId} /metrics failed: ${res.status} ${text}`.slice(0, 500),
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 204 || !ct.includes("application/json")) return null;
    return (await res.json()) as SandboxMetrics | null;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HostAgent ${this.hostId} ${path} failed: ${res.status} ${text}`.slice(0, 500),
      );
    }
    if (res.status === 204) return undefined as T;
    const len = res.headers.get("content-length");
    if (len === "0") return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return undefined as T;
    return (await res.json()) as T;
  }
}

/**
 * Perform an HTTP(S) request over `node:https`/`node:http` with a Node TLS agent, returning
 * a WHATWG {@link Response} so callers use the same surface as `fetch`. Used for the mTLS
 * client path (§6.1) because Node's global `fetch` (undici) does not accept a Node TLS agent.
 */
function nodeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  agent: https.Agent,
): Promise<Response> {
  const u = new URL(url);
  const transport = u.protocol === "http:" ? http : https;
  return new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      u,
      { method: init.method ?? "GET", headers: init.headers, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(", "));
          }
          resolve(
            new Response(buf.length > 0 ? buf : null, {
              status: res.statusCode ?? 0,
              headers,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MultiHostSandboxProvider
// ---------------------------------------------------------------------------

/** Thrown when an op targets a sandbox whose owning host is missing/unhealthy. */
export class HostUnavailableError extends Error {
  constructor(
    public readonly sandboxName: string,
    public readonly hostId: string | undefined,
  ) {
    super(
      `Owning host unavailable for sandbox ${sandboxName}` +
        (hostId ? ` (host ${hostId})` : " (no placement)"),
    );
    this.name = "HostUnavailableError";
  }
}

/** Options for {@link MultiHostSandboxProvider}. */
export interface MultiHostSandboxProviderOptions {
  /** Host registry (placements + host metadata). */
  registry: HostRegistryPort;
  /** Builds a {@link HostAgent} per host. */
  agentFactory: HostAgentFactory;
}

/**
 * A {@link SandboxProvider} that routes across a pool of KVM hosts.
 *
 * - `provision` → `chooseHost` → delegate → record placement.
 * - lifecycle ops route to the recorded owner host.
 * - `reattachByLabels` scans all healthy hosts and reconciles placements (§5).
 */
export class MultiHostSandboxProvider implements SandboxProvider {
  private readonly registry: HostRegistryPort;
  private readonly agentFactory: HostAgentFactory;

  constructor(opts: MultiHostSandboxProviderOptions) {
    this.registry = opts.registry;
    this.agentFactory = opts.agentFactory;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const hosts = await this.registry.listHosts(true);
    const usage = await this.registry.placementUsage();
    const host = chooseHost(spec, hosts, usage);
    const agent = this.agentFactory(host);
    const handle = await agent.provision(spec);
    // Record the VM's footprint so subsequent placements see it as reserved (ROB-17).
    await this.registry.recordPlacement(handle.name, host.id, {
      cpus: spec.cpus,
      memoryMiB: spec.memoryMiB,
    });
    return handle;
  }

  async exec(handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    const agent = await this.agentFor(handle);
    return agent.exec(handle, opts);
  }

  async *execStream(
    handle: SandboxHandle,
    opts: ExecOptions,
  ): AsyncIterable<ExecChunk> {
    const agent = await this.agentFor(handle);
    yield* agent.execStream(handle, opts);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const agent = await this.agentFor(handle);
    await agent.stop(handle);
  }

  async start(handle: SandboxHandle): Promise<void> {
    const agent = await this.agentFor(handle);
    await agent.start(handle);
  }

  async snapshot(handle: SandboxHandle): Promise<string> {
    const agent = await this.agentFor(handle);
    return agent.snapshot(handle);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const agent = await this.agentFor(handle);
    await agent.destroy(handle);
    await this.registry.removePlacement(handle.name);
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    const agent = await this.agentFor(handle);
    return agent.status(handle);
  }

  async registerSecretBinding(
    handle: SandboxHandle,
    binding: SecretBinding,
  ): Promise<void> {
    const agent = await this.agentFor(handle);
    await agent.registerSecretBinding(handle, binding);
  }

  /**
   * Sample the VM's metrics on its owning host (§26.4).
   *
   * Metrics are a read-only observability surface, so an unroutable sandbox is `null`
   * ("nothing to report" → the API's `404`), not a thrown {@link HostUnavailableError}:
   * an unhealthy or unknown host must not turn a metrics GET into a 500. An agent with no
   * `metrics` method (an older {@link HostAgent} implementation) is likewise `null`.
   */
  async metrics(handle: SandboxHandle): Promise<SandboxMetrics | null> {
    let agent: HostAgent;
    try {
      agent = await this.agentFor(handle);
    } catch {
      return null; // no placement / host unhealthy → nothing to sample
    }
    return (await agent.metrics?.(handle)) ?? null;
  }

  /**
   * Boot-time recovery across the pool (§4.2, §5): scan every healthy host for VMs
   * matching the labels and reconcile the placement table to the discovered owners.
   */
  async reattachByLabels(labels: {
    tenant: string;
    session?: string;
  }): Promise<SandboxHandle[]> {
    const hosts = await this.registry.listHosts(true);
    const found: SandboxHandle[] = [];
    const seen = new Set<string>();
    await Promise.all(
      hosts.map(async (host) => {
        const agent = this.agentFactory(host);
        const handles = await agent.listByLabels(labels);
        for (const h of handles) {
          if (seen.has(h.id)) continue;
          seen.add(h.id);
          found.push(h);
          // Reconcile: the host that actually has the VM owns it.
          await this.registry.recordPlacement(h.name, host.id);
        }
      }),
    );
    return found;
  }

  /** Resolve the owning host's agent for a sandbox, reconciling if needed. */
  private async agentFor(handle: SandboxHandle): Promise<HostAgent> {
    let hostId = await this.registry.getOwner(handle.name);
    let host = hostId ? await this.registry.getHost(hostId) : undefined;

    // Placement row missing or stale: fall back to a label scan to locate the VM.
    if (!host) {
      const located = await this.locate(handle);
      if (located) {
        hostId = located.id;
        host = located;
      }
    }
    if (!host || host.status !== "healthy") {
      throw new HostUnavailableError(handle.name, hostId);
    }
    return this.agentFactory(host);
  }

  /** Locate the host currently running `handle` via a label scan (§5 reconciliation). */
  private async locate(handle: SandboxHandle): Promise<SandboxHost | undefined> {
    const hosts = await this.registry.listHosts(true);
    for (const host of hosts) {
      const agent = this.agentFactory(host);
      try {
        const status = await agent.status(handle);
        if (status) {
          await this.registry.recordPlacement(handle.name, host.id);
          return host;
        }
      } catch {
        // Not on this host (or host unreachable) — keep scanning.
      }
    }
    return undefined;
  }
}
