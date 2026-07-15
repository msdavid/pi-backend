/**
 * Minimal, dependency-free ZIP (PKZIP) reader for skill-bundle uploads (§8.10).
 *
 * The backend accepts skill uploads as either individual files **or** a `.zip`.
 * No external zip dependency is added (docs "no new deps"). The central directory
 * is parsed (robust to data descriptors, which store real sizes only there) and
 * entries are decompressed via Node's built-in `zlib.inflateRawSync`. Supported
 * methods: `0` (store) and `8` (deflate) — the only methods mainstream writers
 * emit for text/markdown skill bundles.
 *
 * ZIP64 (>4 GiB) is not supported; skill bundles are tiny.
 */

import { inflateRawSync } from "node:zlib";

/** A single extracted zip entry (path is the zip-internal relative path). */
export interface ZipEntry {
  path: string;
  data: Buffer;
}

const LFH_SIG = 0x04034b50; // PK\x03\x04 — local file header
const CDH_SIG = 0x02014b50; // PK\x01\x02 — central directory header

/**
 * Zip-bomb guardrails (ROB-16). Skill bundles are text/markdown and tiny, so a
 * few-hundred-MB ceiling is generous while making decompression bounded: a
 * high-ratio deflate stream (≈1000:1) can turn a <50 MB bundle into gigabytes.
 * Both the *declared* central-directory size (cheap early reject) and the *actual*
 * inflate output (`maxOutputLength`) are capped, so a lying central directory
 * cannot smuggle gigabytes past the check — `inflateRawSync` throws instead of
 * exhausting memory.
 */
const MAX_ENTRY_UNCOMPRESSED = 100 * 1024 * 1024; // 100 MiB per entry
const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024; // 300 MiB per bundle

/** Find the last occurrence of `needle` in `buf`; `-1` if absent. */
function findLast(buf: Buffer, needle: Buffer): number {
  for (let i = buf.length - needle.length; i >= 0; i--) {
    if (buf.subarray(i, i + needle.length).equals(needle)) return i;
  }
  return -1;
}

/**
 * Extract the entries of a well-formed ZIP buffer. Directory entries (paths
 * ending in `/`) are skipped. Throws on malformed input or unsupported
 * compression methods.
 */
export function extractZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findLast(buf, Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) {
    throw new Error("invalid zip: end-of-central-directory record not found");
  }
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let totalUncomp = 0;
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(off) !== CDH_SIG) {
      throw new Error("invalid zip: central directory header signature mismatch");
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lfhOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory entry

    // ROB-16: reject before touching the local header / inflating. Bound both the
    // per-entry declared size and the running bundle total.
    if (uncompSize > MAX_ENTRY_UNCOMPRESSED) {
      throw new Error(
        `zip entry too large: ${name} declares ${uncompSize} bytes ` +
          `(max ${MAX_ENTRY_UNCOMPRESSED})`,
      );
    }
    totalUncomp += uncompSize;
    if (totalUncomp > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error(
        `zip bundle too large: uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED} bytes`,
      );
    }

    if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new Error("invalid zip: local file header signature mismatch");
    }
    const lNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = comp;
    } else if (method === 8) {
      // Bound actual inflation to the declared size (ROB-16): a central directory
      // that under-declares its size makes `inflateRawSync` throw ERR_BUFFER_TOO_LARGE
      // rather than expand to gigabytes. `maxOutputLength` must be ≥ 1.
      data = inflateRawSync(comp, { maxOutputLength: Math.max(uncompSize, 1) });
    } else {
      throw new Error(`unsupported zip compression method: ${method}`);
    }
    if (data.length !== uncompSize) {
      throw new Error("zip entry size mismatch after decompression");
    }
    entries.push({ path: name, data });
  }
  return entries;
}

/**
 * Sniff whether a buffer is a ZIP archive by its leading local-file-header
 * signature. Used by the upload path to decide between "one zip" and "many
 * files" multipart shapes.
 */
export function isZipBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf.readUInt32LE(0) === LFH_SIG
  );
}
