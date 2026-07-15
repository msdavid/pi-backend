/**
 * @pi-managed/client — typed REST + SSE client over the Pi Managed Backend
 * (docs/api-reference.md).
 *
 * REST uses Node 20's global `fetch`. SSE is parsed with a minimal frame
 * parser; `streamSession` reconnects with `Last-Event-ID` (§9.3) and falls
 * back to polling `GET /v1/sessions/:id/events` when SSE is unusable (§24.10).
 * No runtime dependencies beyond `@pi-managed/contracts` types.
 */

import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentCreate,
  Credential,
  CredentialCreate,
  CredentialValidateResponse,
  Cursor,
  InboundEvent,
  Job,
  JobCreate,
  JobRun,
  JobRunTriggerResponse,
  Memory,
  MemoryCreate,
  MemoryStore,
  MemoryStoreCreate,
  MemorySummary,
  MemoryUpdate,
  MemoryVersion,
  Session,
  SessionCreate,
  SessionEntry,
  SessionUsageResponse,
  TenantInfo,
  Vault,
  VaultCreate,
} from "@pi-managed/contracts";

/** A parsed SSE frame: the `event` line value + the `data` payload (+ `id`). */
export interface ParsedSseFrame {
  id?: number;
  event: string;
  data: unknown;
}

export type FetchImpl = typeof fetch;

export interface ManagedApiClientOptions {
  backendUrl: string;
  /** Returns the bearer API key (may be async). */
  getApiKey: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: FetchImpl;
  /** Invoked when a response is not on the `/v1` major version (warn-only). */
  onVersionMismatch?: (message: string) => void;
  pollingIntervalMs?: number;
  streamTimeoutMs?: number;
}

/** Error from the backend (single wire error envelope, §"Error envelope"). */
export class ApiClientError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      requestId?: string;
      details?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiClientError";
    this.code = options?.code;
    this.status = options?.status;
    this.requestId = options?.requestId;
    this.details = options?.details;
  }
}

/** Parse one raw SSE frame (text between blank-line separators) into a frame. */
export function parseSseFrame(raw: string): ParsedSseFrame | null {
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
    // leave as string
  }
  return { id, event, data };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export class ManagedApiClient {
  private readonly fetchImpl: FetchImpl;
  private readonly pollingIntervalMs: number;
  private readonly streamTimeoutMs: number;

  constructor(private readonly opts: ManagedApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollingIntervalMs = opts.pollingIntervalMs ?? 5000;
    this.streamTimeoutMs = opts.streamTimeoutMs ?? 1_800_000;
  }

  // --- REST -----------------------------------------------------------------

  /** `GET /v1/tenant` — tenant info (used by `/remote:config` ping). */
  getTenant(): Promise<TenantInfo> {
    return this.request<TenantInfo>("GET", "/v1/tenant");
  }

  /** `POST /v1/agents` — create an agent (Idempotency-Key auto-generated). */
  createAgent(body: AgentCreate, idempotencyKey?: string): Promise<Agent> {
    return this.request<Agent>("POST", "/v1/agents", body, { idempotencyKey });
  }

  /** `GET /v1/sessions` — list sessions. */
  listSessions(query?: { limit?: number; cursor?: string; status?: string }): Promise<Cursor<Session>> {
    const path = buildPath("/v1/sessions", query);
    return this.request<Cursor<Session>>("GET", path);
  }

  /** `POST /v1/sessions` — create a session (Idempotency-Key auto-generated). */
  createSession(body: SessionCreate, idempotencyKey?: string): Promise<Session> {
    return this.request<Session>("POST", "/v1/sessions", body, { idempotencyKey });
  }

  /** `GET /v1/sessions/:id` — retrieve a session (status, usage, config). */
  getSession(sessionId: string): Promise<Session> {
    return this.request<Session>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** `POST /v1/sessions/:id/fork` — fork (shares JSONL tree to fork point). */
  forkSession(sessionId: string, idempotencyKey?: string): Promise<Session> {
    return this.request<Session>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/fork`,
      {},
      { idempotencyKey },
    );
  }

  /** `GET /v1/sessions/:id/usage` — cumulative token usage. */
  getSessionUsage(sessionId: string): Promise<SessionUsageResponse> {
    return this.request<SessionUsageResponse>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/usage`,
    );
  }

  /** `GET <path>` returning JSON (used for session-outputs listing etc.). */
  fetchJson<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** `GET <path>` streaming the body to a local file path (outputs download). */
  async downloadFile(path: string, localPath: string): Promise<void> {
    const url = new URL(path, this.opts.backendUrl).toString();
    const headers: Record<string, string> = { Accept: "application/octet-stream" };
    const key = await this.opts.getApiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await this.fetchImpl(url, { method: "GET", headers });
    if (!res.ok || !res.body) {
      throw new ApiClientError(`download failed: ${res.status} ${res.statusText}`);
    }
    const { writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await import("node:fs/promises").then((m) => m.mkdir(dirname(localPath), { recursive: true }));
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    await writeFile(localPath, Buffer.concat(chunks));
  }

  /** `POST /v1/sessions/:id/events` — send an inbound event. */
  async sendEvent(sessionId: string, event: InboundEvent, idempotencyKey?: string): Promise<void> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    await this.request("POST", path, event, { idempotencyKey });
  }

  // --- Jobs / scheduled crons (§17) -----------------------------------------

  /** `GET /v1/jobs` — list scheduled jobs. */
  listJobs(query?: { limit?: number; cursor?: string; status?: string }): Promise<Cursor<Job>> {
    return this.request<Cursor<Job>>("GET", buildPath("/v1/jobs", query));
  }

  /** `POST /v1/jobs` — create a scheduled job (Idempotency-Key auto-generated). */
  createJob(body: JobCreate, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>("POST", "/v1/jobs", body, { idempotencyKey });
  }

  /** `POST /v1/jobs/:id/pause` — pause (suppresses scheduled triggers; running sessions continue). */
  pauseJob(jobId: string, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>(
      "POST",
      `/v1/jobs/${encodeURIComponent(jobId)}/pause`,
      {},
      { idempotencyKey },
    );
  }

  /** `POST /v1/jobs/:id/unpause` — resume from the next scheduled occurrence (missed triggers are not backfilled). */
  unpauseJob(jobId: string, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>(
      "POST",
      `/v1/jobs/${encodeURIComponent(jobId)}/unpause`,
      {},
      { idempotencyKey },
    );
  }

  /** `POST /v1/jobs/:id/archive` — terminal archive (schedule stops, job becomes immutable). */
  archiveJob(jobId: string, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>(
      "POST",
      `/v1/jobs/${encodeURIComponent(jobId)}/archive`,
      {},
      { idempotencyKey },
    );
  }

  /** `POST /v1/jobs/:id/run` — manual trigger (works while paused). Returns 202 with `{runId, sessionId?}`. */
  runJob(jobId: string, idempotencyKey?: string): Promise<JobRunTriggerResponse> {
    return this.request<JobRunTriggerResponse>(
      "POST",
      `/v1/jobs/${encodeURIComponent(jobId)}/run`,
      {},
      { idempotencyKey },
    );
  }

  /** `GET /v1/jobs/:id/runs` — list deployment runs for a job. */
  listJobRuns(jobId: string, query?: { limit?: number; cursor?: string }): Promise<Cursor<JobRun>> {
    return this.request<Cursor<JobRun>>(
      "GET",
      buildPath(`/v1/jobs/${encodeURIComponent(jobId)}/runs`, query),
    );
  }

  // --- Memory stores (§13) --------------------------------------------------

  /** `GET /v1/memory-stores` — list memory stores. */
  listMemoryStores(query?: { limit?: number; cursor?: string }): Promise<Cursor<MemoryStore>> {
    return this.request<Cursor<MemoryStore>>("GET", buildPath("/v1/memory-stores", query));
  }

  /** `POST /v1/memory-stores` — create a memory store (Idempotency-Key auto-generated). */
  createMemoryStore(body: MemoryStoreCreate, idempotencyKey?: string): Promise<MemoryStore> {
    return this.request<MemoryStore>("POST", "/v1/memory-stores", body, { idempotencyKey });
  }

  /** `GET /v1/memory-stores/:id/memories` — list memory summaries (no content). */
  listMemories(storeId: string, query?: { limit?: number; cursor?: string }): Promise<Cursor<MemorySummary>> {
    return this.request<Cursor<MemorySummary>>(
      "GET",
      buildPath(`/v1/memory-stores/${encodeURIComponent(storeId)}/memories`, query),
    );
  }

  /** `GET /v1/memory-stores/:id/memories/:m` — retrieve a memory with content. */
  getMemory(storeId: string, memoryPath: string): Promise<Memory> {
    return this.request<Memory>(
      "GET",
      `/v1/memory-stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(memoryPath)}`,
    );
  }

  /** `POST /v1/memory-stores/:id/memories` — create a memory (creates an immutable version). */
  createMemory(storeId: string, body: MemoryCreate, idempotencyKey?: string): Promise<Memory> {
    return this.request<Memory>(
      "POST",
      `/v1/memory-stores/${encodeURIComponent(storeId)}/memories`,
      body,
      { idempotencyKey },
    );
  }

  /** `PATCH /v1/memory-stores/:id/memories/:m` — update (optimistic concurrency via contentSha256). */
  updateMemory(storeId: string, memoryPath: string, body: MemoryUpdate): Promise<Memory> {
    return this.request<Memory>(
      "PATCH",
      `/v1/memory-stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(memoryPath)}`,
      body,
    );
  }

  /** `GET /v1/memory-stores/:id/versions` — list memory versions (audit trail). */
  listMemoryVersions(storeId: string, query?: { limit?: number; cursor?: string }): Promise<Cursor<MemoryVersion>> {
    return this.request<Cursor<MemoryVersion>>(
      "GET",
      buildPath(`/v1/memory-stores/${encodeURIComponent(storeId)}/versions`, query),
    );
  }

  // --- Vaults & credentials (§12) -------------------------------------------

  /** `GET /v1/vaults` — list vaults. */
  listVaults(query?: { limit?: number; cursor?: string }): Promise<Cursor<Vault>> {
    return this.request<Cursor<Vault>>("GET", buildPath("/v1/vaults", query));
  }

  /** `POST /v1/vaults` — create a vault (Idempotency-Key auto-generated). */
  createVault(body: VaultCreate, idempotencyKey?: string): Promise<Vault> {
    return this.request<Vault>("POST", "/v1/vaults", body, { idempotencyKey });
  }

  /** `POST /v1/vaults/:id/credentials` — add a credential (sensitive fields are write-only). */
  addCredential(vaultId: string, body: CredentialCreate, idempotencyKey?: string): Promise<Credential> {
    return this.request<Credential>(
      "POST",
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
      body,
      { idempotencyKey },
    );
  }

  /** `GET /v1/vaults/:id/credentials` — list credentials (without sensitive fields). */
  listCredentials(vaultId: string): Promise<Cursor<Credential>> {
    return this.request<Cursor<Credential>>(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
    );
  }

  /** `POST /v1/vaults/:id/credentials/:key/validate` — validate OAuth status (Phase 2). */
  validateCredential(vaultId: string, key: string, idempotencyKey?: string): Promise<CredentialValidateResponse> {
    return this.request<CredentialValidateResponse>(
      "POST",
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials/${encodeURIComponent(key)}/validate`,
      {},
      { idempotencyKey },
    );
  }

  // --- SSE stream -----------------------------------------------------------

  /**
   * `GET /v1/sessions/:id/stream` — live event stream.
   *
   * Reconnects with `Last-Event-ID` after a dropped connection (§9.3) and
   * replays persisted events with sequence position greater than the last-seen
   * id. Falls back to polling the paginated events history when SSE is
   * unusable (non-event-stream content-type or fetch error). Respects an
   * abort signal; the stream timeout bounds the overall connection lifetime.
   */
  async *streamSession(
    sessionId: string,
    options: {
      eventDeltas?: string[];
      lastEventId?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<ParsedSseFrame> {
    const deadline = Date.now() + this.streamTimeoutMs;
    let lastId = options.lastEventId;

    while (true) {
      if (options.signal?.aborted) return;
      if (Date.now() > deadline) return;

      const url = new URL(
        `/v1/sessions/${encodeURIComponent(sessionId)}/stream`,
        this.opts.backendUrl,
      );
      if (options.eventDeltas && options.eventDeltas.length > 0) {
        url.searchParams.set("eventDeltas", options.eventDeltas.join(","));
      }
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      const key = await this.opts.getApiKey();
      if (key) headers.Authorization = `Bearer ${key}`;
      if (lastId !== undefined) headers["Last-Event-ID"] = String(lastId);

      let resp: Response;
      try {
        resp = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers,
          signal: options.signal,
        });
      } catch {
        if (options.signal?.aborted) return;
        // Network failure — fall back to polling.
        yield* this.pollSession(sessionId, lastId, options.signal, deadline);
        return;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!resp.ok || !contentType.includes("text/event-stream")) {
        // SSE unusable — fall back to polling.
        yield* this.pollSession(sessionId, lastId, options.signal, deadline);
        return;
      }

      if (!resp.body) {
        // No body to stream — treat as unusable.
        yield* this.pollSession(sessionId, lastId, options.signal, deadline);
        return;
      }

      try {
        for await (const frame of this.parseSse(resp.body, options.signal)) {
          if (frame.id !== undefined) lastId = frame.id;
          yield frame;
        }
      } catch {
        if (options.signal?.aborted) return;
        // Reader dropped — loop reconnects with `Last-Event-ID: lastId`.
        continue;
      }
      // Clean end: the server closed the stream normally. Stop.
      return;
    }
  }

  private async *parseSse(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncGenerator<ParsedSseFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel();
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
   * Polling fallback: `GET /v1/sessions/:id/events` (paginated) and yield
   * entries with `seq` greater than the last-seen id. Note: history entries
   * carry only `{seq, type, processedAt}` (§"Sessions"), so `data` is the
   * entry summary rather than the full event payload.
   */
  private async *pollSession(
    sessionId: string,
    lastEventId: number | undefined,
    signal: AbortSignal | undefined,
    deadline: number,
  ): AsyncGenerator<ParsedSseFrame> {
    let seenSeq = lastEventId ?? -1;
    let cursor: string | undefined;
    while (true) {
      if (signal?.aborted) return;
      if (Date.now() > deadline) return;
      const base = `/v1/sessions/${encodeURIComponent(sessionId)}/events`;
      const path = cursor ? `${base}?cursor=${encodeURIComponent(cursor)}` : base;
      let page: Cursor<SessionEntry>;
      try {
        page = await this.request<Cursor<SessionEntry>>("GET", path);
      } catch {
        await sleep(this.pollingIntervalMs, signal);
        cursor = undefined;
        continue;
      }
      for (const entry of page.data) {
        if (entry.seq <= seenSeq) continue;
        seenSeq = entry.seq;
        yield {
          id: entry.seq,
          event: entry.type,
          data: { type: entry.type, processedAt: entry.processedAt },
        };
      }
      if (page.nextCursor) {
        cursor = page.nextCursor;
      } else {
        await sleep(this.pollingIntervalMs, signal);
        cursor = undefined;
      }
    }
  }

  // --- internals ------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<T> {
    const url = new URL(path, this.opts.backendUrl).toString();
    const headers: Record<string, string> = { Accept: "application/json" };
    const key = await this.opts.getApiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    else if (body !== undefined && method === "POST") headers["Idempotency-Key"] = randomUUID();

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options?.signal,
      });
    } catch (cause) {
      throw new ApiClientError(`request failed: ${method} ${path}`, { cause });
    }

    this.checkVersion(res, path);

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let parsed: { error?: { code?: string; message?: string; requestId?: string; details?: unknown } } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // non-JSON error body
      }
      const err = parsed.error;
      throw new ApiClientError(err?.message ?? `${res.status} ${res.statusText}`, {
        code: err?.code,
        status: res.status,
        requestId: err?.requestId,
        details: err?.details,
      });
    }
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Version-compat check (warn-only). The `/v1` prefix is the major version;
   * if the effective response URL is not `/v1`-rooted (e.g. a redirect to
   * `/v2`), invoke `onVersionMismatch`. No documented version header exists,
   * so this is URL-based.
   */
  private checkVersion(res: Response, path: string): void {
    if (!this.opts.onVersionMismatch) return;
    const effective = res.url || path;
    if (!/\/v\d+\b/.test(effective) && !effective.includes("/v1")) {
      this.opts.onVersionMismatch(`backend response not on /v1: ${effective}`);
    }
    if (/\/v2\b/.test(effective) || /\/v[3-9]\b/.test(effective)) {
      this.opts.onVersionMismatch(`backend major version mismatch: ${effective}`);
    }
  }
}

function buildPath(base: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
