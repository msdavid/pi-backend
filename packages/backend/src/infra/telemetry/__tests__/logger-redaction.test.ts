/**
 * Log-redaction regression tests (§25.1 "untrusted code cannot read credentials",
 * §25.5, domain/vault/crypto.ts "plaintext is NEVER logged").
 *
 * The logger MUST NOT be the leak: a request body from
 * `POST /v1/vaults/:id/credentials` carries `token` / `secretValue` in cleartext,
 * and any handler or error path that logs the request (or an object holding a raw
 * `pmb_live_` API key / `whsec_` webhook secret) would otherwise spill it to stdout.
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../../config/index.js";
import { createLogger } from "../logger.js";

const CONFIG: Config = ConfigSchema.parse({ logLevel: "debug" });

const REDACTED = "[Redacted]";

/** Raw secrets that must never reach the log stream. */
const TOKEN = "ghp_supersecrettokenvalue";
const SECRET_VALUE = "s3cr3t-value-plaintext";
const ACCESS_TOKEN = "access-tok-plaintext";
const REFRESH_TOKEN = "refresh-tok-plaintext";
const CLIENT_SECRET = "client-secret-plaintext";
/** A `model_provider_key` secret with no `pmb_live_` marker — only REDACT_PATHS
 *  can catch it (the shape censor would not), so it exercises apiKey by name. */
const RAW_API_KEY = "sk-provider-apikey-plaintext";
const API_KEY = "pmb_live_01J9ZQ0000000000000000000_ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const WEBHOOK_SECRET = "whsec_0123456789abcdef0123456789abcdef";
const KEY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$saltsalt$hashhashhash";

/** Capture the logger's real output stream. */
function captureLogger(): { lines: () => string; logger: ReturnType<typeof createLogger> } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { lines: () => chunks.join(""), logger: createLogger(CONFIG, stream) };
}

describe("createLogger redaction", () => {
  it("redacts credential fields of a logged vault-credential request body", () => {
    const { logger, lines } = captureLogger();

    // Shape of POST /v1/vaults/:id/credentials as a handler / error path would
    // log it. Field names are camelCase, matching the write-only credential
    // fields of the contracts (packages/contracts/src/vault.ts).
    logger.error(
      {
        requestId: "req_1",
        req: {
          method: "POST",
          url: "/v1/vaults/vault_01J9/credentials",
          headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
          body: {
            kind: "oauth",
            token: TOKEN,
            secretValue: SECRET_VALUE,
            accessToken: ACCESS_TOKEN,
            refreshToken: REFRESH_TOKEN,
            clientSecret: CLIENT_SECRET,
            apiKey: RAW_API_KEY,
          },
        },
      },
      "unhandled error",
    );

    const out = lines();
    for (const secret of [
      TOKEN,
      SECRET_VALUE,
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      CLIENT_SECRET,
      RAW_API_KEY,
      API_KEY,
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(REDACTED);
    // Non-secret context survives redaction.
    expect(out).toContain("/v1/vaults/vault_01J9/credentials");
    expect(out).toContain("req_1");
  });

  it("redacts every one of the six write-only credential fields (SEC-9)", () => {
    // Each of the contract's write-only fields (contracts/src/vault.ts §"SECURITY
    // INVARIANT") must be masked by name, regardless of its value shape — these
    // secrets do not carry the raw `pmb_live_`/`whsec_` markers the shape censor
    // catches, so REDACT_PATHS is the only line of defence.
    const FIELDS: Record<string, string> = {
      token: TOKEN,
      secretValue: SECRET_VALUE,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      clientSecret: CLIENT_SECRET,
      apiKey: RAW_API_KEY,
    };
    for (const [field, value] of Object.entries(FIELDS)) {
      const { logger, lines } = captureLogger();
      // Log both as a nested request body and as a bare top-level field.
      logger.info({ req: { body: { [field]: value } }, [field]: value }, "cred");
      const out = lines();
      expect(out, `${field} must be redacted`).not.toContain(value);
      expect(out).toContain(REDACTED);
    }
  });

  it("redacts api-key hashes and set-cookie response headers", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        row: { id: "apikey_01J9", key_hash: KEY_HASH },
        res: { headers: { "set-cookie": "session=abc; HttpOnly" } },
      },
      "api key verified",
    );

    const out = lines();
    expect(out).not.toContain(KEY_HASH);
    expect(out).not.toContain("session=abc");
    expect(out).toContain(REDACTED);
    expect(out).toContain("apikey_01J9");
  });

  it("censors raw pmb_live_ / whsec_ secrets wherever they appear", () => {
    const { logger, lines } = captureLogger();

    logger.warn(
      {
        issued: { key: API_KEY },
        nested: { deep: [{ secret: WEBHOOK_SECRET }] },
        note: `signing with ${WEBHOOK_SECRET}`,
      },
      `issued key ${API_KEY}`,
    );

    const out = lines();
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(WEBHOOK_SECRET);
    expect(out).toContain(REDACTED);
  });

  it("still emits ordinary fields through a child logger", () => {
    const { logger, lines } = captureLogger();

    logger.child({ tenantId: "tenant_1", requestId: "req_2" }).info({ statusCode: 200 }, "request end");

    const out = lines();
    expect(out).toContain("tenant_1");
    expect(out).toContain("request end");
    expect(out).toContain("pi-managed-backend");
  });
});
