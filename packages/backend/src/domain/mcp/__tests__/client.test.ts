/**
 * MCP streamable-HTTP client protocol correctness (R6.2).
 *
 * Uses an injected `fetch` mock (no network / no real server) to assert two
 * lifecycle invariants that compliant servers require:
 *
 * (a) after `initialize()` succeeds, a `notifications/initialized` JSON-RPC
 *     notification (NO `id`) is POSTed before any `tools/list`;
 * (b) an SSE response stream that begins with an unrelated server notification
 *     frame still returns the result frame matched by JSON-RPC `id`.
 */

import { describe, expect, it } from "vitest";
import { McpClient, McpTransportError } from "../client.js";

interface Recorded {
  body: Record<string, unknown>;
}

/** Build a JSON `application/json` Response for a JSON-RPC envelope. */
function jsonResponse(env: Record<string, unknown>): Response {
  return new Response(JSON.stringify(env), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Build a `text/event-stream` Response from raw SSE text. */
function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("McpClient protocol correctness (R6.2)", () => {
  it("sends notifications/initialized (no id) after initialize, before listTools", async () => {
    const recorded: Recorded[] = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      recorded.push({ body });
      // A notification (no id) gets a 202 with an empty body.
      if (body.id === undefined) {
        return new Response(null, { status: 202 });
      }
      // initialize / tools/list requests get a JSON-RPC result echoing the id.
      const result =
        body.method === "tools/list" ? { tools: [] } : { capabilities: {} };
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
    }) as unknown as typeof fetch;

    const client = new McpClient("https://mcp.example/rpc", { fetch: fetchMock });
    await client.initialize();
    await client.listTools();

    const methods = recorded.map((r) => r.body.method);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);

    const initializedFrame = recorded[1]!.body;
    expect(initializedFrame.id).toBeUndefined();
    expect(initializedFrame.jsonrpc).toBe("2.0");

    // The initialized notification must precede tools/list.
    const initializedIdx = methods.indexOf("notifications/initialized");
    const listIdx = methods.indexOf("tools/list");
    expect(initializedIdx).toBeLessThan(listIdx);
  });

  it("matches the SSE response frame by JSON-RPC id, skipping a leading notification frame", async () => {
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } });
      }
      // tools/list: reply as an SSE stream whose FIRST frame is an unrelated
      // server notification (no id), followed by the real result matched by id.
      const stream =
        `event: message\n` +
        `data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n` +
        `\n` +
        `event: message\n` +
        `data: {"jsonrpc":"2.0","id":${body.id},"result":{"tools":[{"name":"search"}]}}\n` +
        `\n`;
      return sseResponse(stream);
    }) as unknown as typeof fetch;

    const client = new McpClient("https://mcp.example/rpc", { fetch: fetchMock });
    await client.initialize();
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: "search" }]);
  });
});

describe("McpClient egress is SSRF-pinned by default (SEC-2)", () => {
  // No `fetch` injected → the client uses the shared SSRF-pinned transport. An
  // IP-literal target is classified without any DNS/socket, so these are hermetic:
  // reaching the pinned transport at all proves the raw-`fetch` bypass is gone.
  it("blocks a loopback target (SSRF)", async () => {
    const client = new McpClient("http://127.0.0.1/rpc");
    await expect(client.initialize()).rejects.toBeInstanceOf(McpTransportError);
    await expect(client.initialize()).rejects.toThrow(/loopback/);
  });

  it("blocks a disallowed port (not 80/443)", async () => {
    const client = new McpClient("http://127.0.0.1:8080/rpc");
    await expect(client.initialize()).rejects.toThrow(/port 8080 not allowed/);
  });
});
