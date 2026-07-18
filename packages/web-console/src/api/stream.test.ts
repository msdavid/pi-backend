// @vitest-environment node
/**
 * Unit tests for the SSE streaming client (WP-C2.1; console-spec §8.1).
 *
 * The transport behaviors (reconnect with `Last-Event-ID`, backoff ladder,
 * polling fallback, clean abort) are driven against a REAL local `http`
 * server over the real global `fetch` — the other side of the boundary is
 * real (CONVENTIONS.md "Fakes at the seam"); the server merely scripts
 * responses. The full client↔backend seam (real replay, real drop/resume)
 * lives in `__tests__/stream.contract.test.ts`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSseFrame,
  streamSessionEvents,
  type SessionStreamPhase,
  type SseFrame,
} from "./stream.js";

/** Encode one SSE frame the way the backend's sse-encoder does. */
function sse(frame: { id?: number; event: string; data: unknown }): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}

interface SeenRequest {
  url: string;
  headers: IncomingMessage["headers"];
}

/** A scripted local server: the handler is swapped per test. */
interface TestServer {
  baseUrl: string;
  requests: SeenRequest[];
  handle: (req: IncomingMessage, res: ServerResponse, nth: number) => void;
  close: () => Promise<void>;
}

const servers: Server[] = [];

async function startServer(
  handle: TestServer["handle"],
): Promise<TestServer> {
  const requests: SeenRequest[] = [];
  const state: TestServer = {
    baseUrl: "",
    requests,
    handle,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    state.handle(req, res, requests.length);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Poll until `predicate` holds (frames arrive asynchronously). */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Collecting handlers + the collections themselves. */
function collector(): {
  frames: SseFrame[];
  phases: SessionStreamPhase[];
  onFrame: (f: SseFrame) => void;
  onPhase: (p: SessionStreamPhase) => void;
} {
  const frames: SseFrame[] = [];
  const phases: SessionStreamPhase[] = [];
  return {
    frames,
    phases,
    onFrame: (f) => frames.push(f),
    onPhase: (p) => phases.push(p),
  };
}

describe("parseSseFrame", () => {
  it("parses id + event + JSON data", () => {
    expect(parseSseFrame('id: 7\nevent: agent.message\ndata: {"content":"hi"}')).toEqual({
      id: 7,
      event: "agent.message",
      data: { content: "hi" },
    });
  });

  it("joins multi-line data with newlines per the SSE spec", () => {
    expect(parseSseFrame("event: x\ndata: line one\ndata: line two")).toEqual({
      event: "x",
      data: "line one\nline two",
    });
  });

  it("defaults the event type to message and keeps non-JSON data a string", () => {
    expect(parseSseFrame("data: plain text")).toEqual({
      event: "message",
      data: "plain text",
    });
  });

  it("ignores comment lines and returns null for data-less frames", () => {
    expect(parseSseFrame(": keep-alive")).toBeNull();
    expect(parseSseFrame("id: 3\nevent: ping")).toBeNull();
    expect(parseSseFrame(": note\ndata: 1")).toEqual({ event: "message", data: 1 });
  });
});

describe("streamSessionEvents ↔ real local server", () => {
  it("connects with SSE headers, delivers frames, and aborts cleanly", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ id: 0, event: "user.message", data: { type: "user.message" } }));
      res.write(sse({ id: 1, event: "agent.message", data: { type: "agent.message" } }));
      // Keep the connection open — the live tail.
    });
    const c = collector();
    const controller = new AbortController();
    const done = streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      headers: { Cookie: "pi_console=abc" },
    });

    await until(() => c.frames.length === 2);
    controller.abort();
    await done; // resolves cleanly on abort

    expect(c.frames.map((f) => f.id)).toEqual([0, 1]);
    expect(c.phases).toEqual(["connecting", "live"]);
    const req = server.requests[0]!;
    expect(req.url).toBe("/v1/sessions/sess_01AAA/stream");
    expect(req.headers.accept).toBe("text/event-stream");
    expect(req.headers.cookie).toBe("pi_console=abc");
    expect(req.headers["last-event-id"]).toBeUndefined();
  });

  it("sends the caller's lastEventId on first connect (cache-primed resume)", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse({ id: 5, event: "agent.message", data: {} }));
    });
    const c = collector();
    const controller = new AbortController();
    await streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      lastEventId: 4,
    });
    expect(server.requests[0]!.headers["last-event-id"]).toBe("4");
    expect(c.phases.at(-1)).toBe("ended");
  });

  it("a clean server close ends the stream (phase ended, promise resolves)", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse({ id: 0, event: "session.status_idle", data: { stopReason: "completed" } }));
    });
    const c = collector();
    await streamSessionEvents("sess_01AAA", c, {
      signal: new AbortController().signal,
      baseUrl: server.baseUrl,
    });
    expect(c.frames.map((f) => f.id)).toEqual([0]);
    expect(c.phases).toEqual(["connecting", "live", "ended"]);
  });

  it("clean close of a non-terminal session reconnects (cold-wake), sending Last-Event-ID — F1", async () => {
    // The cold-idle backend: first connect replays history then closes
    // cleanly (no live runtime); a wake arrives only on a fresh connection.
    const server = await startServer((_req, res, nth) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (nth === 1) {
        // History-only, then a CLEAN end (not a socket drop).
        res.end(sse({ id: 4, event: "session.status_idle", data: { stopReason: "completed" } }));
      } else {
        // The reconnect observes the wake the composer/CLI just triggered.
        res.write(sse({ id: 5, event: "session.status_run_started", data: {} }));
        // Stay open (live tail) until the client aborts.
      }
    });
    const c = collector();
    const controller = new AbortController();
    const done = streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      shouldReconnectOnClose: () => true, // non-terminal → keep observing
      idleReconnectMs: 1,
    });

    // Without the reconnect the stream would end after frame 4 and never see 5.
    await until(() => c.frames.some((f) => f.id === 5));
    controller.abort();
    await done;

    expect(c.frames.map((f) => f.id)).toEqual([4, 5]);
    expect(server.requests).toHaveLength(2);
    // Gap-free: the reconnect resumes right after the last replayed position.
    expect(server.requests[1]!.headers["last-event-id"]).toBe("4");
    // The Trace indicator never latches "ended" for a session that can wake.
    expect(c.phases).not.toContain("ended");
  });

  it("clean close ends (no reconnect) when the predicate reports terminal — F1", async () => {
    let requests = 0;
    const server = await startServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse({ id: 9, event: "session.status_terminated", data: {} }));
    });
    const c = collector();
    await streamSessionEvents("sess_01AAA", c, {
      signal: new AbortController().signal,
      baseUrl: server.baseUrl,
      shouldReconnectOnClose: () => false, // terminal → stop, no reconnect
      idleReconnectMs: 1,
    });
    expect(requests).toBe(1);
    expect(c.phases).toEqual(["connecting", "live", "ended"]);
  });

  it("reconnects after a mid-stream drop with Last-Event-ID — no miss, no duplicate", async () => {
    const server = await startServer((_req, res, nth) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (nth === 1) {
        res.write(sse({ id: 0, event: "a", data: { n: 0 } }));
        res.write(sse({ id: 1, event: "b", data: { n: 1 } }));
        // Abrupt drop, not a clean end: the client must resume, not stop.
        setTimeout(() => res.socket?.destroy(), 20);
      } else {
        res.write(sse({ id: 2, event: "c", data: { n: 2 } }));
        // Stay open until the client aborts.
      }
    });
    const c = collector();
    const controller = new AbortController();
    const done = streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      backoffMs: 1,
    });

    await until(() => c.frames.length === 3);
    controller.abort();
    await done;

    expect(c.frames.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.headers["last-event-id"]).toBe("1");
    expect(c.phases).toEqual(["connecting", "live", "connecting", "live"]);
  });

  it("falls back to entries polling after N failed connects; entries keep advancing", async () => {
    const entryPages = [
      [
        { seq: 0, type: "user.message", processedAt: null },
        { seq: 1, type: "agent.message", processedAt: null },
      ],
      [{ seq: 2, type: "session.status_idle", processedAt: null }],
    ];
    let entriesServed = 0;
    const server = await startServer((req, res) => {
      if (req.url!.includes("/stream")) {
        // SSE unusable: a JSON 404, like a backend without the events routes.
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: "no route" } }));
        return;
      }
      const page = entryPages[entriesServed] ?? [];
      entriesServed += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: page, nextCursor: null }));
    });
    const c = collector();
    const controller = new AbortController();
    const done = streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      maxConnectFailures: 2,
      backoffMs: 1,
      pollIntervalMs: 5,
    });

    await until(() => c.frames.length === 3);
    controller.abort();
    await done;

    const streamHits = server.requests.filter((r) => r.url.includes("/stream"));
    expect(streamHits).toHaveLength(2); // exactly N failed connects
    expect(c.phases).toContain("polling");
    expect(c.phases).not.toContain("live");
    expect(c.frames.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(c.frames[2]!.event).toBe("session.status_idle");

    // The poll cursor advances positionally: the second entries request asks
    // for seq ≥ 2 (nothing re-fetched, nothing skipped).
    const entryHits = server.requests.filter((r) => r.url.includes("/entries"));
    expect(entryHits[0]!.url).toContain("from=0");
    expect(entryHits[1]!.url).toContain("from=2");
  });

  it("aborting during the polling fallback resolves promptly", async () => {
    const server = await startServer((req, res) => {
      if (req.url!.includes("/stream")) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("bad gateway");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [], nextCursor: null }));
    });
    const c = collector();
    const controller = new AbortController();
    const done = streamSessionEvents("sess_01AAA", c, {
      signal: controller.signal,
      baseUrl: server.baseUrl,
      maxConnectFailures: 1,
      backoffMs: 1,
      pollIntervalMs: 10_000, // abort must cut this sleep short
    });
    await until(() => c.phases.includes("polling"));
    controller.abort();
    await done;
  });
});
