/**
 * Host-agent HTTPS server (WP-R0.4, §6, §6.1 trust model).
 *
 * The privileged control listener that runs *on each KVM host*, wrapping that host's local
 * {@link SandboxProvider} (a {@link MicrosandboxProvider} in production). It is the deployed
 * counterpart to {@link HttpHostAgent} (`infra/sandbox/multi-host-provider.ts`): the backend's
 * `MultiHostSandboxProvider` speaks the §6 wire contract to one of these per host.
 *
 * **This channel is privileged** — `/exec` runs arbitrary commands inside any VM on the host,
 * `/list-by-labels` enumerates VMs across tenants, `/register-secret-binding` wires credentials.
 * Two layers guard it (§6.1):
 *
 *  1. **Bearer token, every request (`/healthz` included).** Before *any* handler runs, the
 *     presented `Authorization` header is checked with {@link isValidHostAgentToken} against the
 *     expected per-host secret resolved via {@link createHostAgentTokenSource} over the process
 *     environment. A missing / malformed / wrong token → `401` with no body. An open `/healthz`
 *     would be a free host-liveness oracle, so it is authenticated too.
 *  2. **Mutual TLS.** The listener is created with `requestCert: true`, `rejectUnauthorized:
 *     true`, and `ca: [backendCA]`, so a caller that cannot present a client certificate signed
 *     by the backend's internal CA never completes the TLS handshake — the bearer token is never
 *     even read. The bearer token is defence in depth above the transport.
 *
 * Wire contract (mirrors {@link HttpHostAgent}; `docs/spec/multi-host-design.md` §6):
 *  - `GET  /healthz`                 → `200 {ok:true}` (authenticated)
 *  - `POST /provision` (ProvisionSpec)        → `SandboxHandle`
 *  - `POST /exec` ({handle, opts})            → `ExecResult`
 *  - `POST /stop` | `/start` | `/destroy` ({handle}) → `204`
 *  - `POST /snapshot` ({handle})              → `{id}`
 *  - `POST /status` ({handle})                → `SandboxStatus`
 *  - `POST /register-secret-binding` ({handle, binding}) → `204`
 *  - `POST /list-by-labels` ({tenant, session?}) → `SandboxHandle[]`
 */

import https from "node:https";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ExecOptions,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SecretBinding,
} from "../../domain/ports.js";
import {
  createHostAgentTokenSource,
  isValidHostAgentToken,
  type EnvLike,
} from "./auth.js";
import type { SandboxHost } from "./types.js";

/** Minimal logger surface (matches the project's pino usage; never receives secrets). */
export interface HostAgentServerLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** TLS material for the mTLS listener (PEM strings or buffers). */
export interface HostAgentServerTls {
  /** Server certificate presented to the backend. */
  cert: string | Buffer;
  /** Server private key. */
  key: string | Buffer;
  /** The backend's internal CA that must have signed the *client* cert. */
  ca: string | Buffer | Array<string | Buffer>;
}

/** Options for {@link createHostAgentServer}. */
export interface HostAgentServerOptions {
  /** This host's local sandbox provider (a `MicrosandboxProvider` in production). */
  provider: SandboxProvider;
  /** mTLS material: server cert/key + the backend CA that signs client certs (§6.1). */
  tls: HostAgentServerTls;
  /**
   * Environment used to resolve the expected per-host bearer secret via
   * {@link createHostAgentTokenSource}. Defaults to `process.env`.
   */
  env?: EnvLike;
  /**
   * This host's id, used to pick a per-host secret override
   * (`SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>`) before the pool-wide fallback. Defaults to
   * `env.HOST_AGENT_HOST_ID ?? ""` (empty id → pool-wide secret only).
   */
  hostId?: string;
  logger?: HostAgentServerLogger;
}

/** Build a minimal {@link SandboxHost} for token resolution (only `.id` is read). */
function hostFor(id: string): SandboxHost {
  return {
    id,
    endpoint: "",
    cpus: 0,
    memoryMiB: 0,
    status: "healthy",
    labels: {},
    lastHeartbeat: null,
    createdAt: "",
    updatedAt: "",
  };
}

/** Load the mTLS material from env file paths (`HOST_AGENT_TLS_CERT/KEY/CA`). */
export function loadHostAgentTlsFromEnv(env: EnvLike = process.env): HostAgentServerTls {
  const certPath = env.HOST_AGENT_TLS_CERT;
  const keyPath = env.HOST_AGENT_TLS_KEY;
  const caPath = env.HOST_AGENT_TLS_CA;
  if (!certPath || !keyPath || !caPath) {
    throw new Error(
      "Host-agent TLS not configured: set HOST_AGENT_TLS_CERT, HOST_AGENT_TLS_KEY, " +
        "and HOST_AGENT_TLS_CA to PEM file paths (§6.1 mTLS)",
    );
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    ca: readFileSync(caPath),
  };
}

/**
 * Create the host-agent HTTPS server. Not yet listening — the caller invokes `.listen()`.
 *
 * Terminates mutual TLS (client cert signed by the backend CA required) and enforces the
 * bearer token on every request, `/healthz` included (§6.1).
 */
export function createHostAgentServer(opts: HostAgentServerOptions): https.Server {
  const env = opts.env ?? process.env;
  const hostId = opts.hostId ?? env.HOST_AGENT_HOST_ID ?? "";
  // Resolve the expected per-host secret once at construction (fails closed if unset).
  const expectedToken = createHostAgentTokenSource(env)(hostFor(hostId));
  const { provider, logger } = opts;

  const caList = Array.isArray(opts.tls.ca) ? opts.tls.ca : [opts.tls.ca];

  const server = https.createServer(
    {
      cert: opts.tls.cert,
      key: opts.tls.key,
      ca: caList,
      // §6.1 mTLS: demand a client cert signed by the backend CA; reject otherwise at
      // the TLS layer — no HTTP handler (not even /healthz) runs for an unverified peer.
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      void handle(req, res, expectedToken, provider, logger);
    },
  );
  return server;
}

/** Dispatch a single request: authenticate, then route to the provider. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
  provider: SandboxProvider,
  logger: HostAgentServerLogger | undefined,
): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";

  const send = (code: number, body?: unknown): void => {
    if (body === undefined) {
      res.statusCode = code;
      res.end();
      return;
    }
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  // §6.1: authenticate EVERY request (including /healthz) before doing any work.
  // A missing/malformed/wrong token → 401 with no body. The token is never logged.
  if (!isValidHostAgentToken(req.headers.authorization, expectedToken)) {
    return send(401);
  }

  if (method === "GET" && url === "/healthz") {
    return send(200, { ok: true });
  }

  const read = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) : {};
  };

  try {
    if (method === "POST" && url === "/provision") {
      const spec = (await read()) as ProvisionSpec;
      return send(200, await provider.provision(spec));
    }
    if (method === "POST" && url === "/exec") {
      const { handle: h, opts } = (await read()) as {
        handle: SandboxHandle;
        opts: ExecOptions;
      };
      return send(200, await provider.exec(h, opts));
    }
    if (method === "POST" && url === "/stop") {
      const { handle: h } = (await read()) as { handle: SandboxHandle };
      await provider.stop(h);
      return send(204);
    }
    if (method === "POST" && url === "/start") {
      const { handle: h } = (await read()) as { handle: SandboxHandle };
      await provider.start(h);
      return send(204);
    }
    if (method === "POST" && url === "/snapshot") {
      const { handle: h } = (await read()) as { handle: SandboxHandle };
      return send(200, { id: await provider.snapshot(h) });
    }
    if (method === "POST" && url === "/destroy") {
      const { handle: h } = (await read()) as { handle: SandboxHandle };
      await provider.destroy(h);
      return send(204);
    }
    if (method === "POST" && url === "/status") {
      const { handle: h } = (await read()) as { handle: SandboxHandle };
      return send(200, await provider.status(h));
    }
    if (method === "POST" && url === "/register-secret-binding") {
      const { handle: h, binding } = (await read()) as {
        handle: SandboxHandle;
        binding: SecretBinding;
      };
      await provider.registerSecretBinding(h, binding);
      return send(204);
    }
    if (method === "POST" && url === "/list-by-labels") {
      const labels = (await read()) as { tenant: string; session?: string };
      // The pool-level `listByLabels` maps to the provider's boot-time re-attach scan (§5).
      return send(200, await provider.reattachByLabels(labels));
    }
    return send(404);
  } catch (err) {
    logger?.error({ err: String(err), path: url }, "host-agent request failed");
    return send(500, { error: String(err) });
  }
}
