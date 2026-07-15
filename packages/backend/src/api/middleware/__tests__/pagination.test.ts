/**
 * Pagination helper tests (WP-P0.5, §"Cursor pagination").
 *
 * - parseListParams: defaults, clamping (max 200), cursor passthrough.
 * - encodeCursor/decodeCursor round-trip.
 * - paginate wraps rows into { data, nextCursor }.
 */

import { describe, expect, it } from "vitest";
import { type FastifyRequest } from "fastify";
import {
  parseListParams,
  paginate,
  encodeCursor,
  decodeCursor,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../pagination.js";

function reqFor(query: Record<string, unknown>): FastifyRequest {
  return { query } as unknown as FastifyRequest;
}

describe("parseListParams", () => {
  it("uses the default limit and omits cursor when none given", () => {
    const { limit, cursor } = parseListParams(reqFor({}));
    expect(limit).toBe(DEFAULT_LIMIT);
    expect(cursor).toBeUndefined();
  });

  it("clamps limit above the maximum down to MAX_LIMIT", () => {
    const { limit } = parseListParams(reqFor({ limit: 5000 }));
    expect(limit).toBe(MAX_LIMIT);
  });

  it("clamps limit below 1 up to 1", () => {
    const { limit } = parseListParams(reqFor({ limit: 0 }));
    expect(limit).toBe(1);
  });

  it("truncates non-integer limits", () => {
    const { limit } = parseListParams(reqFor({ limit: 12.9 }));
    expect(limit).toBe(12);
  });

  it("falls back to default on non-numeric limit", () => {
    const { limit } = parseListParams(reqFor({ limit: "abc" }));
    expect(limit).toBe(DEFAULT_LIMIT);
  });

  it("passes the cursor through verbatim when present", () => {
    const { cursor } = parseListParams(reqFor({ cursor: "eyJzIjoxfQ" }));
    expect(cursor).toBe("eyJzIjoxfQ");
  });
});

describe("cursor codec", () => {
  it("round-trips a position marker through base64url", () => {
    const marker = { createdAt: "2026-07-13T00:00:00Z", id: "w_01" };
    const encoded = encodeCursor(marker);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    const decoded = decodeCursor<typeof marker>(encoded);
    expect(decoded).toEqual(marker);
  });

  it("throws on a cursor that does not encode an object", () => {
    const bad = Buffer.from("123", "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow();
  });
});

describe("paginate", () => {
  it("wraps rows and nulls nextCursor when none provided", () => {
    expect(paginate([1, 2, 3])).toEqual({ data: [1, 2, 3], nextCursor: null });
  });

  it("includes the nextCursor when provided", () => {
    expect(paginate([1, 2], "abc")).toEqual({ data: [1, 2], nextCursor: "abc" });
  });
});
