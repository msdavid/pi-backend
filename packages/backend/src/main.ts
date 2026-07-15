/**
 * Boot entrypoint for the Pi Managed Backend (WP-1.13).
 *
 * Loads config, builds the composed app via {@link startManagedServer}, and binds
 * the port. Graceful shutdown (stop runtimes, close pool) is wired there.
 *
 * Run with: `node --enable-source-maps dist/main.js` (after `pnpm --filter backend build`).
 */

import { loadConfig } from "./infra/config/index.js";
import { createLogger, initTelemetry } from "./infra/telemetry/index.js";
import { startManagedServer } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  // Register the Tracer/Meter providers BEFORE the app is composed: instrumentation
  // resolves to a no-op unless a provider is registered first, so an unconfigured
  // telemetry init means a collector silently receives nothing.
  const telemetry = await initTelemetry(config);
  await startManagedServer(config, logger, telemetry);
}

main().catch((err) => {
   
  console.error("[main] fatal:", err);
  process.exit(1);
});
