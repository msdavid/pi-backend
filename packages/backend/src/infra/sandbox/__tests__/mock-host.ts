/**
 * Mock KVM host for the multi-host suites (WP-4.3 / R6.7, §6).
 *
 * A Node `http` server implementing the §6 host-agent wire contract, backed by an
 * in-memory fake provider, enforcing the §6.1 bearer-token check on every request
 * (`/healthz` included). Shared by `multi-host.test.ts` (provider routing/placement)
 * and `multi-host-composition.test.ts` (the composition root's `SANDBOX_MODE=multi`).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { isValidHostAgentToken } from "../../sandbox-host-pool/auth.js";
import type {
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxStatus,
  SecretBinding,
} from "../../../domain/ports.js";

/** The shared secret every mock host expects by default (§6.1 trust model). */
export const HOST_TOKEN = "test-host-agent-secret";

/** A minimal in-memory host-side provider backing a mock host server. */
export class FakeHostProvider {
  private readonly vms = new Map<
    string,
    { handle: SandboxHandle; status: SandboxStatus }
  >();

  constructor(public readonly hostId: string) {}

  provision(spec: ProvisionSpec): SandboxHandle {
    const handle: SandboxHandle = {
      id: spec.name,
      name: spec.name,
      labels: spec.labels,
    };
    this.vms.set(spec.name, { handle, status: "running" });
    return handle;
  }
  exec(_handle: SandboxHandle, opts: ExecOptions): ExecResult {
    return { stdout: `ran:${opts.cmd}`, stderr: "", exitCode: 0 };
  }
  stop(handle: SandboxHandle): void {
    this.vms.get(handle.name)!.status = "stopped";
  }
  start(handle: SandboxHandle): void {
    this.vms.get(handle.name)!.status = "running";
  }
  snapshot(handle: SandboxHandle): string {
    return `${handle.name}-snap`;
  }
  destroy(handle: SandboxHandle): void {
    this.vms.delete(handle.name);
  }
  status(handle: SandboxHandle): SandboxStatus {
    return this.vms.get(handle.name)?.status ?? "crashed";
  }
  registerSecretBinding(_handle: SandboxHandle, _binding: SecretBinding): void {}
  listByLabels(labels: { tenant: string; session?: string }): SandboxHandle[] {
    const out: SandboxHandle[] = [];
    for (const { handle } of this.vms.values()) {
      if (handle.labels.tenant !== labels.tenant) continue;
      if (labels.session !== undefined && handle.labels.session !== labels.session) {
        continue;
      }
      out.push(handle);
    }
    return out;
  }
  /** Number of VMs currently on this host (assertions). */
  get vmCount(): number {
    return this.vms.size;
  }
}

/**
 * A mock host: an HTTP server implementing the §6 wire contract, backed by a
 * {@link FakeHostProvider}. The `HttpHostAgent` client talks to this.
 */
export class MockHost {
  readonly provider: FakeHostProvider;
  private server: http.Server | undefined;
  private healthzOk = true;
  endpoint = "";

  constructor(
    hostId: string,
    private readonly token: string = HOST_TOKEN,
  ) {
    this.provider = new FakeHostProvider(hostId);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const addr = this.server!.address() as AddressInfo;
    this.endpoint = `http://127.0.0.1:${addr.port}`;
  }

  /** Toggle the /healthz response to simulate failure. */
  setHealthy(ok: boolean): void {
    this.healthzOk = ok;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url ?? "";
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
    const read = async <T>(): Promise<T> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      return (text ? JSON.parse(text) : {}) as T;
    };

    // §6.1 trust model: the host-agent channel is authenticated on every request,
    // /healthz included. A missing/wrong bearer token → 401 (no body).
    if (!isValidHostAgentToken(req.headers.authorization, this.token)) {
      return send(401);
    }

    if (req.method === "GET" && url === "/healthz") {
      return send(this.healthzOk ? 200 : 503, this.healthzOk ? { ok: true } : undefined);
    }
    try {
      if (req.method === "POST" && url === "/provision") {
        return send(200, this.provider.provision(await read<ProvisionSpec>()));
      }
      if (req.method === "POST" && url === "/exec") {
        const { handle, opts } = await read<{
          handle: SandboxHandle;
          opts: ExecOptions;
        }>();
        return send(200, this.provider.exec(handle, opts));
      }
      if (req.method === "POST" && url === "/stop") {
        this.provider.stop((await read<{ handle: SandboxHandle }>()).handle);
        return send(204);
      }
      if (req.method === "POST" && url === "/start") {
        this.provider.start((await read<{ handle: SandboxHandle }>()).handle);
        return send(204);
      }
      if (req.method === "POST" && url === "/snapshot") {
        const { handle } = await read<{ handle: SandboxHandle }>();
        return send(200, { id: this.provider.snapshot(handle) });
      }
      if (req.method === "POST" && url === "/destroy") {
        this.provider.destroy((await read<{ handle: SandboxHandle }>()).handle);
        return send(204);
      }
      if (req.method === "POST" && url === "/status") {
        const { handle } = await read<{ handle: SandboxHandle }>();
        return send(200, this.provider.status(handle));
      }
      if (req.method === "POST" && url === "/register-secret-binding") {
        const { handle, binding } = await read<{
          handle: SandboxHandle;
          binding: SecretBinding;
        }>();
        this.provider.registerSecretBinding(handle, binding);
        return send(204);
      }
      if (req.method === "POST" && url === "/list-by-labels") {
        return send(
          200,
          this.provider.listByLabels(
            await read<{ tenant: string; session?: string }>(),
          ),
        );
      }
      return send(404);
    } catch (err) {
      return send(500, { error: String(err) });
    }
  }
}
