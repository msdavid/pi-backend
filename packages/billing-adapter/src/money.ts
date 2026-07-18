/**
 * Money conversion between the ledger's micro-dollars (§11.3, `MICROS_PER_USD =
 * 1_000_000`) and a payment engine's smallest currency unit (cents).
 *
 * The ledger is the single source of truth and speaks integer micro-dollars.
 * Stripe (and most engines) charge in integer cents. 1 cent = 10_000 µUSD, so a
 * whole-cent amount is always a whole number of micros; conversion is exact with
 * no float math. All money entering the ledger stays integer (§11.9 — no
 * client-side money math; the adapter does the ONE conversion at the engine
 * boundary and nowhere else).
 */

/** µUSD per cent: 1_000_000 (µUSD/USD) / 100 (cents/USD). */
export const MICROS_PER_CENT = 10_000;

/** µUSD per dollar (the ledger's single unit, §11.3). */
export const MICROS_PER_USD = 1_000_000;

/** Thrown when an amount cannot be represented exactly in the target unit. */
export class MoneyConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyConversionError";
  }
}

/**
 * Convert integer micro-dollars to integer cents for a payment-engine charge.
 * Requires a positive whole-cent amount (micros divisible by 10_000) — a
 * fractional-cent top-up is a programming error, not a runtime input.
 */
export function centsFromMicros(micros: number): number {
  if (!Number.isInteger(micros) || micros <= 0) {
    throw new MoneyConversionError(`amountMicros must be a positive integer, got ${micros}`);
  }
  if (micros % MICROS_PER_CENT !== 0) {
    throw new MoneyConversionError(`amountMicros must be a whole number of cents, got ${micros}`);
  }
  return micros / MICROS_PER_CENT;
}

/** Convert integer cents (from a payment engine) to integer micro-dollars for the ledger. */
export function microsFromCents(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new MoneyConversionError(`cents must be an integer, got ${cents}`);
  }
  return cents * MICROS_PER_CENT;
}

/**
 * Convert a user-entered USD figure (from the console's checkout / auto-charge PATCH)
 * to integer micro-dollars. This is the ONE USD→micros conversion, done at the
 * adapter's wire boundary so no money math happens in the console or backend proxy
 * (§11.9). Rounds to the nearest micro to absorb float error on a decimal dollar
 * amount (e.g. `12.34 → 12_340_000`).
 */
export function microsFromUsd(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new MoneyConversionError(`usd must be a non-negative finite number, got ${usd}`);
  }
  return Math.round(usd * MICROS_PER_USD);
}

/** Convert integer micro-dollars to a USD number (the server-divided display value, §11.9). */
export function usdFromMicros(micros: number): number {
  return micros / MICROS_PER_USD;
}
