/**
 * SSRF-pinning fetch tests (R0.6).
 *
 * Covers the three scenarios named in the remediation plan:
 *  (a) DNS rebind is blocked, and a resolved hostname is *pinned* — the socket
 *      connects to the validated IP while the request still carries the original
 *      hostname (no Host→IP rewrite).
 *  (b) HTTPS through the guard succeeds against a valid cert and fails against a
 *      cert whose identity does not match the hostname — proving SNI + certificate
 *      identity validation are preserved (the pinned IP is not what gets validated).
 *  (c) `isPrivateAddress('[::1]')` (bracketed IPv6 URL literal) is detected as
 *      private.
 *
 * Real Node servers are used (no faked transport at the seam under test). A
 * permissive address classifier + explicit port allowlist let the tests reach a
 * loopback server; the security default (`isPrivateAddress`, ports 80/443) is
 * exercised by the block/rebind assertions.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { type AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  safeFetchPinned,
  isPrivateAddress,
  PinnedSsrfError,
  PinnedTimeoutError,
  type PinnedDnsResolver,
} from "../ssrf-pin.js";

/** Classifier that permits everything (so tests can reach a loopback server). */
const allowAll = (): string | null => null;

// -------------------------------------------------------------------------
// (c) isPrivateAddress: bracketed IPv6 literals
// -------------------------------------------------------------------------

describe("isPrivateAddress: bracketed IPv6 literals", () => {
  it("detects [::1] as loopback (private)", () => {
    expect(isPrivateAddress("[::1]")).toBe("loopback");
  });

  it("detects other bracketed private IPv6 literals", () => {
    expect(isPrivateAddress("[fc00::1]")).toBe("unique-local");
    expect(isPrivateAddress("[fe80::1]")).toBe("link-local");
  });

  it("still classifies unbracketed literals and passes public/hostnames", () => {
    expect(isPrivateAddress("::1")).toBe("loopback");
    expect(isPrivateAddress("127.0.0.1")).toBe("loopback");
    expect(isPrivateAddress("[2606:4700:4700::1111]")).toBeNull();
    expect(isPrivateAddress("8.8.8.8")).toBeNull();
    expect(isPrivateAddress("example.com")).toBeNull();
  });
});

// -------------------------------------------------------------------------
// IPv6 canonicalization: mapped/compat/unspecified/link-local families
// (regression — hex-form IPv4-mapped literals were classified as public)
// -------------------------------------------------------------------------

describe("isPrivateAddress: IPv6 canonicalization", () => {
  it("blocks hex-form IPv4-mapped literals (previously allowed)", () => {
    // ::ffff:a9fe:a9fe == 169.254.169.254 (cloud metadata / IMDS)
    expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe("link-local/metadata");
    // ::ffff:7f00:1 == 127.0.0.1 (loopback)
    expect(isPrivateAddress("::ffff:7f00:1")).toBe("loopback");
    // ::ffff:0a00:0001 == 10.0.0.1 (RFC1918)
    expect(isPrivateAddress("::ffff:0a00:0001")).toBe("rfc1918");
  });

  it("blocks dotted-form and fully-expanded IPv4-mapped literals", () => {
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe("link-local/metadata");
    expect(isPrivateAddress("0:0:0:0:0:ffff:a9fe:a9fe")).toBe("link-local/metadata");
    expect(isPrivateAddress("[::ffff:127.0.0.1]")).toBe("loopback");
  });

  it("blocks IPv4-compatible literals", () => {
    expect(isPrivateAddress("::10.0.0.1")).toBe("rfc1918");
    expect(isPrivateAddress("::0a00:0001")).toBe("rfc1918");
  });

  it("blocks the unspecified address ::", () => {
    expect(isPrivateAddress("::")).toBe("unspecified");
  });

  it("detects ::1 as loopback", () => {
    expect(isPrivateAddress("::1")).toBe("loopback");
  });

  it("covers the whole fe80::/10 link-local range, not just fe80", () => {
    expect(isPrivateAddress("fe80::1")).toBe("link-local");
    expect(isPrivateAddress("febf::1")).toBe("link-local");
    expect(isPrivateAddress("fe90::1")).toBe("link-local");
  });

  it("classifies fc00::/7 unique-local and ff00::/8 multicast", () => {
    expect(isPrivateAddress("fc00::1")).toBe("unique-local");
    expect(isPrivateAddress("fd12:3456::1")).toBe("unique-local");
    expect(isPrivateAddress("ff02::1")).toBe("multicast");
  });

  it("blocks zone-scoped literals rather than allowing them through", () => {
    expect(isPrivateAddress("fe80::1%eth0")).not.toBeNull();
  });

  // SEC-8: NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 that a
  // DNS64/NAT64 node or 6to4 relay routes to; the embedded v4 must be classified
  // or `http://[64:ff9b::a9fe:a9fe]/` reaches 169.254.169.254.
  it("blocks NAT64 64:ff9b::/96 wrapping a private/metadata IPv4", () => {
    expect(isPrivateAddress("64:ff9b::a9fe:a9fe")).toBe("link-local/metadata"); // 169.254.169.254
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe("loopback"); // 127.0.0.1
    expect(isPrivateAddress("64:ff9b::0a00:0001")).toBe("rfc1918"); // 10.0.0.1
    expect(isPrivateAddress("[64:ff9b::a9fe:a9fe]")).toBe("link-local/metadata");
  });

  it("blocks 6to4 2002::/16 wrapping a private/metadata IPv4", () => {
    expect(isPrivateAddress("2002:a9fe:a9fe::")).toBe("link-local/metadata"); // 169.254.169.254
    expect(isPrivateAddress("2002:7f00:1::")).toBe("loopback"); // 127.0.0.1
    expect(isPrivateAddress("2002:0a00:0001::")).toBe("rfc1918"); // 10.0.0.1
  });

  it("still allows NAT64/6to4 wrapping a genuinely public IPv4 (no over-block)", () => {
    expect(isPrivateAddress("64:ff9b::0808:0808")).toBeNull(); // 8.8.8.8
    expect(isPrivateAddress("2002:0808:0808::")).toBeNull(); // 8.8.8.8
  });

  it("still allows genuine global-unicast IPv6 (must not over-block)", () => {
    expect(isPrivateAddress("2600:1901::1")).toBeNull();
    expect(isPrivateAddress("2001:db8::1")).toBeNull();
    expect(isPrivateAddress("[2606:4700:4700::1111]")).toBeNull();
    // A mapped *public* v4 stays public.
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBeNull();
    expect(isPrivateAddress("::ffff:0808:0808")).toBeNull();
  });
});

// -------------------------------------------------------------------------
// (a) DNS rebind blocked + pinning (hostname preserved on the wire)
// -------------------------------------------------------------------------

describe("safeFetchPinned: rebind blocked + IP pinning", () => {
  it("blocks a hostname that resolves to a private address", async () => {
    const resolver: PinnedDnsResolver = async () => [
      { address: "10.0.0.99", family: 4 },
    ];
    await expect(
      safeFetchPinned("http://internal.example.com/", {}, resolver),
    ).rejects.toBeInstanceOf(PinnedSsrfError);
  });

  it("blocks a hostname that resolves to a NAT64-wrapped metadata address (SEC-8)", async () => {
    // DNS64/NAT64 node: the hostname resolves to a synthesized 64:ff9b:: address
    // whose embedded IPv4 is 169.254.169.254 (cloud metadata).
    const resolver: PinnedDnsResolver = async () => [
      { address: "64:ff9b::a9fe:a9fe", family: 6 },
    ];
    await expect(
      safeFetchPinned("http://nat64.example.com/", {}, resolver),
    ).rejects.toBeInstanceOf(PinnedSsrfError);
  });

  it("pins to the resolved IP and keeps the original hostname as Host (no Host→IP rewrite)", async () => {
    const received: { host: string | undefined; url: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      received.push({ host: req.headers.host, url: req.url });
      res.writeHead(200);
      res.end("pong");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;

    let resolveCalls = 0;
    // The hostname resolves to loopback; a "rebind" would re-resolve to something
    // else — but the pin resolves exactly once and connects to that address.
    const resolver: PinnedDnsResolver = async () => {
      resolveCalls++;
      return [{ address: "127.0.0.1", family: 4 }];
    };

    try {
      const { response } = await safeFetchPinned(
        `http://pinned.test:${port}/ping`,
        { method: "GET" },
        resolver,
        { assertAddressAllowed: allowAll, allowedPorts: [port] },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pong");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // Resolved once (no second connect-time lookup → rebind-proof).
    expect(resolveCalls).toBe(1);
    // The server saw the *hostname* (not the pinned IP) — the Host-header/IP-URL
    // rewrite that broke TLS validation is gone.
    expect(received).toHaveLength(1);
    expect(received[0].host).toContain("pinned.test");
    expect(received[0].host).not.toContain("127.0.0.1");
    expect(received[0].url).toBe("/ping");
  });
});

// -------------------------------------------------------------------------
// preserveRequestAuth: bearer kept on hop 0, stripped on redirects
// -------------------------------------------------------------------------

describe("safeFetchPinned: preserveRequestAuth", () => {
  const loopback: PinnedDnsResolver = async () => [
    { address: "127.0.0.1", family: 4 },
  ];

  it("strips Authorization by default (webhook/web_fetch behavior unchanged)", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      await safeFetchPinned(
        `http://auth.test:${port}/`,
        { method: "GET", headers: { authorization: "Bearer secret" } },
        loopback,
        { assertAddressAllowed: allowAll, allowedPorts: [port] },
      );
      expect(seen).toEqual([undefined]); // stripped
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("keeps Authorization on the initial request when opted in", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      await safeFetchPinned(
        `http://auth.test:${port}/`,
        { method: "GET", headers: { authorization: "Bearer secret" } },
        loopback,
        { assertAddressAllowed: allowAll, allowedPorts: [port], preserveRequestAuth: true },
      );
      expect(seen).toEqual(["Bearer secret"]); // preserved on hop 0
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("strips Authorization on a redirect hop even when preserveRequestAuth is set", async () => {
    const seen: { path: string | undefined; auth: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url, auth: req.headers.authorization });
      if (req.url === "/start") {
        // Redirect to another path on the same (re-validated) host.
        res.writeHead(302, { location: `http://auth.test:${req.socket.localPort}/next` });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const { response } = await safeFetchPinned(
        `http://auth.test:${port}/start`,
        { method: "GET", headers: { authorization: "Bearer secret" } },
        loopback,
        { assertAddressAllowed: allowAll, allowedPorts: [port], preserveRequestAuth: true },
      );
      expect(response.status).toBe(200);
      expect(seen).toHaveLength(2);
      // hop 0 keeps the bearer; the redirect hop (>= 1) always strips it.
      expect(seen[0]).toEqual({ path: "/start", auth: "Bearer secret" });
      expect(seen[1]).toEqual({ path: "/next", auth: undefined });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// -------------------------------------------------------------------------
// ROB-1: per-request timeout + AbortSignal (hung sockets are bounded)
// -------------------------------------------------------------------------

describe("safeFetchPinned: timeout + abort", () => {
  /** A loopback server that accepts the socket but never sends a response. */
  async function startHangingServer(): Promise<http.Server> {
    const server = http.createServer(() => {
      /* accept the connection, then hang — never write a response */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return server;
  }

  const loopback: PinnedDnsResolver = async () => [
    { address: "127.0.0.1", family: 4 },
  ];

  it("rejects with PinnedTimeoutError when the endpoint accepts but never responds", async () => {
    const server = await startHangingServer();
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        safeFetchPinned(
          `http://hang.test:${port}/`,
          { method: "GET" },
          loopback,
          { assertAddressAllowed: allowAll, allowedPorts: [port], timeoutMs: 100 },
        ),
      ).rejects.toBeInstanceOf(PinnedTimeoutError);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("rejects when the caller's AbortSignal fires mid-flight", async () => {
    const server = await startHangingServer();
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    try {
      await expect(
        safeFetchPinned(
          `http://abort.test:${port}/`,
          { method: "GET", signal: controller.signal },
          loopback,
          // Disable the timeout so the abort is unambiguously what rejects.
          { assertAddressAllowed: allowAll, allowedPorts: [port], timeoutMs: 0 },
        ),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does not time out a prompt responder (default vs. short timeout sanity)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const { response } = await safeFetchPinned(
        `http://fast.test:${port}/`,
        { method: "GET" },
        loopback,
        { assertAddressAllowed: allowAll, allowedPorts: [port], timeoutMs: 5_000 },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// -------------------------------------------------------------------------
// (b) HTTPS cert validation preserved (SNI intact)
// -------------------------------------------------------------------------

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Generate a self-signed cert whose CN + SAN is `hostname`. */
function makeCert(dir: string, hostname: string): { cert: Buffer; key: Buffer } {
  const certPath = join(dir, `${hostname}.cert.pem`);
  const keyPath = join(dir, `${hostname}.key.pem`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", `/CN=${hostname}`,
      "-addext", `subjectAltName=DNS:${hostname}`,
    ],
    { stdio: "pipe" },
  );
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

describe.runIf(opensslAvailable())("safeFetchPinned: HTTPS cert validation (SNI preserved)", () => {
  let dir: string;
  let valid: { cert: Buffer; key: Buffer };
  let mismatched: { cert: Buffer; key: Buffer };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ssrf-pin-"));
    valid = makeCert(dir, "valid.test");
    mismatched = makeCert(dir, "other.test");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A loopback HTTPS server presenting `cert`/`key`. */
  async function startTls(cert: Buffer, key: Buffer): Promise<https.Server> {
    const server = https.createServer({ cert, key }, (_req, res) => {
      res.writeHead(200);
      res.end("secure-ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return server;
  }

  it("succeeds when the cert matches the requested hostname (SNI = hostname)", async () => {
    const server = await startTls(valid.cert, valid.key);
    const port = (server.address() as AddressInfo).port;
    // valid.test resolves to loopback; cert SAN = valid.test → identity matches.
    const resolver: PinnedDnsResolver = async () => [
      { address: "127.0.0.1", family: 4 },
    ];
    try {
      const { response } = await safeFetchPinned(
        `https://valid.test:${port}/`,
        { method: "GET" },
        resolver,
        { assertAddressAllowed: allowAll, allowedPorts: [port], ca: valid.cert },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("secure-ok");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("fails when the cert identity does not match the hostname (validated against hostname, not the pinned IP)", async () => {
    // Server presents a cert for other.test; the CA is trusted (signature OK), but
    // we request valid.test → identity check fails. If pinning validated against
    // the IP instead of the hostname, this would not fail the way it does.
    const server = await startTls(mismatched.cert, mismatched.key);
    const port = (server.address() as AddressInfo).port;
    const resolver: PinnedDnsResolver = async (): Promise<LookupAddress[]> => [
      { address: "127.0.0.1", family: 4 },
    ];
    try {
      await expect(
        safeFetchPinned(
          `https://valid.test:${port}/`,
          { method: "GET" },
          resolver,
          { assertAddressAllowed: allowAll, allowedPorts: [port], ca: mismatched.cert },
        ),
      ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
