/**
 * Host-agent server trust-model tests (WP-R0.4, §6.1).
 *
 * Boots the *real* {@link createHostAgentServer} on a random port with a known bearer token
 * and a test CA, backed by an in-memory fake {@link SandboxProvider} (no VM needed), and
 * asserts the two-layer trust model:
 *
 *  (a) a request with no / a wrong bearer token → `401` (even with a valid client cert);
 *  (b) a request with the correct bearer token + a valid client cert → `200 /healthz`;
 *  (c) a request with *no client cert* → the TLS handshake is rejected (mTLS), so no HTTP
 *      response is ever produced.
 *
 * A final case drives the production {@link HttpHostAgent} client with an mTLS agent to prove
 * the client half of §6.1 round-trips against this server.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from "vitest";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { createHostAgentServer } from "../server.js";
import { HttpHostAgent } from "../../sandbox/multi-host-provider.js";
import type {
  ExecChunk,
  ExecOptions,
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxStatus,
  SandboxProvider,
  SecretBinding,
} from "../../../domain/ports.js";

// ---------------------------------------------------------------------------
// Test PEM fixtures — a throwaway CA signing a server cert (SAN 127.0.0.1 /
// localhost) and a client cert. Generated offline with openssl; no secrets.
// ---------------------------------------------------------------------------

const CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUKzGQ9Z1969ioLSjRSE379nwa/IAwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPVGVzdCBCYWNrZW5kIENBMB4XDTI2MDcxNDA5MDAyNloX
DTM2MDcxMTA5MDAyNlowGjEYMBYGA1UEAwwPVGVzdCBCYWNrZW5kIENBMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsWS9+v9yughERiVvQHYXrwsxELvd
OFwnRKdCyPXhlF8/MIwrZa2o0X9x8BnYp0zbFbuViQrJx5lc0F38/NKvpNLFMnWl
oWOy+AcClN6HE2mRj3gb14iQKFeYe5a2Imi2TMZhbg6KHmlvAtSERdw/e/PJU0JI
zuZ7CS8a8brUjrzbrMxxIgQxa2o0CPQ9o0dD0JWgpKbJK8Rb113DBjVEhUOa5PHp
fz0DLuuPX84O3DTRmXW0T67DInhz0mIOYP7NmixuSeIDZ6aCnTIvjPjNjutHugzI
gq9Qk0/FMxuHEtWKb3ItKkrv79WvyouUsaFrky6BTWr6WgdBVBwnt7rirwIDAQAB
o1MwUTAdBgNVHQ4EFgQUZXLrKGwHQ9MeDMT/Kzaql/K9WekwHwYDVR0jBBgwFoAU
ZXLrKGwHQ9MeDMT/Kzaql/K9WekwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEACmV16LVqufNNMD+dJmW9HskR523/WqTcQ7TBmjTchFssvrboWryS
vPPTzrG816wozhSFPkUMhp0M+DnTcqZDYrbCxLLFajyb8us6e+GR0KxZpBKgk9se
AWDpwajbloSZES/51SRJQ5sqw2d4DDsZLSXQ/aThrkRrn0IkvM146uKI9U7I7XNN
/p/zcyfQarRZ2bICl5dC0jDDD/wyoUWA7M+HIhPruV+S0XMQbXDI4HK9pG10ByVH
f/wqmJFFlSaKzpPSF7fZEz5hmQiJtGOQSNzgYU+1g50Cze0j5GI5b1NUi4o55jSF
TqZtb9lps5hDg1SyIr6VU5w21I52d9Dhhw==
-----END CERTIFICATE-----
`;

const SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIDMDCCAhigAwIBAgIUCVLCumvq64w3Xq1MWVIJUDl3QIswDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPVGVzdCBCYWNrZW5kIENBMB4XDTI2MDcxNDA5MDAyNloX
DTM2MDcxMTA5MDAyNlowFTETMBEGA1UEAwwKaG9zdC1hZ2VudDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBALU0TG0J2EsYKCfzFDJA0s77B16S8PgBBPZv
qstkDsf0oR3O9AJu1LDOh2MOM7wjA+4PUaUKy/fx4dDZsRBo1Zzgl5fCWWjxS2kX
BkBxHbN0JKaPdlSwZI6eXQzXhpG+k+NCYX1K4iZ2DtNVKDud5sqvVvQa/3EhU3iG
93Fd2VD/HUN6JZ5fju4Sp+k6y35Rh5mGBlaVzWCsjimmkpH2NtJpLr4i/mwpWlI1
kv/E0io/yPZXLpPeeqytNM3gWHtiabIq4rty6ePELfEbKw7gCKHc+Hyh1JSj/Tcg
iLIUUlY8txSaJMpx9op2OV2cs+yyW62W9j2vb84RjERcoqTZW0UCAwEAAaNzMHEw
GgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MBMGA1UdJQQMMAoGCCsGAQUFBwMB
MB0GA1UdDgQWBBQ/QoJuFp18cFVHK5L/W2lySFAWNDAfBgNVHSMEGDAWgBRlcuso
bAdD0x4MxP8rNqqX8r1Z6TANBgkqhkiG9w0BAQsFAAOCAQEAfzgA2RXJRjxAAUpj
r0790UvvTPoW7YrC9YVxUybSqcDcVyHXZ7OYH1oQL07HbS/YWw8vRxeVYOP/aXi3
iYwKRTrWC+XiU0tyeARW49HexZUWsOh0CRttcWS+vC88//LWrm1UNCVCgkJ4iYle
UjsDvczI9Xk5j2TvvKJzOUJvBsWk8s6VimkdDMA7RG7tYZzAkjniDVv9fdoG6XnB
xetSX06fi5lsg5DG/sKAKDr7NGB5JJmIS6nxe4axkJ6bXnsJtFljkQmBCgUsEwuM
MwekWsTeKTrEUTwlmYTKIL8yOZRxE41jS3C7UuF9Yhy+ixuokO8mXLxtHPnY5p32
hAj+Vw==
-----END CERTIFICATE-----
`;

const SERVER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEugIBADANBgkqhkiG9w0BAQEFAASCBKQwggSgAgEAAoIBAQC1NExtCdhLGCgn
8xQyQNLO+wdekvD4AQT2b6rLZA7H9KEdzvQCbtSwzodjDjO8IwPuD1GlCsv38eHQ
2bEQaNWc4JeXwllo8UtpFwZAcR2zdCSmj3ZUsGSOnl0M14aRvpPjQmF9SuImdg7T
VSg7nebKr1b0Gv9xIVN4hvdxXdlQ/x1DeiWeX47uEqfpOst+UYeZhgZWlc1grI4p
ppKR9jbSaS6+Iv5sKVpSNZL/xNIqP8j2Vy6T3nqsrTTN4Fh7YmmyKuK7cunjxC3x
GysO4Aih3Ph8odSUo/03IIiyFFJWPLcUmiTKcfaKdjldnLPsslutlvY9r2/OEYxE
XKKk2VtFAgMBAAECgf8BbZyKV9Nx0Hx1m3cZjJCZ1zMUQRmGhLURRf8lV0lsWJnx
GhcdUQ0UCWEAa8cACjhrTWLHMAr8TXum1w3l/EAa+Hy8HW36kacSR9PR4H1o0yFl
c23PweqoItjjX/2KjEsW1d++tONF/54KYrPdUYk6kuLLOUVK63qBCijDvlklCYnS
DG/f8aqgdi63niUCBUCe61KFxE92A1SxxDDnP+XC22K2YDz3OPdcNX5knvLTMna9
KGCG2DDaqaNQAzwgyYykk7c3flGQqW8swrjksGLJ3fPdb44iuEVbwE7Gv0PKawop
V/6w0Impho2aucnW9Vz1097jRdiKKJF6T7JFWmECgYEA/aF/TDvPHz1+I/sCQtcj
IvFXzxCzcVMyJsX9FfWP/8sb4v03pPnQjt1OyBUWFjiaY6ojWujOe1RtAZQjNsqg
EZeoTgbjWEFb+7qWv4bf6acmAK0myq/W7ZN5L/H3f9k73i2uPjhNcDgECPzk8G3O
M1DxjaWDP+s/VDagFDRnydkCgYEAtuWb51QbyKkTG4QsvB5BqkVuhLGnwOZl6XsV
ibFLwKeTd3is533geL9V2vrAjiSI8L4qrb8C+Vd2D2eK0v31s5x/XzuMLoA6G44X
6aKJF1ch56gYgBShKb6eCZ38OKFz5w9r6RdjCrvpeoBqcFtQxv0PSNL1QQSEFiC6
/qHKrU0CgYAeAh+Xm3P0FEh6ZVZtJhsoJTnoa+dvPxKt97rsADPbZeKUxrTwtgXx
AUoy7hvA4U2TASxRsz3K5cBH8YkBEJRDwJfPM41ugb0qWXdAjeqsMHSUm+f9DzT0
wwARpiVMYR1uOiVlgy/WWSpRDergb314INmTksOmqmTBx/zEpzaocQKBgE/1I2pH
Z/oaiGLwLspzA8wXnJBgRnFbiFRBXhIbM33fBOYnGJf/fOHs6/DWzNWXfVKaIHhi
2D7/kHp9jsBdDExgb4LHuqodnsmrHiMizoIosobfAw8Ddc2VKuwTaE+trcjnAgse
EUuBCTpn56CFG1RTD5qLt3KcMc6msnldbAjFAoGAQbHh8WeR4lQe+gmjEv8n3hDB
4kasMmwvNHVv0EbblDNbTfaRF2DXgjDuPcuvzJ+HD9TbEk5OrIdvi5ck7ZdS27XY
69qqQBl5qOvNKnBljSK6mc4DBcx5wciUWVl1Vwf4+u/sDVY2XApxQk/hoqLNx/FA
Lvn+Ons7Mv9fjM5f/G8=
-----END PRIVATE KEY-----
`;

const CLIENT_CERT = `-----BEGIN CERTIFICATE-----
MIIDFDCCAfygAwIBAgIUCVLCumvq64w3Xq1MWVIJUDl3QIwwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPVGVzdCBCYWNrZW5kIENBMB4XDTI2MDcxNDA5MDAyNloX
DTM2MDcxMTA5MDAyNlowFTETMBEGA1UEAwwKcGktYmFja2VuZDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAJimJjofxcbvvWATCJxSj3IBO2xFrwLosstv
D9cPTqYikMZyVT7MXa+Spko+z3iTGp+nlgQ5CCnojTqiUbHSRzNYAH7dd6Vr/gnA
CNOolVIKBzK1OhCwbv+NUlMj/OsqXiR86QN38cExbFl15K0LBUFXSRQeRsphEjdg
5lHyClCdDYDcZ8lgs7zS4Pzfh97P76cGh1owL/Cv1CK6RNp0C8y9ADrdF2DsU5iK
0e3MPTuR9De+TLHh/uDK7ylVaYkpUamKRM1E17hOC8/TxwTkNCabT2nep4UWdAa5
XMeYqqrn3ci/08A3769tsA9QELlRWjiip9kuWkEb1HpqG7COzs8CAwEAAaNXMFUw
EwYDVR0lBAwwCgYIKwYBBQUHAwIwHQYDVR0OBBYEFGhZXggWPBR7a3psPNRGJpFQ
6l4ZMB8GA1UdIwQYMBaAFGVy6yhsB0PTHgzE/ys2qpfyvVnpMA0GCSqGSIb3DQEB
CwUAA4IBAQBV+/OfcFLGjpX9n07VwErqhmKIN7EQqiXTaFRxqL6FSMIvEVw/EB9S
Twmo9PoMF8mABD9AMaFOcELyHfIA4snQKkM6F3WWyByAwC4VGRxU/1KFrssySa2m
jLAXT/2zby9pWmU79eCTem2yo8AoDeD/zZe89DDGcLGEYmniU7fpAhW4GeoUci+w
8AlLsXe4caKIUv2w1ahLFKGyKdyZa0NfA+7JXbY65imkSgQV52wT3aeIFWxjuIhn
PxCekYTdfacRU1fTm1SDW9ont/SGOArgxMKnlB15gt/TzD8Uyx6RIFX0kDVbNiNF
k8ZnLmRHHEYIK8BPISBUb00VEuN3WkrY
-----END CERTIFICATE-----
`;

const CLIENT_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCYpiY6H8XG771g
EwicUo9yATtsRa8C6LLLbw/XD06mIpDGclU+zF2vkqZKPs94kxqfp5YEOQgp6I06
olGx0kczWAB+3Xela/4JwAjTqJVSCgcytToQsG7/jVJTI/zrKl4kfOkDd/HBMWxZ
deStCwVBV0kUHkbKYRI3YOZR8gpQnQ2A3GfJYLO80uD834fez++nBodaMC/wr9Qi
ukTadAvMvQA63Rdg7FOYitHtzD07kfQ3vkyx4f7gyu8pVWmJKVGpikTNRNe4TgvP
08cE5DQmm09p3qeFFnQGuVzHmKqq593Iv9PAN++vbbAPUBC5UVo4oqfZLlpBG9R6
ahuwjs7PAgMBAAECggEAQvZXvJWlf+A5FcUjuNdqv5sUwylKXZ9Ql3cv3qqDWNO+
6J7NEFA8JMHTGqy0/HKjcjfk0hNmpmOyWG9OIRBaVYacKQrj6ngWJ5bLCHZikmt9
vtvLDfknqAkJfRlDYLHkPGNjIDdkoNgabKAP4Wz9MC2nDCE/8pVklVB3mKjxp2yf
uh24gBRGeFErxGkjoZOrTi8uFdI2Y1/AiBELAJAYJefZrcv4mBL1jqsce6cGt4H7
+3tTPbdQadOprOkdMOURmlcfgrGU+vyCSsM9UVvktxHXihG9l1lTuhp1vnlg3EYN
kX1ql3P49VuRTnSbgNhO1W4eJCbALAAkeOWYiIwKaQKBgQDWMtu0DLAFA4NaiuEH
GA1pRP0gc7Oxcf9vep46Rm8VVjXlgJ0EFHUsFotVnb9+pfAV7BFDedYL/vQJDTcT
FmL13FcrU1PEHI12Z7N+LfXxCWBgNsbECd5kMsxS4BRD0smF01RW5KrVIBK4QNfy
laVXDrnw9IEAJWxdfvYxOGdphQKBgQC2cFXKHcMHtjTEFAGeic4H4ntqL6c5yASE
LkehBqFgKUnsmHyowQpQ5BzKGxtoOzVKG+rhnpsHE6I0nfoc1crVTU3wgfR/tvy9
sqmKStmDfsRRpDBaS52MKywO7VuJCERL8QMf2YHKii+a9Rt3EzV59owi8uqqpOK0
9VNmsmu9QwKBgQDIJ44VmSWCCd5cZRoRvvAJRmYiRPvM/HFsgnAIlHiIv55tbtlK
TrOPFyHsRxQCDJ1kXsti+h6B5yOysZ6dP3YJuHPcEGleADBQTGb1qY0AR3q/bXAf
D/m4N5+mca1+EyIs42UULWlU7juP4UfpbtyplSE7f75rnIy+cT0skUBQ4QKBgAFr
cl92R9RBiLuV5EVVkTLigk9bO5PpiI92xLvuD0duStL6hM3TYr8qZ0bzWw0+mLWQ
7gz/bPlrH7IFILMkvsVWKqsad8qeo+zd/Q/EcVjinah8/JtXR0yV8WvUUQgJ9m4Y
3AtdZ/MpjCFKkwIkNiBS2NhUx5q4WcNKvXFpJgl9AoGBALVnWNGaVTBvGL3Gmr+s
HQL0py/VtYMiPLt1ByeubEi4/nslCKaeYWUfUqm5N2amkcUK21221S82OSyoO3z6
QQt63eZVgSt+TI1t4meNO9RrHhigxKidvrePpblt6gjNrbpkjJP98MPiPB1gjEFJ
/huLG1xX/LnG4+cppQCebMxB
-----END PRIVATE KEY-----
`;

/** Known bearer secret the server expects (pool-wide, via createHostAgentTokenSource). */
const TOKEN = "test-host-agent-secret";

// ---------------------------------------------------------------------------
// In-memory fake provider (implements SandboxProvider — no VM required)
// ---------------------------------------------------------------------------

class FakeProvider implements SandboxProvider {
  readonly vms = new Map<string, { handle: SandboxHandle; status: SandboxStatus }>();

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const handle: SandboxHandle = { id: spec.name, name: spec.name, labels: spec.labels };
    this.vms.set(spec.name, { handle, status: "running" });
    return handle;
  }
  async exec(_handle: SandboxHandle, opts: ExecOptions): Promise<ExecResult> {
    return { stdout: `ran:${String(opts.cmd)}`, stderr: "", exitCode: 0 };
  }
  async *execStream(): AsyncIterable<ExecChunk> {
    // Not exercised by the wire contract (execStream is buffered client-side).
  }
  async stop(handle: SandboxHandle): Promise<void> {
    const v = this.vms.get(handle.name);
    if (v) v.status = "stopped";
  }
  async start(handle: SandboxHandle): Promise<void> {
    const v = this.vms.get(handle.name);
    if (v) v.status = "running";
  }
  async snapshot(handle: SandboxHandle): Promise<string> {
    return `${handle.name}-snap`;
  }
  async destroy(handle: SandboxHandle): Promise<void> {
    this.vms.delete(handle.name);
  }
  async reattachByLabels(labels: {
    tenant: string;
    session?: string;
  }): Promise<SandboxHandle[]> {
    const out: SandboxHandle[] = [];
    for (const { handle } of this.vms.values()) {
      if (handle.labels.tenant !== labels.tenant) continue;
      if (labels.session !== undefined && handle.labels.session !== labels.session) continue;
      out.push(handle);
    }
    return out;
  }
  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    return this.vms.get(handle.name)?.status ?? "crashed";
  }
  async registerSecretBinding(_handle: SandboxHandle, _binding: SecretBinding): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Harness: boot the real server on a random port with the test CA
// ---------------------------------------------------------------------------

interface Booted {
  server: https.Server;
  port: number;
  provider: FakeProvider;
}

const booted: https.Server[] = [];

async function bootServer(): Promise<Booted> {
  const provider = new FakeProvider();
  const server = createHostAgentServer({
    provider,
    tls: { cert: SERVER_CERT, key: SERVER_KEY, ca: CA_CERT },
    // Known token via the real config path (pool-wide secret; empty host id).
    env: { SANDBOX_HOST_AGENT_TOKEN: TOKEN },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  booted.push(server);
  const port = (server.address() as AddressInfo).port;
  return { server, port, provider };
}

afterEach(async () => {
  await Promise.all(
    booted.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/**
 * Raw HTTPS request presenting the given client cert (or none) and auth header. Resolves
 * with the status + body on an HTTP response, or rejects on a transport/TLS failure.
 */
function request(opts: {
  port: number;
  path: string;
  method?: string;
  auth?: string;
  withClientCert: boolean;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.auth !== undefined) headers.authorization = opts.auth;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = https.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers,
        ca: CA_CERT,
        servername: "localhost",
        ...(opts.withClientCert ? { cert: CLIENT_CERT, key: CLIENT_KEY } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("host-agent server trust model (§6.1)", () => {
  it("(a) rejects a request with no bearer token → 401 (even with a valid client cert)", async () => {
    const { port } = await bootServer();
    const res = await request({ port, path: "/healthz", withClientCert: true });
    expect(res.status).toBe(401);
    expect(res.body).toBe("");
  });

  it("(a) rejects a request with a wrong bearer token → 401", async () => {
    const { port } = await bootServer();
    const res = await request({
      port,
      path: "/healthz",
      auth: `Bearer ${"x".repeat(TOKEN.length)}`,
      withClientCert: true,
    });
    expect(res.status).toBe(401);
  });

  it("(a) rejects unauthenticated /exec without running the command → 401", async () => {
    const { port } = await bootServer();
    const res = await request({
      port,
      path: "/exec",
      method: "POST",
      withClientCert: true,
      body: JSON.stringify({
        handle: { id: "vm1", name: "vm1", labels: { tenant: "t", session: "s" } },
        opts: { cmd: "cat /etc/shadow" },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain("ran:");
  });

  it("(b) accepts the correct bearer + a valid client cert → 200 /healthz", async () => {
    const { port } = await bootServer();
    const res = await request({
      port,
      path: "/healthz",
      auth: `Bearer ${TOKEN}`,
      withClientCert: true,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("(c) rejects the TLS handshake when the client presents no cert (mTLS)", async () => {
    // The only difference from (b) — which returns 200 — is the missing client cert, so a
    // rejection here isolates mTLS as the cause. Otherwise-identical bearer token + CA pin.
    const { port } = await bootServer();
    await expect(
      request({ port, path: "/healthz", auth: `Bearer ${TOKEN}`, withClientCert: false }),
    ).rejects.toThrow();
  });
});

describe("HttpHostAgent client over mTLS (§6.1)", () => {
  it("round-trips healthz/provision/exec/status through the real server", async () => {
    const { port } = await bootServer();
    const tlsAgent = new https.Agent({
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      ca: CA_CERT,
      servername: "localhost",
    });
    const agent = new HttpHostAgent("host_a", `https://127.0.0.1:${port}`, {
      token: TOKEN,
      tlsAgent,
    });

    expect(await agent.healthz()).toBe(true);
    const handle = await agent.provision({
      name: "vm1",
      image: "ubuntu:22.04",
      cpus: 1,
      memoryMiB: 512,
      networkPolicy: { mode: "unrestricted" },
      labels: { tenant: "tnt_test", session: "sess_a" },
      detached: true,
    });
    expect(handle.name).toBe("vm1");
    const out = await agent.exec(handle, { cmd: "echo hi" });
    expect(out.stdout).toBe("ran:echo hi");
    expect(await agent.status(handle)).toBe("running");
    const found = await agent.listByLabels({ tenant: "tnt_test" });
    expect(found.map((h) => h.name)).toContain("vm1");
    await agent.stop(handle);
    expect(await agent.status(handle)).toBe("stopped");
  });
});
