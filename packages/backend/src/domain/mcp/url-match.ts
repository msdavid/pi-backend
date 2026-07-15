/**
 * MCP server URL exact-match (WP-3.3, spec §19.5).
 *
 * Credentials in the vault are keyed by the MCP server URL (§12.1). At injection
 * time the proxy matches a server's URL against the resolved {@link SecretBinding}
 * URLs by **exact** comparison — scheme, host, port, pathname, query, and fragment
 * must all match, and the comparison is trailing-slash sensitive
 * (`https://x/api` ≠ `https://x/api/`). This prevents a credential registered for
 * one origin from being injected into a request to a different origin that happens
 * to share a host (§25.3 credential-scope enforcement).
 *
 * Only the URL string is compared — no normalization beyond parsing. Two URLs that
 * a browser would treat as equivalent but that differ textually (e.g. percent-cased
 * hosts) are treated as distinct, which is the safe default for credential scoping.
 */

/** Parsed URL pieces retained for exact comparison. */
interface ParsedUrl {
  scheme: string;
  host: string; // lowercased host + port as authored
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Parse a URL into the pieces that participate in exact-match. Throws if `raw` is
 * not an absolute URL with an explicit scheme — relative URLs are not valid MCP
 * server addresses (§19.3 `type: 'url'`).
 */
function parseUrl(raw: string): ParsedUrl {
  const u = new URL(raw);
  return {
    scheme: u.protocol,
    // `u.host` already includes the port when non-default; lowercase the host label
    // portion only (the hostname is case-insensitive per RFC 3986, but the rest is
    // case-sensitive). URL lowercases the hostname for us.
    host: u.host,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
  };
}

/**
 * Exact-match two MCP server URLs (§19.5). Returns `true` iff scheme, host, port,
 * pathname, query, and fragment are all byte-equal (host is case-insensitive, as
 * the URL parser lowercases it). **Trailing slash is significant.**
 *
 * `undefined` / non-absolute URLs never match anything (returns `false`).
 */
export function mcpUrlsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  let pa: ParsedUrl;
  let pb: ParsedUrl;
  try {
    pa = parseUrl(a);
    pb = parseUrl(b);
  } catch {
    return false;
  }
  return (
    pa.scheme === pb.scheme &&
    pa.host === pb.host &&
    pa.pathname === pb.pathname &&
    pa.search === pb.search &&
    pa.hash === pb.hash
  );
}
