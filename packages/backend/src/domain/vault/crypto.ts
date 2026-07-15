/**
 * Vault secret encryption (WP-1.9, §12.4, §28).
 *
 * Secrets are encrypted at rest with **AES-256-GCM** via Node's `crypto` — no
 * external dependency (§4 "no new deps"). Each secret gets a fresh random
 * 96-bit nonce; the 128-bit GCM auth tag is appended to the ciphertext so
 * `secret_enc` is stored as a single `bytea` (§3.5). The nonce is stored
 * alongside (`nonce` column); `key_id` records which key encrypted it.
 *
 * Key management: the key comes from `VAULT_KEY` (hex or base64, 32 bytes) or
 * `VAULT_KEY_FILE` (path to a 32-byte file); the legacy `MSB_SECRET_ENCRYPTION_KEY`
 * / `MSB_SECRET_ENCRYPTION_KEY_FILE` names are still accepted as deprecated
 * aliases. Resolution + the boot-refusal policy live in `infra/config`
 * ({@link resolveVaultKeySource}) — this module never reads `process.env` for
 * the key directly. When NO key is configured the boot REFUSES to start (an
 * ephemeral key would make every stored secret undecryptable after a restart);
 * `ALLOW_EPHEMERAL_VAULT_KEY=true` is the dev-only escape hatch.
 *
 * SECURITY: plaintext is NEVER logged. Only the ciphertext/nonce/keyId leave
 * this module, and only to the credential service that persists them.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  resolveVaultKeySource,
  VAULT_KEY_ENV,
  DEPRECATED_VAULT_KEY_ENV,
  DEPRECATED_VAULT_KEY_FILE_ENV,
  ALLOW_EPHEMERAL_VAULT_KEY_ENV,
  type EnvLike,
} from "../../infra/config/index.js";
import type { Pool } from "../../infra/db/index.js";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256-bit key
const NONCE_LEN = 12; // 96-bit GCM nonce (NIST SP 800-38D)
const TAG_LEN = 16; // 128-bit GCM auth tag

/**
 * Deprecated env var holding the raw key (hex or base64, 32 bytes once decoded).
 * Prefer `VAULT_KEY` ({@link VAULT_KEY_ENV}); kept as a backward-compatible alias.
 */
export const ENV_KEY = DEPRECATED_VAULT_KEY_ENV;
/**
 * Deprecated env var holding a path to a 32-byte key file. Prefer `VAULT_KEY_FILE`;
 * kept as a backward-compatible alias.
 */
export const ENV_KEY_FILE = DEPRECATED_VAULT_KEY_FILE_ENV;

/** An encrypted secret: the values persisted to `vault_credentials`. */
export interface EncryptedSecret {
  /** Ciphertext with the GCM auth tag appended (one `bytea`). */
  ciphertext: Buffer;
  /** The 96-bit GCM nonce (`bytea`). */
  nonce: Buffer;
  /** Which key encrypted this (e.g. "env", "file:…", "ephemeral"). */
  keyId: string;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LEN) {
    throw new Error(
      `vault crypto: key must be ${KEY_LEN} bytes (got ${key.length})`,
    );
  }
}

/**
 * Encrypt `plaintext` with AES-256-GCM under `key` (32 bytes). Returns the
 * ciphertext (tag appended), a fresh nonce, and `keyId`. Never logs plaintext.
 */
export function encryptSecret(
  plaintext: string,
  keyId: string,
  key: Buffer,
): EncryptedSecret {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([ct, tag]);
  return { ciphertext, nonce, keyId };
}

/**
 * Decrypt an {@link EncryptedSecret} back to plaintext. Verifies the GCM auth
 * tag (throws on tamper). Never logs plaintext.
 */
export function decryptSecret(enc: EncryptedSecret, key: Buffer): string {
  assertKey(key);
  if (enc.ciphertext.length < TAG_LEN) {
    throw new Error("vault crypto: ciphertext too short (missing auth tag)");
  }
  const tag = enc.ciphertext.subarray(enc.ciphertext.length - TAG_LEN);
  const ct = enc.ciphertext.subarray(0, enc.ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, enc.nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/** A bound key + keyId for the vault/credential services to use. */
export interface VaultCrypto {
  readonly keyId: string;
  encrypt: (plaintext: string) => EncryptedSecret;
  decrypt: (enc: EncryptedSecret) => string;
}

/** Bind a `key`/`keyId` pair into a {@link VaultCrypto}. */
export function createVaultCrypto(key: Buffer, keyId: string): VaultCrypto {
  assertKey(key);
  return {
    keyId,
    encrypt: (plaintext) => encryptSecret(plaintext, keyId, key),
    decrypt: (enc) => decryptSecret(enc, key),
  };
}

/** Decode a hex (64 chars) or base64 string into a 32-byte key. */
function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `vault crypto: ${VAULT_KEY_ENV} must decode to ${KEY_LEN} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

/**
 * Resolve the vault encryption key + keyId from the environment via the config
 * module's {@link resolveVaultKeySource} (which owns precedence + the boot-refusal
 * policy). Decodes inline/file key material into a 32-byte buffer here.
 *
 * When no key is configured this THROWS (via `resolveVaultKeySource`), refusing
 * the boot — an ephemeral key would make stored secrets unreadable after a
 * restart. Only with `ALLOW_EPHEMERAL_VAULT_KEY=true` (dev-only) is an ephemeral
 * key generated, with a loud warning.
 */
export function loadVaultCryptoKey(
  env: EnvLike = process.env,
): { key: Buffer; keyId: string } {
  const source = resolveVaultKeySource(env);
  switch (source.kind) {
    case "inline":
      return { key: decodeKey(source.value), keyId: source.keyId };
    case "file": {
      const raw = readFileSync(source.path, "utf8");
      return { key: decodeKey(raw), keyId: source.keyId };
    }
    case "ephemeral": {
      const key = randomBytes(KEY_LEN);

      console.warn(
        `[vault] WARNING: ${ALLOW_EPHEMERAL_VAULT_KEY_ENV} is set — generated an ` +
          `EPHEMERAL encryption key. Encrypted vault secrets will be UNREADABLE after ` +
          `restart. Set ${VAULT_KEY_ENV} (32 bytes, hex or base64) in production.`,
      );
      return { key, keyId: source.keyId };
    }
  }
}

/**
 * Re-encrypt every credential secret from `oldKey` to `newKey` (key rotation,
 * §12.4). Reads each `vault_credentials` row with non-null `secret_enc`, decrypts
 * it under `oldKey`, re-encrypts under `newKey` with a fresh nonce, and rewrites
 * `secret_enc`/`nonce`/`key_id` (recorded as `newKeyId`). Runs in a single
 * transaction with `FOR UPDATE` row locks so a concurrent write can't race a
 * rotation. This is an operator/admin operation and spans all tenants.
 *
 * SECURITY: plaintext exists only transiently in memory and is never logged.
 * Returns the number of rows rotated.
 */
export async function rotateVaultKey(
  pool: Pool,
  oldKey: Buffer,
  newKey: Buffer,
  newKeyId: string,
): Promise<{ rotated: number }> {
  assertKey(oldKey);
  assertKey(newKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      secret_enc: Buffer;
      nonce: Buffer;
      key_id: string;
    }>(
      `SELECT id, secret_enc, nonce, key_id
         FROM vault_credentials
        WHERE secret_enc IS NOT NULL
        FOR UPDATE`,
    );
    let rotated = 0;
    for (const row of rows) {
      const plaintext = decryptSecret(
        { ciphertext: row.secret_enc, nonce: row.nonce, keyId: row.key_id },
        oldKey,
      );
      const enc = encryptSecret(plaintext, newKeyId, newKey);
      await client.query(
        `UPDATE vault_credentials
            SET secret_enc = $2, nonce = $3, key_id = $4, updated_at = now()
          WHERE id = $1`,
        [row.id, enc.ciphertext, enc.nonce, enc.keyId],
      );
      rotated++;
    }
    await client.query("COMMIT");
    return { rotated };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

let defaultCrypto: VaultCrypto | undefined;

/** The process-wide default {@link VaultCrypto} (lazily resolved from env). */
export function getDefaultVaultCrypto(): VaultCrypto {
  if (!defaultCrypto) {
    const { key, keyId } = loadVaultCryptoKey();
    defaultCrypto = createVaultCrypto(key, keyId);
  }
  return defaultCrypto;
}
