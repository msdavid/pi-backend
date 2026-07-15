/**
 * IPC protocol between the control plane (parent) and a session worker (child) — R7.1.
 *
 * Every message is plain JSON (the default `child_process.fork` serialization): the wire
 * carries only ids, wire events, ranges, and sandbox handles — never a secret value, never
 * a live object. The child owns the {@link ManagedSessionRuntime}s; the parent owns the
 * HTTP surface, the registry (LRU/idle eviction) and the SSE fan-out.
 *
 * Shape:
 *  - parent → child: one `init` (the validated {@link Config}), then request/response RPCs
 *    mirroring the `SessionRuntime` port (`wake` / `sendEvent` / `interrupt` / `getEntries`
 *    / `dispose`).
 *  - child → parent: `ready` (or `init_error`), one `reply` per RPC, and an unsolicited
 *    `event` per outbound event the runtime emits, plus a `state` push whenever the
 *    session's status / sandbox handle changes.
 *
 * `status()` is synchronous on the port, so it cannot be an RPC. The child pushes state on
 * every transition instead and the parent's proxy answers `status()` from that cache — see
 * `remote-runtime.ts` for the (bounded) staleness this implies.
 */

import type { Config } from "../../infra/config/index.js";
import type {
  EntryRange,
  InboundEvent,
  SandboxHandle,
  SessionContext,
  SessionEntry,
  SessionId,
  SessionStatus,
} from "../ports.js";
import type { PositionedOutboundEvent } from "../event-stream/stream.js";

/** The per-session state the child pushes to the parent (the proxy's cache). */
export interface RemoteSessionState {
  status: SessionStatus;
  /** The bound microVM (R2.8) — the parent's outputs routes resolve it from here. */
  sandboxHandle?: SandboxHandle;
  /** Re-resolution context (§12.5) — feeds the parent's vault revalidation loop. */
  sessionContext?: SessionContext;
}

/** Parent → child messages. */
export type ParentMessage =
  | { t: "init"; workerIndex: number; config: Config }
  | { t: "rpc"; id: number; op: "wake"; sessionId: SessionId }
  | { t: "rpc"; id: number; op: "sendEvent"; sessionId: SessionId; event: InboundEvent }
  | { t: "rpc"; id: number; op: "interrupt"; sessionId: SessionId }
  | { t: "rpc"; id: number; op: "getEntries"; sessionId: SessionId; range?: EntryRange }
  | { t: "rpc"; id: number; op: "dispose"; sessionId: SessionId };

/** The value a successful RPC reply carries, by op. */
export interface RpcResults {
  wake: RemoteSessionState;
  sendEvent: null;
  interrupt: null;
  getEntries: SessionEntry[];
  dispose: null;
}

/** Child → parent messages. */
export type ChildMessage =
  | { t: "ready"; pid: number }
  | { t: "init_error"; message: string }
  | { t: "reply"; id: number; ok: true; value: unknown; state?: RemoteSessionState }
  | { t: "reply"; id: number; ok: false; error: string }
  | {
      t: "event";
      sessionId: SessionId;
      event: PositionedOutboundEvent;
      state: RemoteSessionState;
    }
  | { t: "state"; sessionId: SessionId; state: RemoteSessionState };

/**
 * Deterministic shard: FNV-1a over the session id, modulo the worker count. Deterministic
 * so the SAME session always lands on the SAME worker for as long as the pool has the same
 * width — two concurrent `getOrCreate`s can therefore never wake one session in two
 * processes (which would provision two VMs and fork the JSONL).
 */
export function shardFor(sessionId: string, workerCount: number): number {
  if (workerCount <= 1) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    // FNV prime (32-bit), via Math.imul to stay in int32 range.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % workerCount;
}
