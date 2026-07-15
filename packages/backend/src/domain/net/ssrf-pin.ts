/**
 * Shared SSRF-pinning fetch helper (R0.6).
 *
 * One correct implementation of "resolve → validate → connect to the *validated*
 * IP" for both egress surfaces that were previously duplicated and subtly wrong:
 *
 * - The webhook dispatcher (`domain/webhook/dispatcher.ts`) resolved-and-checked
 *   by hostname, then fetched by hostname again — a DNS-rebind TOCTOU window.
 * - The backend-hosted `web_fetch` guard (`session-manager/operations/ssrf-guard.ts`)
 *   pinned by rewriting the URL host to the resolved IP and setting a `Host`
 *   header — which **breaks TLS certificate validation** (the cert is validated
 *   against the IP, and SNI carries the IP), turning a security control into a
 *   functional bug on every HTTPS target.
 *
 * {@link safeFetchPinned} closes both: it resolves the hostname once, asserts
 * every returned address is public, then connects to that pinned IP via a custom
 * `lookup` on the Node `http`/`https` request while leaving the **original
 * hostname** as the request host — so SNI and certificate identity validation
 * stay intact. Redirects are re-resolved and re-validated per hop; the
 * destination port is restricted to 80/443.
 *
 * Only Node built-ins are used (`node:dns`, `node:net`, `node:http`,
 * `node:https`, `node:stream`) — no new deps, and no `undici`-specific API (the
 * backend package does not depend on `undici` directly).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

/** Injectable DNS resolver (tests mock this for rebinding scenarios). */
export type PinnedDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

/** Default resolver: `node:dns/promises` `lookup` with `all: true`. */
export const defaultPinnedResolver: PinnedDnsResolver = (hostname) =>
  dnsLookup(hostname, { all: true });

/** Destination ports permitted for agent/tenant-controlled egress. */
export const ALLOWED_PORTS: number[] = [80, 443];

/** Default redirect cap (per-hop re-validation). */
export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Default per-request timeout (ms) for the pinned socket transport. Bounds an
 * endpoint that accepts the connection but stalls — without it a hung peer holds
 * the socket open indefinitely (ROB-1: hung webhook sockets → duplicate deliveries).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default error thrown by {@link safeFetchPinned} (callers override the factory). */
export class PinnedSsrfError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "PinnedSsrfError";
  }
}

/**
 * Thrown by the pinned transport when a request exceeds its timeout. Distinct from
 * {@link PinnedSsrfError} / caller error types on purpose: a timeout is a transient
 * network condition, so callers (webhook dispatcher, billing sink) fall through to
 * their retry branch rather than treating it as an SSRF block.
 */
export class PinnedTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`request exceeded ${timeoutMs}ms timeout`);
    this.name = "PinnedTimeoutError";
  }
}

/** A safe fetch result: the final URL plus the Response. */
export interface PinnedFetchResult {
  response: Response;
  finalUrl: string;
}

export interface SafeFetchPinnedOptions {
  /**
   * Injectable fetch. When set, the pinned transport is bypassed and this impl is
   * called with the (validated) URL — for tests and the webhook dispatcher, which
   * inject a routing/mock fetch. The public-IP assertion still runs first.
   */
  fetchImpl?: typeof fetch;
  /** Max redirects to follow (only when `init.redirect !== "manual"`). */
  maxRedirects?: number;
  /** Allowed destination ports (default {@link ALLOWED_PORTS}). */
  allowedPorts?: number[];
  /** Build the thrown error, so each caller keeps its own error type/reason. */
  errorFactory?: (message: string, reason: string) => Error;
  /**
   * Address classifier: returns a reason string when the IP must be blocked, or
   * `null` when it is allowed. Defaults to {@link isPrivateAddress}. Injectable so
   * tests can reach a loopback server while the security default stays closed.
   */
  assertAddressAllowed?: (ip: string) => string | null;
  /** Extra trusted CA(s) for HTTPS (custom-CA targets / tests). */
  ca?: string | Buffer | Array<string | Buffer>;
  /**
   * Per-request timeout in ms for the pinned transport (default
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}). Applied as a socket-inactivity timeout: on
   * expiry the socket is destroyed and the request rejects with
   * {@link PinnedTimeoutError}. Pass `0` or `Infinity` to disable. Note: this bounds
   * the real socket transport only; when {@link fetchImpl} is injected, cancellation
   * flows through `init.signal` instead.
   */
  timeoutMs?: number;
  /**
   * Preserve a caller-supplied `Authorization` header on the INITIAL request only
   * (default `false`). Opt-in for callers whose credential model is an injected
   * bearer to the intended host (e.g. the MCP client). `Cookie` is always stripped,
   * and `Authorization` is always stripped on redirect hops (>= 1) regardless of
   * this flag, so a malicious 3xx cannot leak the bearer to a redirect target.
   */
  preserveRequestAuth?: boolean;
}

/**
 * Fetch `rawUrl` with SSRF protection and IP pinning.
 *
 * - Denies non-`http(s)` schemes and ports outside {@link ALLOWED_PORTS}.
 * - Resolves the hostname, asserts every address is public, and connects to the
 *   resolved IP while keeping the original hostname for the request host — so TLS
 *   SNI and certificate identity validation are preserved.
 * - Strips inherited `Authorization`/`Cookie` headers (redirect hops always strip
 *   both; `preserveRequestAuth` keeps `Authorization` on the initial request only).
 * - Follows redirects up to `maxRedirects`, re-resolving and re-validating each
 *   hop, unless `init.redirect === "manual"` (then the 3xx is returned as-is).
 */
export async function safeFetchPinned(
  rawUrl: string,
  init: RequestInit = {},
  resolver: PinnedDnsResolver = defaultPinnedResolver,
  options: SafeFetchPinnedOptions = {},
): Promise<PinnedFetchResult> {
  const errorFactory =
    options.errorFactory ?? ((m, r) => new PinnedSsrfError(m, r));
  const allowedPorts = options.allowedPorts ?? ALLOWED_PORTS;
  const classify = options.assertAddressAllowed ?? isPrivateAddress;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const follow = init.redirect !== "manual";

  let url = parseAndValidate(rawUrl, allowedPorts, classify, errorFactory);
  for (let hop = 0; ; hop++) {
    // Resolve once, assert public, and pin to the validated address.
    const addr = await resolveAndAssert(url.hostname, resolver, classify, errorFactory);

    const headers = new Headers(init.headers);
    // `Cookie` is always stripped. `Authorization` is stripped too, EXCEPT on the
    // initial request (hop 0) when the caller opts in via `preserveRequestAuth`:
    // then the intended bearer reaches the intended destination (already resolved,
    // asserted-public, and IP-pinned) — but a redirect (hop >= 1) always strips it,
    // so a malicious 3xx can never exfiltrate the credential to another host.
    headers.delete("cookie");
    if (hop > 0 || !options.preserveRequestAuth) {
      headers.delete("authorization");
    }

    let response: Response;
    if (options.fetchImpl) {
      response = await options.fetchImpl(url.toString(), {
        ...init,
        headers,
        redirect: "manual",
      });
    } else {
      response = await pinnedTransport(
        url,
        addr,
        init.method ?? "GET",
        Object.fromEntries(headers.entries()),
        normalizeBody(init.body, errorFactory),
        options.ca,
        timeoutMs,
        init.signal,
      );
    }

    if (follow && response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!loc) {
        throw errorFactory(
          `redirect ${response.status} with no Location`,
          "redirect-no-location",
        );
      }
      if (hop >= maxRedirects) {
        throw errorFactory(`exceeded ${maxRedirects} redirects`, "too-many-redirects");
      }
      url = parseAndValidate(
        new URL(loc, url).toString(),
        allowedPorts,
        classify,
        errorFactory,
      );
      continue;
    }
    return { response, finalUrl: url.toString() };
  }
}

/** Parse + validate scheme, port, and any IP-literal host. */
function parseAndValidate(
  raw: string,
  allowedPorts: number[],
  classify: (ip: string) => string | null,
  errorFactory: (message: string, reason: string) => Error,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errorFactory(`invalid URL: ${raw}`, "invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw errorFactory(`scheme ${url.protocol} not allowed`, "blocked-scheme");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw errorFactory(`port ${port} not allowed`, "blocked-port");
  }
  // Reject IP-literal private targets directly (no DNS needed).
  const reason = classify(url.hostname);
  if (reason) {
    throw errorFactory(`${url.hostname} is ${reason}`, reason);
  }
  return url;
}

/** Resolve `hostname`, assert every address is allowed, return the first. */
async function resolveAndAssert(
  hostname: string,
  resolver: PinnedDnsResolver,
  classify: (ip: string) => string | null,
  errorFactory: (message: string, reason: string) => Error,
): Promise<LookupAddress> {
  const addrs = await resolver(hostname);
  if (addrs.length === 0) {
    throw errorFactory(`no DNS records for ${hostname}`, "no-dns-records");
  }
  for (const a of addrs) {
    const reason = classify(a.address);
    if (reason) {
      throw errorFactory(
        `${hostname} resolves to ${reason} address ${a.address}`,
        "private-ip",
      );
    }
  }
  return addrs[0];
}

/**
 * Connect to the pinned `addr` while keeping `url.hostname` as the request host so
 * TLS SNI + certificate identity validation are preserved. A custom `lookup`
 * forces the resolved IP; DNS is never consulted again (rebind-proof).
 */
function pinnedTransport(
  url: URL,
  addr: LookupAddress,
  method: string,
  headers: Record<string, string>,
  body: string | Uint8Array | undefined,
  ca: SafeFetchPinnedOptions["ca"],
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const family = addr.family === 6 ? 6 : 4;
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    if ((opts as { all?: boolean }).all) {
      cb(null, [{ address: addr.address, family }]);
    } else {
      cb(null, addr.address, family);
    }
  };
  const reqOptions: https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname, // preserves SNI + certificate identity check
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    lookup,
    ...(isHttps && ca ? { ca } : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const req = mod.request(reqOptions, (res) => resolve(toResponse(res)));
    req.on("error", reject);

    // Abort support: destroy the in-flight socket when the caller's signal fires.
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => req.destroy(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      });
    }

    // Timeout: bound a peer that accepts the connection but stalls. `setTimeout`
    // arms a socket-inactivity timer; on expiry we destroy the socket so it can't
    // leak, and the request rejects with PinnedTimeoutError (a transient error).
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new PinnedTimeoutError(timeoutMs));
      });
    }

    if (body !== undefined) {
      req.write(typeof body === "string" ? body : Buffer.from(body));
    }
    req.end();
  });
}

/** Resolve an aborted signal's rejection error, preferring its own `reason`. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("request aborted"), { name: "AbortError" });
}

/** Adapt a Node `IncomingMessage` into a web `Response`. */
function toResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  const status = res.statusCode ?? 502;
  const noBody = status < 200 || status === 204 || status === 304;
  if (noBody) res.resume(); // drain so the socket is freed
  const body = noBody
    ? null
    : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
}

/** Narrow a `RequestInit` body to what the pinned transport can write. */
function normalizeBody(
  body: RequestInit["body"],
  errorFactory: (message: string, reason: string) => Error,
): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  throw errorFactory(
    "unsupported request body for pinned transport",
    "unsupported-body",
  );
}

/**
 * Classify an IP string as private/loopback/link-local/cloud-metadata. Surrounding
 * brackets (IPv6 URL literals, e.g. `[::1]`) are stripped before classification.
 * Returns `null` for public addresses or non-IP strings (caller resolves first).
 */
export function isPrivateAddress(ip: string): string | null {
  const stripped =
    ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const family = isIP(stripped);
  if (family === 4) return isPrivateV4(stripped);
  if (family === 6) return isPrivateV6(stripped);
  // Not an IP literal (a hostname) — caller must resolve first.
  return null;
}

function isPrivateV4(ip: string): string | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return "invalid";
  }
  const [a, b] = parts;
  // Cloud metadata (AWS/GCP/Azure IMDS) — 169.254.169.254, subset of link-local.
  if (a === 169 && b === 254) return "link-local/metadata";
  if (a === 127) return "loopback";
  if (a === 10) return "rfc1918";
  if (a === 172 && b >= 16 && b <= 31) return "rfc1918";
  if (a === 192 && b === 168) return "rfc1918";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 0) return "this-network";
  if (a >= 224) return "multicast/reserved";
  return null;
}

/**
 * Expand a (Node-validated, family-6) IPv6 literal into its eight 16-bit groups.
 *
 * Handles `::` compression and an embedded IPv4 dotted-quad in the final segment
 * (`::ffff:a.b.c.d`, `::a.b.c.d`, `2001:db8::1.2.3.4`) by folding the dotted-quad
 * into two hex groups before expansion. Returns `null` for any shape it cannot
 * decode — including zone-scoped literals (`fe80::1%eth0`), which the caller then
 * treats as blocked. Because `isPrivateAddress` only calls this after
 * `isIP(...) === 6`, a `null` here means "valid v6 but an unhandled shape", and the
 * caller blocks it rather than falling through to allowed.
 */
function expandV6(ip: string): number[] | null {
  // Zone-scoped addresses (`%eth0`) are never a public egress target; block them.
  if (ip.includes("%")) return null;
  let head = ip;
  if (head.includes(".")) {
    // Fold a trailing IPv4 dotted-quad into two hex groups.
    const idx = head.lastIndexOf(":");
    if (idx === -1) return null;
    const p = head.slice(idx + 1).split(".").map((n) => Number(n));
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hex = `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
    head = head.slice(0, idx + 1) + hex;
  }
  const word = (s: string): number =>
    /^[0-9a-f]{1,4}$/.test(s) ? parseInt(s, 16) : Number.NaN;
  let groups: number[];
  const dc = head.indexOf("::");
  if (dc !== -1) {
    if (head.indexOf("::", dc + 1) !== -1) return null; // at most one "::"
    const before = head.slice(0, dc);
    const after = head.slice(dc + 2);
    const bp = before ? before.split(":") : [];
    const ap = after ? after.split(":") : [];
    const missing = 8 - bp.length - ap.length;
    if (missing < 1) return null; // "::" stands for one or more zero groups
    groups = [...bp.map(word), ...Array<number>(missing).fill(0), ...ap.map(word)];
  } else {
    const parts = head.split(":");
    if (parts.length !== 8) return null;
    groups = parts.map(word);
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/** Render two 16-bit groups as an IPv4 dotted-quad (for mapped/compat addresses). */
function v4FromWords(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): string | null {
  const groups = expandV6(ip.toLowerCase());
  // Any valid-but-undecodable shape is blocked, never allowed to fall through.
  if (groups === null) return "invalid";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // Unspecified `::` (reaches loopback on Linux) and `::1` loopback.
  if (groups.every((g) => g === 0)) return "unspecified";
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return "loopback";
  // IPv4-mapped `::ffff:a.b.c.d` — classify the embedded v4 (covers hex + dotted).
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    return isPrivateV4(v4FromWords(g6, g7));
  }
  // IPv4-compatible `::a.b.c.d` (deprecated) — first six groups zero, not ::/::1.
  if (groups.slice(0, 6).every((g) => g === 0)) {
    return isPrivateV4(v4FromWords(g6, g7));
  }
  // NAT64 well-known prefix `64:ff9b::/96` — the last 32 bits embed an IPv4; on a
  // DNS64/NAT64 node these route to that v4, so classify it (e.g.
  // `64:ff9b::a9fe:a9fe` → 169.254.169.254 / cloud metadata).
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(v4FromWords(g6, g7));
  }
  // 6to4 `2002::/16` — bits 16..47 embed an IPv4 (`2002:V4V4:V4V4::`) that a 6to4
  // relay routes to; classify it (e.g. `2002:a9fe:a9fe::` → 169.254.169.254).
  if (g0 === 0x2002) {
    return isPrivateV4(v4FromWords(g1, g2));
  }
  // fc00::/7 unique-local (fc00–fdff).
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
  // fe80::/10 link-local (fe80–febf).
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  // ff00::/8 multicast.
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  return null;
}
