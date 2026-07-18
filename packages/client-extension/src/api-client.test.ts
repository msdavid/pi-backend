/**
 * Unit tests for the client's request-shaping and SSE-frame parsing.
 *
 * seam-ok: KNOWN EXEMPTION, not an endorsement. Every `fetchImpl` below is a fake standing
 * in for the server side of the client↔server seam — the exact shape that let the SSE 404
 * (R3.1) ship green: the client streamed `…/events/stream`, the backend served `…/stream`,
 * and this file "passed" because it asserted the URL its own client produced against its own
 * stub. A stubbed transport can only ever confirm what the client already believes.
 *
 * These cases therefore prove header/idempotency-key/frame-parsing MECHANICS and nothing
 * about the wire contract. The URL, method and status contract is owned by the R3.2
 * conformance suite, which must exercise every `api-client.ts` method against a REAL
 * in-process Fastify app. When that suite lands, delete this exemption (and any assertion
 * here on a URL a stub echoed back) — the lint rule `seam/no-fake-at-seam` will then keep
 * the seam honest on its own.
 */
import { describe, it, expect } from "vitest";
import { ManagedApiClient, parseSseFrame } from "./api-client.js";
import type { TenantInfo } from "@pi-managed/contracts";

const enc = new TextEncoder();

const TENANT: TenantInfo = {
  tenantId: "t_01J",
  name: "Acme",
  quotaPlan: "pro",
  quotaUsage: {
    concurrentSessions: 0,
    concurrentSandboxes: 0,
    jobs: 0,
    vaultSize: 0,
    memorySize: 0,
    fileStorage: 0,
    tokenSpendUsd: 0,
  },
  quotaLimits: {
    concurrentSessions: 10,
    concurrentSandboxes: 10,
    maxJobs: 100,
    maxVaultCredentials: 100,
    maxMemoryStores: 25,
    maxFileStorageBytes: 10737418240,
    monthlyTokenSpendUsd: 200,
  },
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseSseFrame", () => {
  it("parses id/event/data and JSON-decodes data", () => {
    const f = parseSseFrame(
      "id: 7\nevent: agent.message\ndata: {\"type\":\"agent.message\",\"content\":\"hi\"}",
    );
    expect(f).toEqual({
      id: 7,
      event: "agent.message",
      data: { type: "agent.message", content: "hi" },
    });
  });
  it("joins multi-line data and defaults event to message", () => {
    const f = parseSseFrame("data: line1\ndata: line2");
    expect(f?.event).toBe("message");
    expect(f?.data).toBe("line1\nline2");
  });
  it("ignores comments and frames without data", () => {
    expect(parseSseFrame(": keep-alive")).toBeNull();
    expect(parseSseFrame("id: 1")).toBeNull();
  });
});

describe("ManagedApiClient REST", () => {
  it("sends bearer auth + idempotency key and returns typed body", async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, headers: init.headers as Record<string, string> });
      return jsonRes(TENANT);
    };
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "secret-key",
      fetchImpl,
    });
    const tenant = await client.getTenant();
    expect(tenant).toEqual(TENANT);
    expect(calls[0].url).toBe("https://api.example/v1/tenant");
    expect(calls[0].headers["Authorization"]).toBe("Bearer secret-key");
  });

  it("auto-generates an Idempotency-Key for POST", async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> });
      return jsonRes({ id: "sess_01", status: "idle" }, 201);
    };
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "k",
      fetchImpl,
    });
    await client.createSession({
      agent: "agent_01",
      environmentId: "env_01",
    });
    expect(calls[0].headers["Idempotency-Key"]).toBeTruthy();
  });

  it("throws ApiClientError with code + status on error envelope", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { code: "unauthorized", message: "bad key", requestId: "req_1" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "bad",
      fetchImpl,
    });
    await expect(client.getTenant()).rejects.toMatchObject({
      name: "ApiClientError",
      code: "unauthorized",
      status: 401,
      requestId: "req_1",
    });
  });

  it("consoleSessionUrl derives the deep link from the backend URL (console-spec §1.4)", () => {
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "k",
    });
    expect(client.consoleSessionUrl("sess_01")).toBe(
      "https://api.example/console/sessions/sess_01",
    );
    // Trailing slash on the configured URL must not double up.
    const slashed = new ManagedApiClient({
      backendUrl: "https://api.example/",
      getApiKey: () => "k",
    });
    expect(slashed.consoleSessionUrl("sess_01")).toBe(
      "https://api.example/console/sessions/sess_01",
    );
  });
});

describe("ManagedApiClient SSE reconnect", () => {
  it("reconnects with Last-Event-ID and replays after a drop", async () => {
    const calls: { lastEventId?: string; auth?: string }[] = [];
    let call = 0;
    const fetchImpl = async (url: string, init: RequestInit) => {
      call++;
      const headers = init.headers as Record<string, string>;
      calls.push({ lastEventId: headers["Last-Event-ID"], auth: headers["Authorization"] });
      expect(url).toContain("/v1/sessions/sess_1/stream");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // enqueue the first frame up front so it is delivered before any error
          if (call === 1) {
            controller.enqueue(
              enc.encode(
                "id: 1\nevent: agent.message\ndata: {\"type\":\"agent.message\",\"content\":\"one\"}\n\n",
              ),
            );
          } else {
            controller.enqueue(
              enc.encode(
                "id: 2\nevent: agent.message\ndata: {\"type\":\"agent.message\",\"content\":\"two\"}\n\n",
              ),
            );
          }
        },
        pull(controller) {
          // consumer consumed the queued frame and asks for more
          if (call === 1) {
            controller.error(new Error("connection dropped"));
          } else {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "sse-key",
      fetchImpl,
    });

    const frames = [];
    for await (const f of client.streamSession("sess_1")) frames.push(f);

    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames[1].data).toMatchObject({ content: "two" });
    // first connect: no Last-Event-ID; reconnect sends Last-Event-ID: 1
    expect(calls[0].lastEventId).toBeUndefined();
    expect(calls[1].lastEventId).toBe("1");
    expect(calls[0].auth).toBe("Bearer sse-key");
  });

  it("requests the canonical /stream path (not /events/stream)", async () => {
    let recordedUrl = "";
    const fetchImpl = async (url: string, _init: RequestInit) => {
      recordedUrl = url;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(
              "id: 1\nevent: agent.message\ndata: {\"type\":\"agent.message\",\"content\":\"one\"}\n\n",
            ),
          );
        },
        pull(controller) {
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "sse-key",
      fetchImpl,
    });
    const frames = [];
    for await (const f of client.streamSession("sess_1")) frames.push(f);
    expect(new URL(recordedUrl).pathname).toBe("/v1/sessions/sess_1/stream");
    expect(frames.map((f) => f.id)).toEqual([1]);
  });

  it("falls back to polling when SSE content-type is not event-stream", async () => {
    let streamCall = 0;
    let pollCall = 0;
    const fetchImpl = async (url: string, _init: RequestInit) => {
      if (url.includes("/stream")) {
        streamCall++;
        return new Response("not supported", { status: 406, headers: { "content-type": "text/plain" } });
      }
      // polling: GET /v1/sessions/:id/events
      expect(url).toContain("/v1/sessions/sess_2/events");
      pollCall++;
      return jsonRes({
        data: [{ seq: 5, type: "agent.message", processedAt: "2026-07-13T00:00:00Z" }],
        nextCursor: null,
      });
    };
    const client = new ManagedApiClient({
      backendUrl: "https://api.example",
      getApiKey: () => "k",
      fetchImpl,
      pollingIntervalMs: 10,
      streamTimeoutMs: 1000,
    });
    const ctrl = new AbortController();
    const frames = [];
    for await (const f of client.streamSession("sess_2", { signal: ctrl.signal })) {
      frames.push(f);
      if (frames.length === 1) ctrl.abort(); // stop after first polled entry
    }
    expect(streamCall).toBe(1);
    expect(pollCall).toBeGreaterThanOrEqual(1);
    expect(frames[0]).toEqual({
      id: 5,
      event: "agent.message",
      data: { type: "agent.message", processedAt: "2026-07-13T00:00:00Z" },
    });
  });
});
