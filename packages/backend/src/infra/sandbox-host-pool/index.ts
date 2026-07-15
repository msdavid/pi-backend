/**
 * Multi-host sandbox host pool (WP-4.3, §7.2, §4.2).
 *
 * Host registry, placement router, and liveness monitor. The routing
 * `MultiHostSandboxProvider` lives in `infra/sandbox/`.
 *
 * See `docs/multi-host-design.md`.
 */

export {
  HostRegistry,
  HostNotFoundError,
  type RegisterHostInput,
} from "./registry.js";
export {
  chooseHost,
  NoHostAvailableError,
  type ScoredHost,
} from "./placement.js";
export {
  LivenessMonitor,
  type LivenessMonitorOptions,
} from "./liveness.js";
export type { SandboxHost, UnhealthyReason, HostRegistryPort, LivenessRegistryPort } from "./types.js";
export {
  createHostAgentTokenSource,
  isValidHostAgentToken,
  HostAgentTokenMissingError,
  type HostAgentTokenSource,
} from "./auth.js";
