/**
 * @pi-managed/backend — Contracts ↔ ports event adapters (WP-1.7).
 *
 * Bridges the two event shapes that meet at the Events API:
 * - `@pi-managed/contracts` events are the *wire* shape (flat: `{type, content, …}`
 *   plus `processedAt` on outbound/persisted events).
 * - `domain/ports` `InboundEvent`/`OutboundEvent`/`SessionEntry` are the *runtime*
 *   seam shape (`{type, id, createdAt, payload}`).
 *
 * The {@link ManagedSessionRuntime} emits and consumes the ports shape; the HTTP
 * layer speaks the contracts shape. These adapters translate between them.
 */

import { randomUUID } from "node:crypto";
import type { InboundEvent as ContractsInboundEvent } from "@pi-managed/contracts";
import type {
  InboundEvent as PortsInboundEvent,
  OutboundEvent,
  SessionEntry,
} from "../ports.js";

/** Generate a server-side event id (`evt_<opaque>`, §"ID format"). */
export function generateEventId(): string {
  return `evt_${randomUUID()}`;
}

/** Current time as an RFC 3339 UTC string (the `processedAt`/`createdAt` value). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Adapt a validated contracts inbound event (flat: `{type, content, …}`) into the
 * ports {@link PortsInboundEvent} shape the runtime consumes
 * (`{type, id, createdAt, payload}`). The runtime reads domain fields off
 * `event.payload` (e.g. `handleUserMessage` reads `event.payload.content`).
 */
export function inboundToPorts(event: ContractsInboundEvent): PortsInboundEvent {
  const { type, ...payload } = event;
  return {
    type,
    id: generateEventId(),
    createdAt: nowIso(),
    payload,
  };
}

/**
 * Build the wire `data` payload for a live outbound event: the contracts flat shape
 * (`{type, …payload, processedAt}`). `processedAt` is the event's `createdAt` — a
 * live event is being processed now (not queued), so `processedAt` is non-null.
 */
export function outboundWireData(event: OutboundEvent): Record<string, unknown> {
  return {
    type: event.type,
    ...((event.payload as Record<string, unknown> | undefined) ?? {}),
    processedAt: event.createdAt,
  };
}

/**
 * Build the wire `data` payload for a replayed/persisted session log entry. The
 * entry's `createdAt` is the persisted timestamp → `processedAt`.
 */
export function entryWireData(entry: SessionEntry): Record<string, unknown> {
  return {
    type: entry.type,
    ...((entry.payload as Record<string, unknown> | undefined) ?? {}),
    processedAt: entry.createdAt,
  };
}

/** A history-list item: `{seq, type, …payload, processedAt}` (§"GET /events"). */
export interface HistoryItem {
  seq: number;
  type: string;
  id: string;
  processedAt: string | null;
  [k: string]: unknown;
}

/** Build a history-list item from a positional session log entry. */
export function entryToHistoryItem(entry: SessionEntry): HistoryItem {
  return {
    seq: entry.position,
    type: entry.type,
    id: entry.id,
    ...((entry.payload as Record<string, unknown> | undefined) ?? {}),
    processedAt: entry.createdAt,
  };
}
