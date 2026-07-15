/**
 * Public plugin contracts & registration API (WP-5.1, spec §29.6, §3 principle 3).
 *
 * The backend's subsystem seams are the ports in {@link ../domain/ports.ts} — that
 * file is **authoritative** for the contract each plugin must satisfy. This module
 * formalizes them as a public extension surface: a {@link PluginRegistry} that the
 * app composition root (`app.ts`) consults, with the real implementations as the
 * defaults used unless a plugin overrides them.
 *
 * ## Authoring a plugin
 *
 * 1. Implement the port interface (e.g. `SandboxProvider`) from
 *    `@pi-managed/backend`. The port's JSDoc IS the contract.
 * 2. Run the matching conformance kit from `@pi-managed/testkit/conformance` to prove
 *    parity with the reference (fake) behavior.
 * 3. Register a factory via `registerSandboxProvider(factory)` (or construct a
 *    `PluginRegistry` and pass it to `createManagedApp({ pluginRegistry })`).
 *
 * See `docs/plugins.md` for the full authoring guide.
 *
 * ## §25.5 invariant
 *
 * No plugin interface accepts or returns a raw secret value. Credentials flow only
 * as opaque `SecretBinding` refs. Plugin factories MUST NOT log binding contents.
 */

import type {
  ObjectStore,
  SandboxProvider,
  Scheduler,
  SecretStore,
} from "../domain/ports.js";
import type { Config } from "../infra/config/index.js";
import type { Pool } from "../infra/db/index.js";
import type { Logger } from "pino";

/**
 * Context handed to every plugin factory. Carries the resolved app config, the
 * Postgres pool, and the root logger — everything a default-impl-equivalent plugin
 * needs. Plugins MUST NOT retain credentials in closures derived from this context.
 */
export interface PluginContext {
  config: Config;
  logger: Logger;
  pool: Pool;
}

/** Factory that builds a {@link SandboxProvider} for a given {@link PluginContext}. */
export type SandboxProviderFactory = (
  ctx: PluginContext,
) => SandboxProvider | Promise<SandboxProvider>;

/** Factory that builds a {@link SecretStore} for a given {@link PluginContext}. */
export type SecretStoreFactory = (
  ctx: PluginContext,
) => SecretStore | Promise<SecretStore>;

/** Factory that builds an {@link ObjectStore} for a given {@link PluginContext}. */
export type ObjectStoreFactory = (
  ctx: PluginContext,
) => ObjectStore | Promise<ObjectStore>;

/** Factory that builds a {@link Scheduler} for a given {@link PluginContext}. */
export type SchedulerFactory = (
  ctx: PluginContext,
) => Scheduler | Promise<Scheduler>;

/**
 * Factory for a tool registry.
 *
 * NOTE: there is currently **no `ToolRegistry` port** in `domain/ports.ts` (the
 * authoritative contract source). This registration hook is published now as a
 * reserved extension point so plugins can register a tool-registry implementation
 * against a future port without changing the registration API. The opaque return
 * type reflects that the contract is not yet formalized.
 */
export type ToolRegistryFactory = (
  ctx: PluginContext,
) => unknown | Promise<unknown>;

/**
 * Registry of plugin overrides. The composition root consults this before falling
 * back to the real (default) implementations: when no factory is registered for a
 * port, `resolve*` returns `undefined` and the default is used — so registering no
 * plugins yields identical behavior to the un-plugged app.
 *
 * Thread-safety: registration is expected to happen at boot (before
 * `createManagedApp`), not concurrently with resolution.
 */
export class PluginRegistry {
  private sandboxFactory?: SandboxProviderFactory;
  private secretFactory?: SecretStoreFactory;
  private objectFactory?: ObjectStoreFactory;
  private schedulerFactory?: SchedulerFactory;
  private toolRegistryFactory?: ToolRegistryFactory;

  /** Register a {@link SandboxProvider} factory override. */
  registerSandboxProvider(factory: SandboxProviderFactory): this {
    this.sandboxFactory = factory;
    return this;
  }

  /** Register a {@link SecretStore} factory override. */
  registerSecretStore(factory: SecretStoreFactory): this {
    this.secretFactory = factory;
    return this;
  }

  /** Register an {@link ObjectStore} factory override. */
  registerObjectStore(factory: ObjectStoreFactory): this {
    this.objectFactory = factory;
    return this;
  }

  /** Register a {@link Scheduler} factory override. */
  registerScheduler(factory: SchedulerFactory): this {
    this.schedulerFactory = factory;
    return this;
  }

  /** Register a tool-registry factory (reserved — no port yet, see module doc). */
  registerToolRegistry(factory: ToolRegistryFactory): this {
    this.toolRegistryFactory = factory;
    return this;
  }

  /** Resolve the sandbox override, or `undefined` to use the default impl. */
  async resolveSandboxProvider(
    ctx: PluginContext,
  ): Promise<SandboxProvider | undefined> {
    return this.sandboxFactory ? await this.sandboxFactory(ctx) : undefined;
  }

  /** Resolve the secret-store override, or `undefined` to use the default impl. */
  async resolveSecretStore(
    ctx: PluginContext,
  ): Promise<SecretStore | undefined> {
    return this.secretFactory ? await this.secretFactory(ctx) : undefined;
  }

  /** Resolve the object-store override, or `undefined` to use the default impl. */
  async resolveObjectStore(
    ctx: PluginContext,
  ): Promise<ObjectStore | undefined> {
    return this.objectFactory ? await this.objectFactory(ctx) : undefined;
  }

  /** Resolve the scheduler override, or `undefined` to use the default impl. */
  async resolveScheduler(
    ctx: PluginContext,
  ): Promise<Scheduler | undefined> {
    return this.schedulerFactory ? await this.schedulerFactory(ctx) : undefined;
  }

  /** Resolve the tool-registry override, or `undefined` (reserved — no port yet). */
  async resolveToolRegistry(
    ctx: PluginContext,
  ): Promise<unknown | undefined> {
    return this.toolRegistryFactory
      ? await this.toolRegistryFactory(ctx)
      : undefined;
  }

  /** Whether any sandbox-provider override is registered. */
  hasSandboxProvider(): boolean {
    return this.sandboxFactory !== undefined;
  }
  /** Whether any secret-store override is registered. */
  hasSecretStore(): boolean {
    return this.secretFactory !== undefined;
  }
  /** Whether any object-store override is registered. */
  hasObjectStore(): boolean {
    return this.objectFactory !== undefined;
  }
  /** Whether any scheduler override is registered. */
  hasScheduler(): boolean {
    return this.schedulerFactory !== undefined;
  }
  /** Whether any tool-registry override is registered. */
  hasToolRegistry(): boolean {
    return this.toolRegistryFactory !== undefined;
  }
}

/**
 * The process-wide default registry. The `register*` convenience functions below
 * register onto this instance, and `createManagedApp` consults it by default.
 * Construct your own `PluginRegistry` and pass it via `pluginRegistry` for
 * isolation in tests.
 */
export const defaultPluginRegistry = new PluginRegistry();

/** Register a {@link SandboxProvider} on the {@link defaultPluginRegistry}. */
export function registerSandboxProvider(
  factory: SandboxProviderFactory,
): PluginRegistry {
  return defaultPluginRegistry.registerSandboxProvider(factory);
}

/** Register a {@link SecretStore} on the {@link defaultPluginRegistry}. */
export function registerSecretStore(
  factory: SecretStoreFactory,
): PluginRegistry {
  return defaultPluginRegistry.registerSecretStore(factory);
}

/** Register an {@link ObjectStore} on the {@link defaultPluginRegistry}. */
export function registerObjectStore(
  factory: ObjectStoreFactory,
): PluginRegistry {
  return defaultPluginRegistry.registerObjectStore(factory);
}

/** Register a {@link Scheduler} on the {@link defaultPluginRegistry}. */
export function registerScheduler(factory: SchedulerFactory): PluginRegistry {
  return defaultPluginRegistry.registerScheduler(factory);
}

/** Register a tool-registry factory on the {@link defaultPluginRegistry} (reserved). */
export function registerToolRegistry(
  factory: ToolRegistryFactory,
): PluginRegistry {
  return defaultPluginRegistry.registerToolRegistry(factory);
}
