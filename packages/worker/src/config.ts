/**
 * Worker configuration (WP-4.2, §10.4).
 *
 * All knobs have env-var overrides (`PI_MANAGED_*`). Flags passed to the CLI
 * entry (`main.ts`) take precedence over env, which takes precedence over
 * defaults. {@link loadConfig} validates required fields and throws on missing
 * `backendUrl` / `environmentId` / `workerKey`.
 */

/** Worker run mode. `poll` = always-on; `webhook` = wake on webhook + safety poll. */
export type WorkerMode = "poll" | "webhook";

/** Tool-execution control level (§10.4). */
export type ControlLevel = "builtin" | "spawn";

/** Resolved worker configuration. */
export interface WorkerConfig {
  /** Backend base URL, e.g. `https://api.pi-managed.example.com`. */
  backendUrl: string;
  /** `apikey_…` id of the worker key (attribution + `workersPolling`). */
  workerKeyId: string;
  /** Raw worker key (`pmb_live_…`), sourced from env — never hardcoded. */
  workerKey: string;
  /** Environment the worker key is scoped to. */
  environmentId: string;
  /** Claim poll interval (ms). Default 5000. */
  pollingIntervalMs: number;
  /** Run mode. */
  mode: WorkerMode;
  /** Tool-execution control level. */
  controlLevel: ControlLevel;
  /** Path to the spawn script (required when `controlLevel === "spawn"`). */
  spawnScript?: string;
}

const ENV = process.env;

/** Pull a positive-int env var with a default. */
function envInt(name: string, fallback: number): number {
  const raw = ENV[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Load + validate worker config. `overrides` (CLI flags) win over env, which
 * wins over defaults. Throws `Error` if required fields are missing or the
 * control level / spawn-script combination is invalid.
 */
export function loadConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const cfg: WorkerConfig = {
    backendUrl: (overrides?.backendUrl ?? ENV.PI_MANAGED_BACKEND_URL ?? "").replace(/\/+$/, ""),
    workerKeyId: overrides?.workerKeyId ?? ENV.PI_MANAGED_WORKER_KEY_ID ?? "",
    workerKey: overrides?.workerKey ?? ENV.PI_MANAGED_WORKER_KEY ?? "",
    environmentId: overrides?.environmentId ?? ENV.PI_MANAGED_ENVIRONMENT_ID ?? "",
    pollingIntervalMs: overrides?.pollingIntervalMs ?? envInt("PI_MANAGED_POLLING_INTERVAL_MS", 5000),
    mode: (overrides?.mode ?? ENV.PI_MANAGED_WORKER_MODE ?? "poll") as WorkerMode,
    controlLevel: (overrides?.controlLevel ?? ENV.PI_MANAGED_CONTROL_LEVEL ?? "builtin") as ControlLevel,
    spawnScript: overrides?.spawnScript ?? ENV.PI_MANAGED_SPAWN_SCRIPT,
  };
  return validateConfig(cfg);
}

/** Validate a config in place; returns the same object on success. */
export function validateConfig(cfg: WorkerConfig): WorkerConfig {
  if (!cfg.backendUrl) throw new Error("backendUrl is required (PI_MANAGED_BACKEND_URL)");
  if (!cfg.environmentId) throw new Error("environmentId is required (PI_MANAGED_ENVIRONMENT_ID)");
  if (!cfg.workerKey) throw new Error("workerKey is required (PI_MANAGED_WORKER_KEY)");
  if (!cfg.workerKeyId) throw new Error("workerKeyId is required (PI_MANAGED_WORKER_KEY_ID)");
  if (cfg.mode !== "poll" && cfg.mode !== "webhook") {
    throw new Error(`invalid mode: ${cfg.mode} (expected "poll" | "webhook")`);
  }
  if (cfg.controlLevel !== "builtin" && cfg.controlLevel !== "spawn") {
    throw new Error(`invalid controlLevel: ${cfg.controlLevel} (expected "builtin" | "spawn")`);
  }
  if (cfg.controlLevel === "spawn" && !cfg.spawnScript) {
    throw new Error('spawnScript is required when controlLevel === "spawn" (PI_MANAGED_SPAWN_SCRIPT)');
  }
  return cfg;
}
