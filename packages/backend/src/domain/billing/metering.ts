/**
 * Metering hook (WP-5.3, §29.6) — the usage→billing bridge.
 *
 * After each successful `UsageRecorder.record()` (§9.7), the recorder invokes
 * a {@link MeteringHook} callback carrying the tenant id, model, token counts,
 * and derived USD cost it already has in scope. {@link createMeteringHook} turns
 * a {@link BillingSink} into that callback: it builds a {@link MeteringEvent}
 * and dispatches it to the sink **fire-and-forget** (errors are logged, never
 * thrown) so metering never blocks usage recording.
 *
 * The composition root wires the chosen sink:
 *
 * ```ts
 * const sink = billingEndpoint ? new WebhookBillingSink(...) : NOOP_BILLING_SINK;
 * const recorder = createUsageRecorder({ pool, onMetering: createMeteringHook(sink, logger) });
 * ```
 *
 * The single hook call added to `PgUsageRecorder.record()` (clearly marked) is
 * the only modification to the usage recorder. No processor integration (§29.6).
 *
 * No new deps.
 */

import type { Logger } from "pino";
import type { SessionId, TenantId } from "../ports.js";
import type { BillingSink, MeteringEvent } from "./sink.js";

/**
 * The payload the recorder passes to the metering hook after a successful
 * `record()`. `recordedAt` is the wall-clock `Date` of the call; the hook
 * serializes it to ISO-8601 for the {@link MeteringEvent}.
 */
export interface MeteringRecord {
  tenantId: TenantId;
  sessionId: SessionId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD cost derived by the recorder's price table (§9.7). */
  usd: number;
  recordedAt: Date;
}

/**
 * The hook the recorder calls (fire-and-forget). Returns `void`; any async
 * delivery is scheduled internally and never awaited by the recorder.
 */
export type MeteringHook = (record: MeteringRecord) => void;

/**
 * Build a {@link MeteringHook} that emits each record to `sink` as a
 * {@link MeteringEvent}. Fire-and-forget: the sink's promise is not awaited by
 * the caller; delivery errors are logged (or swallowed if no logger) and never
 * thrown, so usage recording is never blocked by billing (§29.6).
 */
export function createMeteringHook(
  sink: BillingSink,
  logger?: Logger,
): MeteringHook {
  return (rec: MeteringRecord): void => {
    const event: MeteringEvent = {
      tenantId: rec.tenantId,
      sessionId: rec.sessionId,
      model: rec.model,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      usdCost: rec.usd,
      recordedAt: rec.recordedAt.toISOString(),
    };
    void sink.recordMetering(event).catch((err) => {
      // Metering is best-effort: never propagate (§29.6).
      logger?.warn(
        { err: String(err), tenantId: rec.tenantId, sessionId: rec.sessionId },
        "billing metering event delivery failed (swallowed)",
      );
    });
  };
}
