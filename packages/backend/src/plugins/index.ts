/**
 * Public plugin contracts & registration API (WP-5.1).
 *
 * The ports in `domain/ports.ts` are the authoritative contracts; this barrel
 * exposes the registration surface third-party plugins use to override the default
 * implementations. See `docs/plugins.md` for the authoring guide.
 */
export {
  PluginRegistry,
  defaultPluginRegistry,
  registerSandboxProvider,
  registerSecretStore,
  registerObjectStore,
  registerScheduler,
  registerToolRegistry,
  type PluginContext,
  type SandboxProviderFactory,
  type SecretStoreFactory,
  type ObjectStoreFactory,
  type SchedulerFactory,
  type ToolRegistryFactory,
} from "./registry.js";
