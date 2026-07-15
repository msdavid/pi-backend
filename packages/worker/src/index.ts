/**
 * @pi-managed/worker — default self-hosted worker (spec §10.4, Phase 4).
 *
 * A subscriber runs this worker against a `self_hosted` environment. The worker
 * is always-on + webhook-triggered, outbound-HTTPS-only (it never listens). Two
 * control levels:
 *  - `builtin`: the worker runs tools directly on its host (subprocess/bash).
 *  - `spawn`:   the worker hands each claimed session to a user-supplied spawn
 *    script (config `spawnScript`) for per-session sandbox isolation. The script
 *    receives the work item + tool calls on stdin, returns results on stdout.
 *
 * Worker HTTP surface (WP-4.1, authoritative — `backend/routes.ts`):
 *  - `POST /v1/environments/:id/work-claim`  → 204 (empty) | 200 `{WorkItem}`
 *  - `POST /v1/sessions/:id/work-result`     → 200 (append `user.tool_result`)
 *
 * NOTE: the WP-4.2 brief names `POST /v1/sessions/:id/events` as the result
 * channel; that route is the user-facing event-send surface (routed into the
 * live session runtime) and is NOT the worker channel. `work-result` is the
 * worker→control-plane channel (appends to the work item's `results`). See open
 * questions in the WP-4.2 report.
 */

export { loadConfig, validateConfig, type WorkerConfig, type WorkerMode, type ControlLevel } from "./config.js";
export {
  type WorkItem,
  type WorkSpec,
  type ToolCall,
  type ToolResult,
  type Executor,
  BuiltinExecutor,
  SpawnExecutor,
  extractToolCalls,
} from "./control-levels.js";
export { Poller } from "./poller.js";
export { WebhookMode, type WakeSignal } from "./webhook-mode.js";
