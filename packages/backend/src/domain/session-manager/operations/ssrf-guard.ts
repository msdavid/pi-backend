/**
 * SSRF guard for backend-hosted tools (WP-1.4, spec §11.1).
 *
 * `web_fetch` / `web_search` run **in the backend process** (not in the sandbox)
 * because they need network egress the sandbox may not have, and because the agent
 * controls the target URL — a classic SSRF surface. This module denies requests to
 * private/loopback/link-local/cloud-metadata addresses, pins the resolved IP to
 * prevent DNS rebinding, caps redirects with a per-hop re-check, and never attaches
 * internal credentials.
 *
 * Deny list (Appendix A.1 #3 — mirrors microsandbox `publicOnly()`):
 * - IPv4 loopback `127.0.0.0/8`, RFC1918 `10/8`, `172.16/12`, `192.168/16`,
 *   CGNAT `100.64/10`, link-local `169.254/16` (incl. cloud-metadata `169.254.169.254`).
 * - IPv6 `::1`, unique-local `fc00::/7`, link-local `fe80::/10`, IPv4-mapped private.
 * - Non-`http(s)` schemes.
 *
 * The pinning + connect logic lives in the shared {@link safeFetchPinned}
 * (`domain/net/ssrf-pin.ts`), which connects to the validated IP while preserving
 * the original hostname so TLS SNI + certificate validation stay intact (the old
 * Host-header/IP-URL rewrite here broke cert validation on HTTPS targets). This
 * module keeps the `web_fetch`-facing surface: {@link SsrfBlockedError} + the
 * `SafeFetchResult` shape.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { safeFetchPinned, isPrivateAddress } from "../../net/ssrf-pin.js";

export { isPrivateAddress };

/** Injectable DNS resolver (tests mock this for rebinding scenarios). */
export type DnsResolver = (hostname: string) => Promise<LookupAddress[]>;

/** Default resolver: `node:dns/promises` `lookup` with `all: true`. */
const defaultResolver: DnsResolver = async (hostname) =>
  dnsLookup(hostname, { all: true });

/** Max redirects followed before aborting (per-hop re-check). */
export const MAX_REDIRECTS = 5;

/** Error thrown when a URL/host is rejected by the SSRF guard. */
export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** A safe fetch result: the final URL plus the Response. */
export interface SafeFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Resolve a hostname to addresses and assert every address is public.
 * Returns the first allowed address (used to pin the connection).
 */
export async function resolveAndAssertPublic(
  hostname: string,
  resolver: DnsResolver = defaultResolver,
): Promise<LookupAddress> {
  const addrs = await resolver(hostname);
  if (addrs.length === 0) {
    throw new SsrfBlockedError(`no DNS records for ${hostname}`, "no-dns-records");
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new SsrfBlockedError(
        `${hostname} resolves to private address ${a.address}`,
        "private-ip",
      );
    }
  }
  return addrs[0];
}

export interface SafeFetchOptions {
  /**
   * Injectable fetch (tests only). When set, the real pinned socket transport is
   * bypassed for the final wire hop and this impl is called instead — the DNS
   * resolution, public-IP assertion, redirect re-validation, and header
   * stripping in {@link safeFetchPinned} still run unchanged. Mirrors the same
   * seam used by the webhook dispatcher (`domain/webhook/dispatcher.ts`).
   */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch an agent-controlled URL with SSRF protection.
 *
 * Delegates to the shared {@link safeFetchPinned}: denies non-http(s) schemes and
 * ports outside 80/443, resolves + asserts public, and connects to the pinned IP
 * while keeping the original hostname (SNI + cert validation preserved), stripping
 * inherited `Authorization`/`Cookie` headers and re-checking every redirect hop.
 * Errors surface as {@link SsrfBlockedError}.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  resolver: DnsResolver = defaultResolver,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  return safeFetchPinned(rawUrl, init, resolver, {
    maxRedirects: MAX_REDIRECTS,
    errorFactory: (message, reason) => new SsrfBlockedError(message, reason),
    fetchImpl: options.fetchImpl,
  });
}
