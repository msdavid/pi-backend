/**
 * SSE streaming client for `GET /v1/sessions/:id/stream` (WP-C2.1;
 * console-spec §8.1, W3).
 *
 * Fetch streaming, NOT native `EventSource` (§8.1 — control over headers,
 * reconnect, and replay position). Same-origin and cookie-authed like every
 * other request (`credentials: "same-origin"`; the stream endpoint sits
 * behind the same global auth middleware as the rest of `/v1`).
 *
 * Lifecycle (mirrors the production SSE consumer in
 * `client-extension/src/api-client.ts` `streamSession`, §24.10 degradation):
 *
 * 1. Connect. Without `Last-Event-ID` the server replays the FULL persisted
 *    history from position 0; with it, replay resumes gap-free right after
 *    that position (api-reference §"Reconnect & replay"). Live and replayed
 *    frames carry the same projection-position SSE `id`, so `lastEventId`
 *    tracking works across both.
 * 2. A dropped connection (reader error / premature close) reconnects with
 *    exponential backoff, sending `Last-Event-ID: <last seen id>` — nothing
 *    missed, nothing duplicated.
 * 3. After {@link DEFAULT_MAX_CONNECT_FAILURES} consecutive failed connects
 *    (network error, non-2xx, non-`text/event-stream`), degrade to polling
 *    `GET /v1/sessions/:id/entries` — `seq` is the same monotonic position
 *    as the SSE `id` (contracts `SessionEntry`), so polled entries continue
 *    the exact same cursor and are emitted as synthetic frames.
 * 4. A clean server close (the session has no active runtime — replay done,
 *    nothing live to tail). For a session that is still non-terminal this is
 *    the *cold-idle* case: the backend serves a history-only stream for an
 *    idle session with no live runtime (`api/events.ts` — `getActiveRuntime`
 *    is `undefined`), and a later `user.message` (composer- OR CLI-initiated)
 *    wakes the runtime whose events are only observable on a *fresh*
 *    connection. So when {@link SessionStreamOptions.shouldReconnectOnClose}
 *    reports the session is not terminal, a clean close schedules a bounded
 *    idle reconnect (a modest {@link SessionStreamOptions.idleReconnectMs}
 *    cadence, `Last-Event-ID` set — gap-free, never busy-looped) instead of
 *    ending, so the wake becomes observable. Absent the predicate (or once it
 *    reports terminal) a clean close ends the stream: phase `"ended"`.
 * 5. Aborting `signal` stops everything (connection, backoff sleep, polling)
 *    and resolves the returned promise.
 *
 * The transport is always the real global `fetch` (CONVENTIONS.md "Fakes at
 * the seam") — tests may pass `baseUrl` + extra `headers` (a `Cookie`) at
 * call time, exactly like `ConsoleApiClient`. UI tests never reach this
 * module: the injected {@link SessionStreamer} collaborator
 * (`src/test/fake-console-api.ts`) stands in at the `useSessionStream` seam.
 */

import { withQuery } from "./pagination.js";

/** A parsed SSE frame: `event:` type + `data:` payload (+ the position `id`). */
export interface SseFrame {
  /** Projection position (the replay cursor, §9.3). Absent on delta frames. */
  id?: number;
  event: string;
  /** JSON-parsed `data:` payload (string when the payload is not JSON). */
  data: unknown;
}

/**
 * Where the stream currently gets its events from (the Trace tab's subtle
 * indicator, deliverable C§8.1):
 * - `connecting` — no events flowing; a connect/reconnect is in progress.
 * - `live`       — the SSE connection is open.
 * - `polling`    — SSE unusable; entries polling keeps the trace advancing.
 * - `ended`      — the server closed the stream cleanly (no active runtime).
 */
export type SessionStreamPhase = "connecting" | "live" | "polling" | "ended";

export interface SessionStreamHandlers {
  /** Every position-carrying frame (replayed, live, or polled). */
  onFrame: (frame: SseFrame) => void;
  /** Phase transitions (see {@link SessionStreamPhase}). */
  onPhase?: (phase: SessionStreamPhase) => void;
}

export interface SessionStreamOptions {
  /** Aborting stops the stream (connection, backoff, polling) cleanly. */
  signal: AbortSignal;
  /**
   * Resume position: the server replays events with position strictly greater
   * than this. Omit for the full history from position 0.
   */
  lastEventId?: number;
  /** Origin prefix — tests point this at the harness backend (default `""`). */
  baseUrl?: string;
  /** Extra request headers (tests: a `Cookie`). */
  headers?: Record<string, string>;
  /** Consecutive failed connects before degrading to entries polling. */
  maxConnectFailures?: number;
  /** Base reconnect backoff in ms (doubles per consecutive failure). */
  backoffMs?: number;
  /** Entries-polling interval in ms once degraded. */
  pollIntervalMs?: number;
  /**
   * Predicate consulted on a *clean* server close (history-only stream, no
   * live runtime). When it returns `true` the transport does NOT end — it
   * reconnects after {@link idleReconnectMs} so a later wake (composer- or
   * CLI-initiated) becomes observable (cold-wake case). Return `false` (the
   * default when omitted) to end the stream on a clean close, exactly as
   * before. Callers pass a check of the cached session status here
   * (`!isTerminalSessionStatus`, `session-stream.ts`).
   */
  shouldReconnectOnClose?: () => boolean;
  /** Idle reconnect cadence in ms after a clean close (see above). */
  idleReconnectMs?: number;
}

/** The callable shape of the stream transport (also what fakes implement). */
export type SessionStreamImpl = (
  sessionId: string,
  handlers: SessionStreamHandlers,
  opts: SessionStreamOptions,
) => Promise<void>;

/**
 * The optional stream capability of an injected API client. UI tests inject a
 * fake implementing this (the stream is a COLLABORATOR of the components
 * under test); the production `ConsoleApiClient` does not implement it, so
 * hooks fall back to {@link streamSessionEvents} — same-origin, real fetch.
 */
export interface SessionStreamer {
  streamSession: SessionStreamImpl;
}

/** N failed connects before the polling fallback (deliverable C§8.1). */
export const DEFAULT_MAX_CONNECT_FAILURES = 3;
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Idle reconnect cadence after a clean close of a non-terminal session. */
const DEFAULT_IDLE_RECONNECT_MS = 3_000;
/** Entries page size while polling (Trace-tab slice parity). */
const POLL_PAGE_LIMIT = 200;

/**
 * Open (and keep open) the session event stream, delivering frames to
 * `handlers` until the signal aborts, the server ends the stream cleanly, or
 * — after repeated connect failures — the polling fallback takes over.
 * Resolves when the stream is over; never rejects on transport trouble (that
 * is what the reconnect/polling ladder is for).
 */
export async function streamSessionEvents(
  sessionId: string,
  handlers: SessionStreamHandlers,
  opts: SessionStreamOptions,
): Promise<void> {
  const { signal } = opts;
  const maxFailures = opts.maxConnectFailures ?? DEFAULT_MAX_CONNECT_FAILURES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastId = opts.lastEventId;
  let failures = 0;

  while (!signal.aborted) {
    handlers.onPhase?.("connecting");
    if (failures > 0) {
      await sleep(Math.min(backoffMs * 2 ** (failures - 1), MAX_BACKOFF_MS), signal);
      if (signal.aborted) return;
    }

    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/stream`;
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl ?? ""}${path}`, {
        headers: {
          Accept: "text/event-stream",
          ...opts.headers,
          ...(lastId !== undefined ? { "Last-Event-ID": String(lastId) } : {}),
        },
        credentials: "same-origin",
        signal,
      });
    } catch {
      if (signal.aborted) return;
      failures += 1;
      if (failures >= maxFailures) return pollEntries(sessionId, handlers, opts, lastId);
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
      // SSE unusable (a proxy answering, an auth error, a route that is not
      // there) — count it toward the fallback ladder, like the extension.
      void res.body?.cancel().catch(() => {});
      failures += 1;
      if (failures >= maxFailures) return pollEntries(sessionId, handlers, opts, lastId);
      continue;
    }

    failures = 0;
    handlers.onPhase?.("live");
    try {
      for await (const frame of parseSseStream(res.body, signal)) {
        if (frame.id !== undefined) lastId = frame.id;
        handlers.onFrame(frame);
      }
    } catch {
      if (signal.aborted) return;
      // Reader dropped mid-stream — reconnect with `Last-Event-ID: lastId`
      // (backoff applies: a server that keeps dropping is not hot-looped).
      failures = 1;
      continue;
    }
    if (signal.aborted) return;
    // Clean end: the server closed the stream normally (history-only — no
    // active runtime to tail). If the session is still non-terminal it can
    // wake, and the wake is only observable on a fresh connection: reconnect
    // at a modest idle cadence (Last-Event-ID keeps the replay gap-free; the
    // sleep keeps it off a busy-loop). A terminal session — or a caller that
    // did not opt in — ends here, exactly like the extension.
    if (opts.shouldReconnectOnClose?.()) {
      handlers.onPhase?.("connecting");
      await sleep(opts.idleReconnectMs ?? DEFAULT_IDLE_RECONNECT_MS, signal);
      if (signal.aborted) return;
      continue;
    }
    handlers.onPhase?.("ended");
    return;
  }
}

/**
 * Degraded mode: poll `GET /v1/sessions/:id/entries?from=&limit=` and emit
 * each new entry as a synthetic frame (`id` = `seq`, `event` = `type`,
 * `data` = the entry). `seq` is the SSE replay cursor (contracts
 * `SessionEntry`), so the position ladder continues seamlessly from whatever
 * the stream last delivered. Polls until aborted; a full page skips the
 * inter-poll sleep to catch up.
 */
async function pollEntries(
  sessionId: string,
  handlers: SessionStreamHandlers,
  opts: SessionStreamOptions,
  lastEventId: number | undefined,
): Promise<void> {
  const { signal } = opts;
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let from = lastEventId !== undefined ? lastEventId + 1 : 0;
  handlers.onPhase?.("polling");

  while (!signal.aborted) {
    let full = false;
    try {
      const path = withQuery(
        `/v1/sessions/${encodeURIComponent(sessionId)}/entries`,
        { from, limit: POLL_PAGE_LIMIT },
      );
      const res = await fetch(`${opts.baseUrl ?? ""}${path}`, {
        headers: { Accept: "application/json", ...opts.headers },
        credentials: "same-origin",
        signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: unknown[] };
        const page = body.data ?? [];
        for (const raw of page) {
          const entry = raw as { seq?: unknown; type?: unknown };
          if (typeof entry.seq !== "number" || entry.seq < from) continue;
          from = entry.seq + 1;
          handlers.onFrame({
            id: entry.seq,
            event: typeof entry.type === "string" ? entry.type : "message",
            data: raw,
          });
        }
        full = page.length >= POLL_PAGE_LIMIT;
      } else {
        void res.body?.cancel().catch(() => {});
      }
    } catch {
      if (signal.aborted) return;
      // Transient poll failure — keep the interval cadence and retry.
    }
    if (!full) await sleep(interval, signal);
  }
}

/**
 * Parse an SSE byte stream into frames. Frames are separated by a blank line;
 * `data:` may span multiple lines (joined with `\n` per the SSE spec);
 * comment lines (`:`) are ignored. Throws when the underlying reader errors
 * (a dropped connection) — the caller's reconnect loop handles it.
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = parseSseFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (frame) yield frame;
      }
    }
    if (buffer.trim()) {
      const frame = parseSseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse one raw SSE frame (the text between blank-line separators), or `null`
 * when it carries no `data:` (comments, keep-alives).
 */
export function parseSseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/);
  let id: number | undefined;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") {
      const n = Number(value);
      if (Number.isFinite(n)) id = n;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join("\n");
  let data: unknown = dataText;
  try {
    data = JSON.parse(dataText);
  } catch {
    // Non-JSON payload stays a string.
  }
  return { ...(id !== undefined ? { id } : {}), event, data };
}

/** Abort-aware sleep: resolves early (never rejects) when the signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
