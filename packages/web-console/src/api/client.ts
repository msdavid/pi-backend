/**
 * Typed fetch wrapper for the console (WP-C1.5; console-spec §1.2, §6.4).
 *
 * All requests are same-origin (`credentials: "same-origin"` — the console
 * session rides an HttpOnly cookie, §4.3). Every mutating method carries the
 * `X-Console-Csrf: 1` header (§4.5); mutating `POST`s auto-generate an
 * `Idempotency-Key` (api-reference §"Idempotency-Key", recommended for all
 * clients). Error responses — the single wire envelope
 * `{error: {type, code, message, details?, requestId}}` — are parsed into a
 * {@link ConsoleApiError} carrying the DP-9 rendering data (status + `code` +
 * `requestId`). The `requestId` comes from the envelope body; the backend
 * sets no request-id response header.
 *
 * The transport is always the real global `fetch` — never injected, never
 * stubbed (CONVENTIONS.md "Fakes at the seam"; contract tests run against the
 * real in-process backend). Tests may pass `baseUrl` + extra `headers`
 * (e.g. a `Cookie`) at construction; those override nothing about transport.
 */

/** Minimal structural view of a zod schema — `@pi-managed/contracts` schemas
 * satisfy it. Structural so this package needs no direct zod dependency. */
export interface ResponseSchema<T> {
  parse(input: unknown): T;
}

/** Methods that must carry the CSRF header (console-spec §4.5). */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Error from the backend (api-reference §"Error envelope"), carrying the data
 * DP-9 rendering needs: HTTP `status`, machine-stable `code`, human `message`,
 * and the server-correlated `requestId`. All fields except `message` are
 * optional because network failures and non-JSON error bodies (e.g. a proxy)
 * produce no envelope.
 */
export class ConsoleApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;
  /** Coarse error class (`request_error`, `authentication_error`, …). */
  readonly type?: string;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      requestId?: string;
      details?: unknown;
      type?: string;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ConsoleApiError";
    this.status = options?.status;
    this.code = options?.code;
    this.requestId = options?.requestId;
    this.details = options?.details;
    this.type = options?.type;
  }
}

export interface ConsoleApiClientOptions {
  /**
   * Origin to prefix paths with. Defaults to `""` (same-origin relative
   * URLs — the production console is served by the backend itself).
   * Contract tests point this at the real in-process app's ephemeral port.
   */
  baseUrl?: string;
  /**
   * Extra headers attached to every request (an init override for
   * server-side tests: `Cookie`, `Authorization`). The browser app never
   * needs this — auth is the HttpOnly cookie.
   */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  body?: unknown;
  /** Per-request extra headers (merged over the client-level ones). */
  headers?: Record<string, string>;
  /** Explicit Idempotency-Key; mutating POSTs auto-generate one if omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class ConsoleApiClient {
  private readonly baseUrl: string;
  private readonly baseHeaders: Record<string, string>;

  constructor(opts: ConsoleApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.baseHeaders = opts.headers ?? {};
  }

  /** `GET` returning the schema-validated body. */
  get<T>(
    path: string,
    schema: ResponseSchema<T>,
    opts?: Omit<RequestOptions, "body">,
  ): Promise<T> {
    return this.json("GET", path, schema, opts);
  }

  /** `POST` with a JSON body, returning the schema-validated response body. */
  post<T>(
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
    opts?: Omit<RequestOptions, "body">,
  ): Promise<T> {
    return this.json("POST", path, schema, { ...opts, body });
  }

  /** `PATCH` with a JSON body, returning the schema-validated response body. */
  patch<T>(
    path: string,
    body: unknown,
    schema: ResponseSchema<T>,
    opts?: Omit<RequestOptions, "body">,
  ): Promise<T> {
    return this.json("PATCH", path, schema, { ...opts, body });
  }

  /** `DELETE` expecting no response body (`204`, or an ignored `200`). */
  async del(path: string, opts?: Omit<RequestOptions, "body">): Promise<void> {
    await this.request("DELETE", path, opts);
  }

  /**
   * Low-level request: shapes headers (CSRF, Idempotency-Key, content type),
   * sends via the real global `fetch`, and throws {@link ConsoleApiError} on
   * any non-2xx response. Returns the raw ok `Response` — callers that need
   * headers (e.g. tests reading `Set-Cookie`) use this directly.
   */
  async request(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.baseHeaders,
      ...opts.headers,
    };
    if (MUTATING_METHODS.has(method)) headers["X-Console-Csrf"] = "1";
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) {
      headers["Idempotency-Key"] = opts.idempotencyKey;
    } else if (method === "POST" && opts.body !== undefined) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal ?? null,
      });
    } catch (cause) {
      throw new ConsoleApiError(`request failed: ${method} ${path}`, { cause });
    }
    if (!res.ok) throw await toApiError(method, path, res);
    return res;
  }

  /** Request + parse JSON + validate with the contracts schema (C§12.3 seam). */
  private async json<T>(
    method: HttpMethod,
    path: string,
    schema: ResponseSchema<T>,
    opts?: RequestOptions,
  ): Promise<T> {
    const res = await this.request(method, path, opts);
    const raw: unknown = await res.json();
    try {
      return schema.parse(raw);
    } catch (cause) {
      // A response the contracts schema rejects is a client/server mismatch —
      // exactly what the contract suite exists to catch. Surface it as the
      // one error type the UI handles.
      throw new ConsoleApiError(
        `response validation failed: ${method} ${path}`,
        { status: res.status, cause },
      );
    }
  }
}

/** Parse the wire error envelope (best-effort — bodies from proxies or the
 * console asset 404 path may be shapeless) into a {@link ConsoleApiError}. */
async function toApiError(
  method: HttpMethod,
  path: string,
  res: Response,
): Promise<ConsoleApiError> {
  let err:
    | {
        type?: string;
        code?: string;
        message?: string;
        details?: unknown;
        requestId?: string;
      }
    | undefined;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "object"
    ) {
      err = (parsed as { error: typeof err }).error;
    }
  } catch {
    // non-JSON error body — fall back to the status line.
  }
  return new ConsoleApiError(
    err?.message ?? `${method} ${path} failed: ${res.status} ${res.statusText}`,
    {
      status: res.status,
      code: err?.code,
      requestId: err?.requestId,
      details: err?.details,
      type: err?.type,
    },
  );
}

/** The app-wide client: same-origin, cookie-authed. Hooks use this. */
export const apiClient = new ConsoleApiClient();

/**
 * The structural client surface fetchers and hooks depend on (WP-C1.6).
 * UI tests inject a fake implementing this via `<ApiClientProvider>`
 * (`./provider.js`) — legitimate because for UI components the client is a
 * COLLABORATOR (CONVENTIONS.md "Fakes at the seam"); the client itself is the
 * subject only in `__tests__/`, where it runs against the real backend.
 */
export type ConsoleApi = Pick<ConsoleApiClient, "get" | "post" | "patch" | "del">;
