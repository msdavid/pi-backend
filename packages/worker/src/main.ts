#!/usr/bin/env node
/**
 * CLI entry — `node dist/main.js` (WP-4.2).
 *
 * Flags override env (`PI_MANAGED_*`). Builds an executor per `--control-level`
 * and starts the poller (`--mode poll`) or webhook-triggered loop
 * (`--mode webhook`). Handles SIGINT/SIGTERM for clean shutdown.
 */

import { parseArgs } from "node:util";
import { loadConfig, type WorkerConfig, type WorkerMode, type ControlLevel } from "./config.js";
import { BuiltinExecutor, SpawnExecutor, type Executor } from "./control-levels.js";
import { Poller } from "./poller.js";
import { WebhookMode } from "./webhook-mode.js";

interface CliFlags {
  backendUrl?: string;
  envId?: string;
  mode?: WorkerMode;
  controlLevel?: ControlLevel;
  spawnScript?: string;
  workerKeyId?: string;
  workerKey?: string;
}

/** Parse CLI flags into a partial config (env fills the rest). */
function parseCli(): CliFlags {
  const { values } = parseArgs({
    options: {
      "backend-url": { type: "string" },
      "env-id": { type: "string" },
      mode: { type: "string" },
      "control-level": { type: "string" },
      "spawn-script": { type: "string" },
      "worker-key-id": { type: "string" },
      "worker-key": { type: "string" },
    },
  });
  return {
    backendUrl: values["backend-url"],
    envId: values["env-id"],
    mode: values.mode as WorkerMode | undefined,
    controlLevel: values["control-level"] as ControlLevel | undefined,
    spawnScript: values["spawn-script"],
    workerKeyId: values["worker-key-id"],
    workerKey: values["worker-key"],
  };
}

/** Build the executor for the configured control level. */
function buildExecutor(cfg: WorkerConfig): Executor {
  if (cfg.controlLevel === "spawn") {
    return new SpawnExecutor(cfg.spawnScript!);
  }
  return new BuiltinExecutor();
}

async function main(): Promise<void> {
  const cfg = loadConfig(parseCli());
  const executor = buildExecutor(cfg);
  const controller = new AbortController();

  const shutdown = (sig: string): void => {
    process.stderr.write(`\nreceived ${sig}; shutting down\n`);
    controller.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const opts = { signal: controller.signal };

  if (cfg.mode === "webhook") {
    const worker = new WebhookMode(cfg, executor, opts);
    // The subscriber's webhook-receiver script pings worker.wake(). When run
    // standalone (no in-process bridge), the safety poll keeps it alive.
    await worker.start();
  } else {
    const poller = new Poller(cfg, executor, opts);
    await poller.start();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
