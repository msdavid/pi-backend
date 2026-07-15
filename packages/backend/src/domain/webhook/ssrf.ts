/**
 * SSRF guard for webhook endpoints (WP-2.5, §23.3 / §23.5 / Appendix A.1 #3).
 *
 * A separate instance from the operations ssrf-guard (`domain/session-manager/
 * operations/ssrf-guard.ts`): webhook endpoints are tenant-controlled egress
 * targets and must never resolve to private/loopback/link-local/cloud-metadata
 * addresses. When an endpoint hostname resolves to a private IP, the webhook is
 * **immediately disabled** (§23.5) with `disabledReason: "ssrf-private-ip"`.
 *
 * Deny list mirrors microsandbox `publicOnly()`:
 * - IPv4 loopback `127/8`, RFC1918 `10/8`/`172.16/12`/`192.168/16`, CGNAT
 *   `100.64/10`, link-local `169.254/16` (incl. cloud-metadata `169.254.169.254`).
 * - IPv6 `::1`, unique-local `fc00::/7`, link-local `fe80::/10`, IPv4-mapped.
 *
 * No new deps — `node:dns` + `node:net` only.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isPrivateAddress } from "../net/ssrf-pin.js";

export { isPrivateAddress };

/** Injectable DNS resolver (tests mock for private-IP scenarios). */
export type WebhookDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

/** Default resolver: `node:dns/promises` `lookup` with `all: true`. */
export const defaultWebhookDnsResolver: WebhookDnsResolver = async (hostname) =>
  dnsLookup(hostname, { all: true });

/**
 * Resolve `hostname` and assert every address is public. Returns the resolved
 * addresses; throws {@link WebhookSsrfError} if any address is private.
 */
export async function resolveAndAssertPublic(
  hostname: string,
  resolver: WebhookDnsResolver = defaultWebhookDnsResolver,
): Promise<LookupAddress[]> {
  const addrs = await resolver(hostname);
  if (addrs.length === 0) {
    throw new WebhookSsrfError(
      `no DNS records for ${hostname}`,
      "ssrf-no-dns-records",
    );
  }
  for (const a of addrs) {
    const reason = isPrivateAddress(a.address);
    if (reason) {
      throw new WebhookSsrfError(
        `${hostname} resolves to ${reason} address ${a.address}`,
        "ssrf-private-ip",
      );
    }
  }
  return addrs;
}

/** Error thrown when a webhook endpoint is rejected by the SSRF guard. */
export class WebhookSsrfError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "WebhookSsrfError";
  }
}
