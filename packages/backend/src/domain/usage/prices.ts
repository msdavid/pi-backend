/**
 * Per-model price table (§9.7) — USD-per-token rates used to derive `usd_cost`
 * from raw provider token counts.
 *
 * The authoritative seed lives in `default-prices.json` next to this module.
 * Operators override the whole table by pointing `USAGE_PRICES_FILE` at a JSON
 * file of the same shape; when that path is unset or the default file cannot be
 * read (e.g. when running from a `dist/` build that did not stage the JSON), we
 * fall back to {@link EMBEDDED_DEFAULT_PRICES} — a verbatim mirror kept in sync
 * with the JSON so the service never boots without a price table.
 *
 * Rates are expressed **per token** (not per-million) so `usdCost` is a direct
 * multiply with no scaling constant.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

/** Env var pointing at an alternative price-table JSON file. */
export const USAGE_PRICES_FILE_ENV = "USAGE_PRICES_FILE";

/** Table key used when a recorded model is absent from the table (§9.7). */
export const FALLBACK_MODEL_KEY = "unknown-model";

/** USD-per-token rates for one model. */
export const PriceEntrySchema = z.object({
  inputPerToken: z.number().nonnegative(),
  outputPerToken: z.number().nonnegative(),
  cacheCreationPerToken: z.number().nonnegative(),
  cacheReadPerToken: z.number().nonnegative(),
});
export type PriceEntry = z.infer<typeof PriceEntrySchema>;

/** Model id → price entry. Must include a {@link FALLBACK_MODEL_KEY} entry. */
export const PriceTableSchema = z.record(z.string(), PriceEntrySchema);
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** Path to the default seed file, resolved next to this compiled module. */
export const DEFAULT_PRICES_PATH: string = join(
  dirname(fileURLToPath(import.meta.url)),
  "default-prices.json",
);

/**
 * Dist-safety mirror of `default-prices.json`. Used only when the JSON file
 * cannot be read at runtime (e.g. a `tsc`-only build that did not stage the
 * JSON into `dist/`). Keep in sync with `default-prices.json`.
 */
export const EMBEDDED_DEFAULT_PRICES: PriceTable = {
  "unknown-model": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "anthropic/claude-sonnet-4": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "openai/gpt-4o": {
    inputPerToken: 0.0000025,
    outputPerToken: 0.00001,
    cacheCreationPerToken: 0.0000025,
    cacheReadPerToken: 0.00000125,
  },
  "google/gemini-1.5-pro": {
    inputPerToken: 0.00000125,
    outputPerToken: 0.000005,
    cacheCreationPerToken: 0.00000313,
    cacheReadPerToken: 0.00000031,
  },
};

/**
 * Read + validate a price table from a JSON file. Returns `null` if the path is
 * unset, the file is absent, or empty — so the caller can fall back to the
 * embedded defaults. A present-but-malformed file throws (a config fault, not a
 * silent default).
 */
function readPriceFile(path: string | undefined): PriceTable | null {
  if (!path) return null;
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `price table "${path}" is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = PriceTableSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`price table "${path}" failed validation: ${issues}`);
  }
  return result.data;
}

/** Resolve a path that may be relative to the CWD. */
function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

/**
 * Load the price table.
 *
 * Precedence: `USAGE_PRICES_FILE` env var → `default-prices.json` next to this
 * module → {@link EMBEDDED_DEFAULT_PRICES}. Throws if an explicit env path is
 * malformed; falls back silently only when no file is found.
 */
export function loadPriceTable(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const fromEnv = readPriceFile(
    env[USAGE_PRICES_FILE_ENV]
      ? resolvePath(env[USAGE_PRICES_FILE_ENV]!)
      : undefined,
  );
  if (fromEnv) return ensureFallback(fromEnv);
  const fromDefault = readPriceFile(DEFAULT_PRICES_PATH);
  if (fromDefault) return ensureFallback(fromDefault);
  return EMBEDDED_DEFAULT_PRICES;
}

/** Guarantee a fallback entry exists (used when an operator overrides the table). */
function ensureFallback(table: PriceTable): PriceTable {
  if (table[FALLBACK_MODEL_KEY]) return table;
  return { ...table, [FALLBACK_MODEL_KEY]: EMBEDDED_DEFAULT_PRICES[FALLBACK_MODEL_KEY] };
}

/** Look up the price entry for a model, falling back to the unknown-model rate. */
export function priceFor(table: PriceTable, model: string): PriceEntry {
  return table[model] ?? table[FALLBACK_MODEL_KEY] ?? EMBEDDED_DEFAULT_PRICES[FALLBACK_MODEL_KEY];
}
