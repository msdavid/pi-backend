/**
 * @pi-managed/client — settings schema + resolution (spec §24.4).
 *
 * Settings live under the `piManaged` key of Pi's `settings.json`. The raw API
 * key is NEVER stored here — only `apiKeyRef`, a pointer into Pi's AuthStorage
 * (see `auth.ts`). Precedence: env > settings > defaults.
 *
 * Note: Pi has no programmatic `registerSettings` API; the schema below is the
 * authoritative shape, exported for validation/inspection, and `/remote:config`
 * persists it to `settings.json`.
 */

import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DelegationPolicyEnum = z.enum(["confirm", "autonomous"]);
export type DelegationPolicy = z.infer<typeof DelegationPolicyEnum>;

/**
 * The `piManaged` settings block (spec §24.4 table). `tenant` is read-only —
 * populated by `/remote:config` after a successful `GET /v1/tenant`.
 */
export const PiManagedSettingsSchema = z.object({
  backendUrl: z.string().optional(),
  apiKeyRef: z.string().min(1).default("pi-managed-backend"),
  defaultAgent: z.string().optional(),
  defaultEnvironment: z.string().optional(),
  delegationPolicy: DelegationPolicyEnum.default("confirm"),
  spendCapPerSession: z.number().nonnegative().optional(),
  spendCapPerDay: z.number().nonnegative().optional(),
  confirmThreshold: z.number().nonnegative().optional(),
  pollingIntervalMs: z.number().int().positive().default(5000),
  streamTimeoutMs: z.number().int().positive().default(1_800_000),
  outputsDir: z.string().default("./.pi-managed/outputs/"),
  tenant: z
    .object({
      tenantId: z.string(),
      name: z.string().optional(),
      quotaPlan: z.string().optional(),
    })
    .optional(),
});
export type PiManagedSettings = z.infer<typeof PiManagedSettingsSchema>;

/** Settings with all defaults applied. */
export const DEFAULT_SETTINGS: PiManagedSettings = PiManagedSettingsSchema.parse({});

export const ENV_BACKEND_URL = "PI_MANAGED_BACKEND_URL";
export const ENV_API_KEY = "PI_MANAGED_API_KEY";

export type ConfigEnv = Record<string, string | undefined>;

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Resolve config with precedence: env > settings > defaults.
 * Only `backendUrl` has an env override (`PI_MANAGED_BACKEND_URL`); the API key
 * env override (`PI_MANAGED_API_KEY`) is handled in `auth.ts` and never lands
 * in settings.
 */
export function resolveConfig(
  settings: Partial<PiManagedSettings> | undefined,
  env: ConfigEnv = process.env,
): PiManagedSettings {
  const merged: Record<string, unknown> = {
    ...DEFAULT_SETTINGS,
    ...stripUndefined((settings ?? {}) as Record<string, unknown>),
  };
  if (env[ENV_BACKEND_URL]) merged.backendUrl = env[ENV_BACKEND_URL];
  return PiManagedSettingsSchema.parse(merged);
}

/** Default settings.json path for a given cwd (`.pi/settings.json`). */
export function defaultSettingsPath(cwd: string = process.cwd()): string {
  return `${cwd}/.pi/settings.json`;
}

/**
 * Load the `piManaged` block from a settings.json file. Returns `{}` when the
 * file or block is absent or unreadable (never throws).
 */
export function loadSettingsFile(filePath: string): Partial<PiManagedSettings> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown> | null;
    const block = raw?.piManaged;
    if (block && typeof block === "object") return block as Partial<PiManagedSettings>;
    return {};
  } catch {
    return {};
  }
}

/**
 * Merge a `piManaged` patch into settings.json, preserving all other keys.
 * Creates the file (and parent dirs) if absent.
 */
export function saveSettingsFile(filePath: string, patch: Partial<PiManagedSettings>): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      raw = (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      raw = {};
    }
  }
  const existing = (raw.piManaged as Partial<PiManagedSettings> | undefined) ?? {};
  raw.piManaged = { ...existing, ...stripUndefined(patch as Record<string, unknown>) };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
