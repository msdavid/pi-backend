import { describe, expect, it } from "vitest";
import { centsFromMicros, microsFromCents, MICROS_PER_CENT, MoneyConversionError } from "./money.js";

describe("money conversion (ledger µUSD ↔ engine cents)", () => {
  it("1 cent is 10_000 micros both ways", () => {
    expect(MICROS_PER_CENT).toBe(10_000);
    expect(microsFromCents(1)).toBe(10_000);
    expect(centsFromMicros(10_000)).toBe(1);
  });

  it("round-trips a $50 top-up exactly (no float drift)", () => {
    const micros = 50_000_000;
    expect(centsFromMicros(micros)).toBe(5000);
    expect(microsFromCents(centsFromMicros(micros))).toBe(micros);
  });

  it("rejects a fractional-cent micros amount (programming error, not runtime input)", () => {
    expect(() => centsFromMicros(15_000)).toThrow(MoneyConversionError); // 1.5 cents
  });

  it("rejects a non-positive charge amount", () => {
    expect(() => centsFromMicros(0)).toThrow(MoneyConversionError);
    expect(() => centsFromMicros(-10_000)).toThrow(MoneyConversionError);
  });
});
