/**
 * microsandbox infrastructure (WP-1.3, §10).
 *
 * Exports the real {@link MicrosandboxProvider} (NAPI SDK) and the
 * {@link compileNetworkPolicy} compiler. The testkit fake lives in `@pi-managed/testkit`.
 * The multi-host routing provider ({@link MultiHostSandboxProvider}, WP-4.3) wraps
 * many host-local providers; the host pool registry/placement/liveness live in
 * `infra/sandbox-host-pool`.
 */

export { MicrosandboxProvider } from "./provider.js";
export type {
  MicrosandboxProviderOptions,
  SecretResolver,
} from "./provider.js";
export { compileNetworkPolicy, unrestrictedIsPublicOnly } from "./network-policy.js";
export {
  MultiHostSandboxProvider,
  HttpHostAgent,
  HostUnavailableError,
  type MultiHostSandboxProviderOptions,
  type HostAgent,
  type HostAgentFactory,
} from "./multi-host-provider.js";
