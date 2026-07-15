/**
 * Prefixed-ULID ID generation (§6.6, contracts `ids.ts`).
 *
 * IDs are `<prefix><ulid>`: a Crockford-Base32 ULID (10 timestamp chars + 16
 * random chars, 26 total) appended to a resource prefix (`tnt_`, `apikey_`, …).
 * Server-generated; never accepted from the client on creation.
 *
 * No external ULID dependency — implemented with Node `crypto` (§4 "no new deps").
 */

import { randomBytes } from "node:crypto";

/** Crockford Base32 alphabet (excludes I, L, O, U to avoid confusion). */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Encode a 48-bit millisecond timestamp as 10 Base32 chars. */
function encodeTime(now: number): string {
  let str = "";
  let t = Math.floor(now);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    str = ENCODING[t % ENCODING_LEN] + str;
    t = Math.floor(t / ENCODING_LEN);
  }
  return str;
}

/**
 * Encode `len` random Base32 chars. `randomBytes[i] % 32` is unbiased because
 * 256 is exactly divisible by 32 (no modulo bias).
 */
function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = "";
  for (let i = 0; i < len; i++) {
    str += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return str;
}

/** Generate a 26-char Crockford-Base32 ULID (time-ordered, lexicographically sortable). */
export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom(RANDOM_LEN);
}

/** Generate a prefixed resource id: `<prefix><ulid>` (e.g. `tnt_01J…`, `apikey_01J…`). */
export function newId(prefix: string): string {
  return `${prefix}${ulid()}`;
}

/** Character class matching a generated ULID (used to parse embedded key tokens). */
export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
