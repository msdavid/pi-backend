/**
 * @pi-managed/client — Pi client extension entry point (spec §24).
 *
 * Bridges a local Pi to the Pi Managed Backend. WP-1.11a ships the skeleton:
 * the `piManaged` settings schema, API-key storage via Pi's AuthStorage, the
 * typed REST + SSE API client, and the `/remote:config` first-run flow.
 * Commands/panel/tools land in WP-1.11b/c.
 *
 * Pi has no programmatic `registerSettings` API — the settings schema is
 * exported below as the authoritative shape and persisted to `settings.json`
 * by `/remote:config`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConfigCommand } from "./commands/config.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerRemoteCommands } from "./commands/remote.js";
import { registerCronCommands } from "./commands/cron.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerVaultCommands } from "./commands/vault.js";
import { registerDelegationRenderer } from "./panel/entry-renderer.js";

export const CLIENT_EXTENSION_VERSION = "0.0.0";

// Public surface
export {
  PiManagedSettingsSchema,
  DEFAULT_SETTINGS,
  resolveConfig,
  defaultSettingsPath,
  loadSettingsFile,
  saveSettingsFile,
  ENV_BACKEND_URL,
  ENV_API_KEY,
} from "./config.js";
export type { PiManagedSettings, DelegationPolicy, ConfigEnv } from "./config.js";

export {
  PiAuthStorageAdapter,
  InMemoryAuthStore,
  resolveApiKey,
  resolveBackendUrl,
} from "./auth.js";
export type { AuthStore, AuthStorageLike } from "./auth.js";

export { ManagedApiClient, ApiClientError, parseSseFrame } from "./api-client.js";
export type { ManagedApiClientOptions, ParsedSseFrame, FetchImpl } from "./api-client.js";

export { runConfigFlow, registerConfigCommand } from "./commands/config.js";
export type { ConfigFlowUi, ConfigFlowDeps } from "./commands/config.js";

export { runLoginFlow, registerLoginCommand } from "./commands/login.js";
export type { LoginFlowUi, LoginFlowDeps } from "./commands/login.js";

export {
  runStart,
  runResume,
  runSessions,
  runDelegate,
  runAttach,
  runFork,
  runDetach,
  registerRemoteCommands,
} from "./commands/remote.js";
export type { RemoteCommandDeps, RemoteUi } from "./commands/remote.js";

export { DELEGATION_CUSTOM_TYPE } from "./panel/types.js";
export type {
  DelegationMode,
  DelegationStartData,
  DelegationCompletionData,
  OfflineCompletionData,
  DelegationEntryData,
} from "./panel/types.js";
export { DelegationRecorder } from "./panel/delegation.js";
export { shouldForwardPrompt, forwardPrompt } from "./panel/forwarding.js";
export {
  LiveViewPanel,
  startLivePanel,
  detachPanel,
  detachConnection,
} from "./panel/live-view.js";
export {
  ConnectionManager,
  classifyTerminal,
  surfaceOfflineCompletions,
} from "./panel/connection.js";
export type { PanelUi } from "./panel/connection.js";
export { delegationEntryRenderer, registerDelegationRenderer } from "./panel/entry-renderer.js";
export { createRemoteTools, registerRemoteTools } from "./tools/remote-tools.js";
export type { RemoteToolsOptions } from "./tools/remote-tools.js";
export { capsToBudget } from "./tools/budget.js";
export { estimateCost, perModelFallback } from "./tools/cost-preview.js";
export { createCronTools, registerCronTools } from "./tools/cron-tools.js";
export type { CronToolsOptions } from "./tools/cron-tools.js";
export { createMemoryTools, registerMemoryTools } from "./tools/memory-tools.js";
export type { MemoryToolsOptions } from "./tools/memory-tools.js";
export { createVaultTools, registerVaultTools } from "./tools/vault-tools.js";
export type { VaultToolsOptions } from "./tools/vault-tools.js";

export {
  runCronList,
  runCronCreate,
  runCronPause,
  runCronUnpause,
  runCronRun,
  runCronArchive,
  runJobs,
  registerCronCommands,
} from "./commands/cron.js";
export type { CronUi, CronCommandDeps } from "./commands/cron.js";

export {
  runMemoryList,
  runMemoryShow,
  runMemoryEdit,
  runMemoryMount,
  registerMemoryCommands,
} from "./commands/memory.js";
export type { MemoryUi, MemoryCommandDeps } from "./commands/memory.js";

export {
  runVaultList,
  runVaultCreate,
  runVaultAddCred,
  runVaultValidate,
  registerVaultCommands,
} from "./commands/vault.js";
export type { VaultUi, VaultCommandDeps } from "./commands/vault.js";

/**
 * Pi extension factory. Loaded by Pi from `~/.pi/agent/extensions/` or
 * `.pi/extensions/`. Registers `/remote:config` (WP-1.11a), the `/remote:*`
 * commands + delegation entry renderer (WP-1.11b), and the `remote_*` agent
 * tools + gating hook + `--remote*` flags (WP-1.11c).
 */
export default function (pi: ExtensionAPI): void {
  registerConfigCommand(pi);
  registerLoginCommand(pi);
  registerDelegationRenderer(pi);
  registerRemoteCommands(pi);
  registerCronCommands(pi);
  registerMemoryCommands(pi);
  registerVaultCommands(pi);
  // WP-1.11c / WP-2.6 tools: the client/api-client/settings accessors are
  // wired by the extension runtime; here we register with best-effort
  // accessors. A full integration pass connects the live ManagedApiClient +
  // settings + UI. The `register*CronTools`/`register*MemoryTools`/
  // `register*VaultTools` functions are exported for explicit wiring in
  // tests/E2E (matching the WP-1.11c `registerRemoteTools` pattern) — they
  // require a configured client, which only exists after /remote:config, so
  // they are not called in the default factory.
}
