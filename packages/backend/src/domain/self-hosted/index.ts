/**
 * Self-hosted work queue (WP-4.1, §10.4). Barrel for the self-hosted domain:
 * work queue, work-stats, work.stop, worker keys, and the unsupported-features
 * matrix. Unlocking `environment.type: 'self_hosted'` (environment.ts) is the
 * only environment-service change; everything else lives here.
 */

export {
  enqueue,
  claim,
  postResult,
  fetchWorkItem,
  completeWorkItem,
  toWorkItem,
  type WorkItem,
  type WorkItemStatus,
  type WorkSpec,
  type ToolResultEvent,
  type WorkQueueRow,
} from "./work-queue.js";

export { getWorkStats, assertSelfHosted as assertEnvSelfHosted } from "./work-stats.js";

export { stopWork, type WorkStopInput } from "./work-stop.js";

export {
  issueWorkerKey,
  resolveWorkerKey,
  assertOrgKey,
  requireWorkerKeyForEnv,
  WORKER_SCOPE_PREFIX,
  type IssuedWorkerKey,
  type ResolvedWorkerKey,
} from "./worker-keys.js";

export {
  assertSelfHostedSessionConstraints,
  assertSelfHostedConstraintsForEnv,
  type SessionConstraintInput,
} from "./constraints.js";

export { selfHostedRoutes, type SelfHostedRoutesOptions } from "./routes.js";
