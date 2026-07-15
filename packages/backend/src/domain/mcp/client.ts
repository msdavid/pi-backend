/**
 * Minimal MCP streamable-HTTP client (WP-3.3, spec §19).
 *
 * Implements just enough of the MCP streamable-HTTP transport to list and call
 * tools on a remote server:
 *
 * - JSON-RPC 2.0 over HTTP POST.
 * - `initialize` → `tools/list` → `tools/call`.
 * - Handles both `application/json` and `text/event-stream` responses (the
 *   streamable-HTTP spec allows either; for tool calls we take the first JSON-RPC
 *   result frame from an SSE stream).
 * - Echoes the server-issued `Mcp-Session-Id` header on subsequent requests.
 *
 * No external MCP SDK dependency is required (§19 lists streamable-HTTP as the
 * only transport; tunnels are Phase 4/never). A full SDK (`@modelcontextprotocol/sdk`)
 * would pull in transport fallbacks and node-version constraints this WP does not
 * need; the hand-rolled client is ~150 lines and fully under test with a mock
 * server. If batch notifications or resumable streams become required, swap this
 * implementation for the SDK — the {@link McpClient} surface is the seam.
 *
 * **Egress (SEC-2):** the MCP server URL is tenant-supplied, so every request goes
 * through the shared SSRF-pinned transport ({@link safeFetchPinned}, `domain/net/ssrf-pin.ts`)
 * by default — resolve → assert public → connect to the validated IP (no DNS-rebind
 * window), ports restricted to 80/443, redirects re-validated per hop. The injected
 * `Authorization` bearer is preserved on the INITIAL request only (`preserveRequestAuth`),
 * so a redirect cannot leak the credential to another host. The `fetch` impl stays
 * injectable for tests (which bypass the pinned transport with a mock).
 */

import { safeFetchPinned } from "../net/ssrf-pin.js";

/** A tool exposed by an MCP server (`tools/list` result item). */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters (already an object, not a string). */
  inputSchema?: Record<string, unknown>;
}

/** Result of calling an MCP tool (`tools/call` result). */
export interface McpCallResult {
  /** The textual content to surface to the model (concatenated text parts). */
  text: string;
  /** Whether the tool reported an error (`isError` on the MCP result). */
  isError: boolean;
  /** Raw structured content parts, for the bridge to spill/format. */
  raw: unknown;
}

/** Options for {@link McpClient}. */
export interface McpClientOptions {
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the SSRF-pinned transport (SEC-2). */
  fetch?: typeof fetch;
}

/** A live connection to one MCP streamable-HTTP server. */
export class McpClient {
  private readonly url: string;
  private readonly opts: Required<McpClientOptions>;
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(url: string, opts: McpClientOptions = {}) {
    this.url = url;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    this.opts = {
      timeoutMs,
      fetch: opts.fetch ?? pinnedMcpFetch(timeoutMs),
    };
  }

  /**
   * Perform the MCP `initialize` handshake. Stores the session id for later
   * requests. Returns the server's capabilities. Idempotent — a second call is
   * a no-op.
   */
  async initialize(
    headers: Record<string, string> = {},
  ): Promise<{ capabilities: unknown }> {
    if (this.initialized) return { capabilities: undefined };
    const res = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pi-managed-mcp-bridge", version: "0.0.0" },
    }, headers);
    this.initialized = true;
    // Per the MCP lifecycle, the client MUST send an `initialized` notification
    // after a successful `initialize`; compliant servers reject `tools/list`
    // (and other requests) until they receive it.
    await this.notify("notifications/initialized", {}, headers);
    // The server may return a session id via the Mcp-Session-Id header.
    return { capabilities: (res.result as Record<string, unknown> | undefined)?.capabilities };
  }

  /** List the tools exposed by the server. */
  async listTools(headers: Record<string, string> = {}): Promise<McpToolDescriptor[]> {
    const res = await this.rpc("tools/list", {}, headers);
    const tools = (res.result as { tools?: McpToolDescriptor[] } | undefined)?.tools ?? [];
    return tools;
  }

  /** Call a tool by name with the given arguments. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<McpCallResult> {
    const res = await this.rpc("tools/call", { name, arguments: args }, headers);
    const result = (res.result ?? {}) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const parts = result.content ?? [];
    const text = parts
      .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
      .filter((t) => t.length > 0)
      .join("\n");
    return { text, isError: result.isError === true, raw: res.result };
  }

  /** The URL this client is connected to. */
  get serverUrl(): string {
    return this.url;
  }

  /**
   * Send a JSON-RPC notification (a request with **no** `id`). The transport
   * replies with `202 Accepted` and an empty body, which we drain and discard.
   * Reuses the same session-id capture and error handling as {@link rpc}.
   */
  private async notify(
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    };
    if (this.sessionId) reqHeaders["Mcp-Session-Id"] = this.sessionId;

    let resp: Response;
    try {
      resp = await this.opts.fetch(this.url, {
        method: "POST",
        headers: reqHeaders,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new McpTransportError(
        `MCP notification to ${this.url} failed: ${(e as Error).message}`,
        { cause: e },
      );
    }

    // Capture session id on any response that carries it.
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (resp.status === 401 || resp.status === 403) {
      throw new McpAuthError(
        `MCP server ${this.url} rejected credentials (HTTP ${resp.status})`,
      );
    }
    if (!resp.ok) {
      throw new McpTransportError(
        `MCP server ${this.url} returned HTTP ${resp.status}`,
      );
    }
    // Drain the (empty) 202 body so the connection can be reused.
    await resp.text();
  }

  /**
   * Send a JSON-RPC request and await the matching response. Handles both JSON
   * and SSE-framed responses. Throws {@link McpTransportError} on network failure
   * or non-2xx HTTP status; throws {@link McpAuthError} on 401/403.
   */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ result?: unknown; error?: unknown }> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    };
    if (this.sessionId) reqHeaders["Mcp-Session-Id"] = this.sessionId;

    let resp: Response;
    try {
      resp = await this.opts.fetch(this.url, {
        method: "POST",
        headers: reqHeaders,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      throw new McpTransportError(
        `MCP request to ${this.url} failed: ${(e as Error).message}`,
        { cause: e },
      );
    }

    // Capture session id on any response that carries it.
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (resp.status === 401 || resp.status === 403) {
      throw new McpAuthError(
        `MCP server ${this.url} rejected credentials (HTTP ${resp.status})`,
      );
    }
    if (!resp.ok) {
      throw new McpTransportError(
        `MCP server ${this.url} returned HTTP ${resp.status}`,
      );
    }

    const ct = resp.headers.get("content-type") ?? "";
    let payload: unknown;
    if (ct.includes("text/event-stream")) {
      payload = parseSseJsonById(await resp.text(), id);
    } else {
      payload = await resp.json();
      const jsonEnv = payload as { id?: unknown } | undefined;
      if (jsonEnv && jsonEnv.id !== undefined && jsonEnv.id !== id) {
        throw new McpTransportError(
          `MCP server ${this.url} returned response id ${JSON.stringify(jsonEnv.id)} for request id ${id}`,
        );
      }
    }
    const env = payload as { result?: unknown; error?: unknown } | undefined;
    if (!env) {
      throw new McpTransportError(`MCP server ${this.url} returned no JSON-RPC frame`);
    }
    if (env.error !== undefined) {
      throw new McpTransportError(
        `MCP RPC error from ${this.url}: ${JSON.stringify(env.error)}`,
      );
    }
    return { result: env.result, error: env.error };
  }
}

/**
 * The default MCP `fetch`: route egress through the shared SSRF-pinned transport
 * (SEC-2). Keeps the caller-supplied `Authorization` bearer on the initial request
 * to the validated host (`preserveRequestAuth`) while pinning to the resolved public
 * IP, restricting ports to 80/443, and re-validating every redirect hop. The socket
 * timeout mirrors the client's configured `timeoutMs`; per-request abort still flows
 * through the `signal` the client passes in `init`.
 */
function pinnedMcpFetch(timeoutMs: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const { response } = await safeFetchPinned(url, init ?? {}, undefined, {
      preserveRequestAuth: true,
      timeoutMs,
    });
    return response;
  }) as typeof fetch;
}

/** Network/transport-level MCP failure (connection refused, timeout, 5xx, etc.). */
export class McpTransportError extends Error {
  constructor(message: string, opts?: ErrorOptions) {
    super(message, opts);
    this.name = "McpTransportError";
  }
}

/** The server rejected the injected credential (401/403). */
export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

/**
 * Parse the JSON-RPC frame whose `id` matches the request from an SSE stream.
 * The streamable-HTTP transport frames responses as SSE `event: message` /
 * `data: {...}` events, and a single stream may interleave server-originated
 * notifications (no `id`, or an unrelated `id`) before the matching response.
 * We iterate **all** `data:` frames, `JSON.parse` each, and return the first
 * whose `.id === id`, skipping frames that don't match.
 */
function parseSseJsonById(stream: string, id: number): unknown {
  let dataBuf = "";
  let inData = false;
  const frames: string[] = [];
  const flush = () => {
    if (inData && dataBuf.length > 0) frames.push(dataBuf);
    dataBuf = "";
    inData = false;
  };
  for (const line of stream.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataBuf += line.slice(5).trimStart();
      inData = true;
    } else if (line === "") {
      // Blank line terminates an SSE event.
      flush();
    }
  }
  flush();

  for (const frame of frames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      continue;
    }
    const env = parsed as { id?: unknown } | undefined;
    if (env && env.id === id) return parsed;
  }
  return undefined;
}
