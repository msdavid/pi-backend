/**
 * SSRF guard unit tests (WP-1.4, spec §11.1 / Appendix A.1 #3).
 *
 * Covers the four required scenarios: cloud-metadata IP, RFC1918, DNS rebinding,
 * and redirect-to-private. Uses a mocked DNS resolver; tests that need a live
 * fetch response stub the `fetchImpl` seam (R0.6) so DNS resolution, the
 * public-IP assertion, and redirect re-validation in the shared
 * `safeFetchPinned` still run for real (see `stubFetchImpl` below).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPrivateAddress,
  safeFetch,
  SsrfBlockedError,
  type DnsResolver,
} from "../ssrf-guard.js";

describe("ssrf-guard: isPrivateAddress", () => {
  it("blocks the cloud-metadata IP", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe("link-local/metadata");
  });

  it("blocks RFC1918 ranges", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe("rfc1918");
    expect(isPrivateAddress("10.255.255.255")).toBe("rfc1918");
    expect(isPrivateAddress("172.16.0.1")).toBe("rfc1918");
    expect(isPrivateAddress("172.31.255.255")).toBe("rfc1918");
    expect(isPrivateAddress("192.168.1.1")).toBe("rfc1918");
  });

  it("blocks loopback, CGNAT, link-local, multicast", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe("loopback");
    expect(isPrivateAddress("100.64.0.1")).toBe("cgnat");
    expect(isPrivateAddress("169.254.0.1")).toBe("link-local/metadata");
    expect(isPrivateAddress("224.0.0.1")).toBe("multicast/reserved");
  });

  it("blocks IPv6 loopback / ULA / link-local", () => {
    expect(isPrivateAddress("::1")).toBe("loopback");
    expect(isPrivateAddress("fc00::1")).toBe("unique-local");
    expect(isPrivateAddress("fd12:3456::1")).toBe("unique-local");
    expect(isPrivateAddress("fe80::1")).toBe("link-local");
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe("rfc1918");
  });

  it("allows public IPs", () => {
    expect(isPrivateAddress("8.8.8.8")).toBeNull();
    expect(isPrivateAddress("1.1.1.1")).toBeNull();
    expect(isPrivateAddress("2606:4700:4700::1111")).toBeNull();
  });
});

describe("ssrf-guard: safeFetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    // seam-ok: restores the real global fetch; see stubFetch below.
    globalThis.fetch = originalFetch;
  });

  /**
   * Stub global fetch with a sequence of responses. Captures requested URLs.
   *
   * Used ONLY by the deny-before-connect tests: there the assertion is that the guard
   * rejects and `urls` stays EMPTY — i.e. that nothing ever reaches the network. The
   * global is a tripwire for a call that must not happen, not a stand-in for the subject
   * (nothing here asserts on a response the stub itself fabricated). Tests that do need a
   * response use `stubFetchImpl` (the injected final-hop seam), so DNS resolution, the
   * public-IP assertion, per-hop redirect re-validation and header stripping all run for
   * real; the pinned socket transport itself is covered end-to-end against a real server
   * in `domain/net/__tests__/ssrf-pin.test.ts`.
   */
  function stubFetch(
    responses: Array<{ status: number; body?: string; location?: string }>,
  ): { urls: string[] } {
    const urls: string[] = [];
    let i = 0;
    // seam-ok: tripwire only — asserts zero network calls escape a denied URL (see above).
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const headers = new Headers();
      if (r.location) headers.set("location", r.location);
      return new Response(r.body ?? "", { status: r.status, headers });
    }) as typeof globalThis.fetch;
    return { urls };
  }

  /**
   * Stub the `fetchImpl` seam `safeFetch` threads through to `safeFetchPinned`
   * (mirrors the webhook dispatcher's test convention, `domain/webhook/__tests__/
   * dispatcher.test.ts`). Unlike the old `globalThis.fetch` monkeypatch this
   * stubs only the final wire hop — DNS resolution, the public-IP assertion,
   * per-hop redirect re-validation, and header stripping in `safeFetchPinned`
   * still run for real, so these tests still exercise the actual SSRF-guard
   * logic instead of asserting it away.
   */
  function stubFetchImpl(
    responses: Array<{ status: number; body?: string; location?: string }>,
  ): { calls: { url: string; init?: RequestInit }[]; fetchImpl: typeof fetch } {
    const calls: { url: string; init?: RequestInit }[] = [];
    let i = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      const headers = new Headers();
      if (r.location) headers.set("location", r.location);
      return new Response(r.body ?? "", { status: r.status, headers });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("denies the metadata IP directly (no DNS, no fetch)", async () => {
    const { urls } = stubFetch([{ status: 200, body: "leaked" }]);
    await expect(
      safeFetch("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toMatchObject({ reason: "link-local/metadata" });
    expect(urls).toHaveLength(0);
  });

  it("denies RFC1918 IP literals", async () => {
    stubFetch([{ status: 200 }]);
    await expect(safeFetch("http://10.0.0.5/")).rejects.toMatchObject({
      reason: "rfc1918",
    });
    await expect(safeFetch("http://192.168.1.1/")).rejects.toMatchObject({
      reason: "rfc1918",
    });
  });

  it("denies a hostname that resolves to a private IP", async () => {
    const resolver: DnsResolver = async () => [
      { address: "10.0.0.99", family: 4 },
    ];
    stubFetch([{ status: 200 }]);
    await expect(
      safeFetch("http://internal.example.com/", {}, resolver),
    ).rejects.toMatchObject({ reason: "private-ip" });
  });

  it("pins the resolved IP (DNS rebinding protection)", async () => {
    // First resolution (at safeFetch time) returns public. A rebinding attack would
    // return a private IP on a *second* lookup at connect time; because we resolve +
    // pin exactly once, a rebind after the check can never redirect the connection.
    // The pinned connect itself (socket → resolved IP, wire keeps the original
    // hostname for SNI/cert identity) is covered end-to-end against a real server in
    // `domain/net/__tests__/ssrf-pin.test.ts`; here we only stub the final wire hop
    // (`fetchImpl`, same seam the webhook dispatcher uses) and assert on the
    // resolve-once + hostname-preserving behavior `safeFetch` delegates to.
    let resolveCalls = 0;
    const resolver: DnsResolver = async () => {
      resolveCalls++;
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const { calls, fetchImpl } = stubFetchImpl([{ status: 200, body: "ok" }]);
    const res = await safeFetch("http://example.com/", {}, resolver, { fetchImpl });
    expect(res.response.status).toBe(200);
    // Resolved exactly once — no second connect-time lookup (rebind-proof).
    expect(resolveCalls).toBe(1);
    // The request keeps the original hostname — the old Host-header/IP-URL
    // rewrite (which broke TLS cert validation, per R0.6) is gone; IP pinning now
    // happens at the transport layer, not by mutating the URL/Host.
    expect(calls[0].url).toContain("example.com");
    expect(calls[0].url).not.toContain("93.184.216.34");
  });

  it("blocks a redirect to a private IP (per-hop re-check)", async () => {
    const resolver: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    const { calls, fetchImpl } = stubFetchImpl([
      { status: 302, location: "http://169.254.169.254/exfil" },
    ]);
    await expect(
      safeFetch("http://example.com/redir", {}, resolver, { fetchImpl }),
    ).rejects.toMatchObject({ reason: "link-local/metadata" });
    // Only the first hop was fetched; the redirect target was never hit.
    expect(calls).toHaveLength(1);
  });

  it("strips Authorization/Cookie headers (no internal credentials)", async () => {
    const resolver: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    let captured: Headers | undefined;
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await safeFetch(
      "http://example.com/",
      {
        headers: {
          authorization: "Bearer internal-secret",
          cookie: "session=internal",
          "x-custom": "keep",
        },
      },
      resolver,
      { fetchImpl },
    );
    expect(captured?.get("authorization")).toBeNull();
    expect(captured?.get("cookie")).toBeNull();
    expect(captured?.get("x-custom")).toBe("keep");
  });

  it("rejects non-http(s) schemes", async () => {
    stubFetch([{ status: 200 }]);
    await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({
      reason: "blocked-scheme",
    });
    await expect(safeFetch("gopher://x")).rejects.toMatchObject({
      reason: "blocked-scheme",
    });
  });

  it("caps redirects", async () => {
    const resolver: DnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    // Infinite 302 loop to a public host.
    const { fetchImpl } = stubFetchImpl(
      Array.from({ length: 20 }, () => ({
        status: 302,
        location: "http://example.com/loop",
      })),
    );
    await expect(
      safeFetch("http://example.com/start", {}, resolver, { fetchImpl }),
    ).rejects.toMatchObject({ reason: "too-many-redirects" });
  });
});

describe("ssrf-guard: SsrfBlockedError", () => {
  it("carries a machine-readable reason", () => {
    try {
      throw new SsrfBlockedError("nope", "test-reason");
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfBlockedError);
      expect((e as SsrfBlockedError).reason).toBe("test-reason");
    }
  });
});
