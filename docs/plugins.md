# Plugin Authoring Guide

> The Pi Managed Backend formalizes its subsystem seams as **public plugin
> contracts** (spec §29.6, §3 principle 3). Every seam is a port interface in
> `packages/backend/src/domain/ports.ts` — **that file is authoritative** for the
> contract each plugin must satisfy. This guide shows how to implement a port,
> prove conformance, and register your implementation so the composition root uses
> it in place of the default.

## Ports you can override

| Port | Default impl | Registration function |
| --- | --- | --- |
| `SandboxProvider` | `MicrosandboxProvider` (when `SANDBOX_RUNTIME=enabled`) | `registerSandboxProvider` |
| `SecretStore` | `createVaultSecretStore` (Postgres vault) | `registerSecretStore` |
| `ObjectStore` | `FilesystemObjectStore` / S3 (config-derived) | `registerObjectStore` |
| `Scheduler` | `CronScheduler` | `registerScheduler` _(reserved — registration accepted but not yet consulted by the composition root)_ |
| `ToolRegistry` | _(reserved — no port in `ports.ts` yet)_ | `registerToolRegistry` |

The `PluginRegistry` is consulted by the composition root (`createManagedApp`) for
each port **before** the default implementation is built. When no factory is
registered for a port, the default is used — so an app with no plugins registered
behaves identically to the un-plugged app. Exception: the `Scheduler` row is
currently **reserved** — `registerScheduler`/`resolveScheduler` exist on the
registry, but `createManagedApp` builds the scheduler directly (the concrete
`CronScheduler` is instantiated in `domain/scheduler/tick.ts`) without consulting
the registry, so a registered scheduler factory has no effect yet.

## §25.5 invariant (read this first)

**No plugin interface accepts or returns a raw secret value.** Credentials flow only
as opaque `SecretBinding` refs (a placeholder name the guest sees + a credential
reference the provider resolves host-side). Concretely:

- A `SandboxProvider` receives `SecretBinding[]` in `ProvisionSpec` and via
  `registerSecretBinding`. It resolves the real values host-side; the guest sees
  only `$MSB_…` placeholders.
- A `SecretStore` returns only `SecretBinding` refs — never the underlying value.
- Plugin factories **MUST NOT** log `SecretBinding` contents or persist raw
  secrets into closures.

## Writing a custom plugin

### 1. Implement the port

Implement the interface from `@pi-managed/backend`. The JSDoc on each method IS
the contract — read `domain/ports.ts` for the authoritative behavior.

```ts
import type { SandboxProvider, ProvisionSpec, SandboxHandle } from "@pi-managed/backend";

export class MySandboxProvider implements SandboxProvider {
  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    // ...create the microVM, stage secret bindings host-side (refs only)...
    return { id: "…", name: spec.name, labels: spec.labels };
  }
  async exec(handle, opts) { /* … */ }
  async execStream(handle, opts) { /* … async iterable … */ }
  async stop(handle) { /* … */ }
  async start(handle) { /* … */ }
  async snapshot(handle) { return "snap_…"; }
  async destroy(handle) { /* … purge bindings … */ }
  async reattachByLabels(labels) { return []; }
  async status(handle) { return "running"; }
  async registerSecretBinding(handle, binding) { /* refs only — never a value */ }
}
```

### 2. Run the conformance suite

Every port has a published conformance kit in `@pi-managed/testkit` that asserts
your impl matches the reference (fake) behavior. Add a vitest suite that calls the
kit with a fixture constructing your impl:

```ts
import { describe } from "vitest";
import { runSandboxProviderConformance } from "@pi-managed/testkit";
import { MySandboxProvider } from "./my-sandbox.js";

describe("MySandboxProvider conformance", () => {
  runSandboxProviderConformance("MySandboxProvider", async () => ({
    provider: new MySandboxProvider(),
    // For in-memory impls: script the `echo hello` outputs. For real VM impls:
    // omit `seed` (the command runs for real).
    seed: (name) => { /* script exec output keyed by name */ },
    cleanup: async () => { /* teardown */ },
  }));
});
```

Available kits:

- `runSandboxProviderConformance(name, make)` — `SandboxProvider` (§5.4, §10)
- `runObjectStoreConformance(name, make)` — `ObjectStore` (§28)
- `runSecretStoreConformance(name, make)` — `SecretStore` (§12, §25)

Each `make` may return `null` to skip the suite in environments where the impl
can't be provisioned (e.g. no KVM, no Docker). The fakes ship as the reference
behavior and always pass.

The fixture interfaces (`SandboxProviderFixture`, `ObjectStoreFixture`,
`SecretStoreFixture`) document the optional `seed` / `cleanup` hooks.

### 3. Register your plugin

Register a factory on the default registry (process-wide) **before**
`createManagedApp` runs:

```ts
import { registerSandboxProvider } from "@pi-managed/backend";

registerSandboxProvider((ctx) => new MySandboxProvider(ctx.config, ctx.logger));
```

The factory receives a `PluginContext` (`{ config, logger, pool }`) — everything
the default impls receive. Return the constructed port; async factories are
supported.

For test isolation, construct your own registry and pass it explicitly:

```ts
import { PluginRegistry, createManagedApp } from "@pi-managed/backend";

const registry = new PluginRegistry().registerObjectStore(
  (ctx) => new MyObjectStore(ctx.config),
);
await createManagedApp({ config, logger, pluginRegistry: registry });
```

## Composition-root precedence

For each wired port, `createManagedApp` resolves in this order:

1. A direct option override (`opts.sandboxProvider`, `opts.objectStoreConfig`) — the
   existing test escape hatch.
2. The `PluginRegistry` override (`pluginRegistry.resolve*`, default
   `defaultPluginRegistry`).
3. The default implementation (config-derived).

So direct test options win, then plugins, then defaults. Registering no plugins
yields the default graph with zero behavior change.

## Adding a new port

Ports live in `domain/ports.ts` (authoritative). To make a new port pluggable:

1. Add the interface + JSDoc to `domain/ports.ts`.
2. Add a `*Factory` type + `register*` / `resolve*` pair to
   `packages/backend/src/plugins/registry.ts`.
3. Add a conformance kit under `packages/testkit/src/conformance/` and export it
   from the testkit barrel.
4. Wire the registry resolution into `createManagedApp` (`app.ts`).
