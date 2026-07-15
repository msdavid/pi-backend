/**
 * In-memory `SessionStore` stub (WP-1.5 test seam). WP-1.6 provides the real
 * Postgres-backed store; until then the runtime is constructed with this (or a fake).
 * Production wiring will swap in the DB impl behind the same interface.
 */

import type { SandboxHandle, SessionId, SessionStatus } from "../ports.js";
import type { StopReason } from "@pi-managed/contracts";
import type { SessionRecord, SessionStore } from "./types.js";

/** Recorded status for a session (in-memory analogue of the row's status columns). */
export interface StoredStatus {
  status: SessionStatus;
  stopReason: StopReason | null;
}

/** A trivial in-memory `SessionStore` for tests and bootstrapping. */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<SessionId, SessionRecord>();
  private readonly etags = new Map<SessionId, string>();
  /** Persisted status/stop-reason (R2.8) — exposed for test assertions. */
  readonly statuses = new Map<SessionId, StoredStatus>();

  /** Seed a record (the session-creation layer normally does this). */
  seed(record: SessionRecord): void {
    this.records.set(record.sessionId, { ...record });
    if (record.lastSyncedEtag) this.etags.set(record.sessionId, record.lastSyncedEtag);
  }

  async get(sessionId: SessionId): Promise<SessionRecord | undefined> {
    const rec = this.records.get(sessionId);
    if (!rec) return undefined;
    return { ...rec, lastSyncedEtag: this.etags.get(sessionId) ?? rec.lastSyncedEtag };
  }

  async saveSyncedEtag(sessionId: SessionId, etag: string): Promise<void> {
    this.etags.set(sessionId, etag);
  }

  async saveSandboxHandle(
    sessionId: SessionId,
    handle: SandboxHandle | null,
  ): Promise<void> {
    const rec = this.records.get(sessionId);
    if (rec) rec.sandboxHandle = handle ?? undefined;
  }

  async saveStatus(
    sessionId: SessionId,
    status: SessionStatus,
    stopReason: StopReason | null,
  ): Promise<void> {
    this.statuses.set(sessionId, { status, stopReason });
  }
}
