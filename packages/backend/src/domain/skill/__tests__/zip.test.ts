/**
 * ZIP reader guardrails (ROB-16): decompression must be bounded so a high-ratio
 * deflate stream cannot exhaust memory. Unit-level — no Postgres/object store; a
 * hand-built ZIP lets us lie in the central directory the way a bomb would.
 */

import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractZipEntries } from "../zip.js";

/**
 * Build a single-entry ZIP. `declaredUncompSize` is written into both the local and
 * central-directory headers verbatim, so tests can under- or over-declare the real
 * uncompressed size the way a zip bomb does. CRC-32 is left 0 (the reader ignores it).
 */
function buildZip(opts: {
  name: string;
  method: number; // 0 = store, 8 = deflate
  comp: Buffer;
  declaredUncompSize: number;
}): Buffer {
  const nameBuf = Buffer.from(opts.name, "utf8");
  const { comp } = opts;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4); // version needed
  lfh.writeUInt16LE(0, 6); // flags
  lfh.writeUInt16LE(opts.method, 8);
  lfh.writeUInt32LE(0, 14); // crc32 (ignored)
  lfh.writeUInt32LE(comp.length, 18); // comp size
  lfh.writeUInt32LE(opts.declaredUncompSize, 22); // uncomp size
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28); // extra len
  const localPart = Buffer.concat([lfh, nameBuf, comp]);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4); // version made by
  cdh.writeUInt16LE(20, 6); // version needed
  cdh.writeUInt16LE(opts.method, 10);
  cdh.writeUInt32LE(0, 16); // crc32
  cdh.writeUInt32LE(comp.length, 20); // comp size
  cdh.writeUInt32LE(opts.declaredUncompSize, 24); // uncomp size
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42); // lfh offset
  const central = Buffer.concat([cdh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // cd size
  eocd.writeUInt32LE(localPart.length, 16); // cd offset

  return Buffer.concat([localPart, central, eocd]);
}

describe("extractZipEntries — zip-bomb guardrails (ROB-16)", () => {
  it("round-trips a normal deflated entry", () => {
    const body = Buffer.from("hello skill\n", "utf8");
    const zip = buildZip({
      name: "SKILL.md",
      method: 8,
      comp: deflateRawSync(body),
      declaredUncompSize: body.length,
    });
    const entries = extractZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("SKILL.md");
    expect(entries[0].data.toString("utf8")).toBe("hello skill\n");
  });

  it("rejects an entry whose declared size exceeds the per-entry cap (cheap early reject)", () => {
    const zip = buildZip({
      name: "big.bin",
      method: 8,
      comp: deflateRawSync(Buffer.from("x")),
      declaredUncompSize: 500 * 1024 * 1024, // 500 MiB > 100 MiB cap
    });
    expect(() => extractZipEntries(zip)).toThrow(/too large/);
  });

  it("rejects a high-ratio entry that inflates past its (under-)declared size", () => {
    // 1 MiB of zeros → a ~1 KB deflate stream (≈1000:1). The central directory lies
    // and declares only 10 bytes; bounded inflation must throw rather than expand.
    const comp = deflateRawSync(Buffer.alloc(1024 * 1024, 0));
    const zip = buildZip({
      name: "bomb.bin",
      method: 8,
      comp,
      declaredUncompSize: 10,
    });
    expect(() => extractZipEntries(zip)).toThrow();
  });
});
