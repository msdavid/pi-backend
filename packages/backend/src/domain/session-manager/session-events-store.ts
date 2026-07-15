/**
 * `SessionEventsStore` — the append-only event projection (R4.1, §9.1/§9.3).
 *
 * One coherent, numbered event universe. Every `OutboundEvent` the runtime emits is
 * appended here with a per-session **0-based monotonic `position`** that equals the SSE
 * `id` (§9.3). Reads (history, pagination, reconnect replay) are served from this
 * projection rather than Pi's raw JSONL, so a `Last-Event-ID` resume replays the SAME
 * numbered stream that was streamed live.
 *
 * - {@link append} serializes per-session position allocation with a Postgres per-session
 *   advisory lock (`pg_advisory_xact_lock`) held for the duration of a transaction, so
 *   concurrent appenders to one session can never lose a `MAX(position)+1` race: the winner
 *   inserts the next slot while peers block, then resolve their own next slot in turn. It is
 *   idempotent on the event id (a retry of the same event resolves to its existing position
 *   instead of duplicating it), so it never throws away an event that was streamed live.
 * - {@link read} returns a positional slice as {@link SessionEntry}s (slice semantics:
 *   `start` inclusive, `end` exclusive — matching `SessionRuntime.getEntries`).
 * - {@link count} / {@link head} report the projection size / next position.
 * - {@link deleteOlderThan} / {@link pruneSession} bound the projection's unbounded growth
 *   (called by a retention loop / on session teardown); the projection has no other DELETE.
 */

import { type Pool } from "../../infra/db/index.js";
import type { EntryRange, SessionEntry, SessionId, TenantId } from "../ports.js";

/** The outbound event shape appended to the projection (a slice of `OutboundEvent`). */
export interface SessionEventInput {
  /** Persisted event type (`{domain}.{action}`, §9.1). */
  type: string;
  /** The OutboundEvent id — the append idempotency key. */
  id: string;
  /** ISO-8601 emit timestamp. */
  createdAt: string;
  /** Opaque wire payload (typed fully in `@pi-managed/contracts`). */
  payload: unknown;
}

/** A row of the `session_events` table. `position` arrives as a string (bigint). */
interface SessionEventRow {
  position: string | number;
  type: string;
  event_id: string;
  created_at: Date | string;
  payload: unknown;
}

/**
 * Postgres-backed append-only projection of a session's outbound events. Constructed
 * with a pool; injected into every `ManagedSessionRuntime` (write side) and consumed by
 * the events read path (history/replay).
 */
export class SessionEventsStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Append `event` to `sessionId`'s projection, assigning the next 0-based position.
   * Idempotent on `event.id`: a re-append returns the existing position without inserting
   * a duplicate. Returns the event's position (its SSE id).
   *
   * Per-session appends are serialized by a transaction-scoped advisory lock keyed on the
   * session id, so the `MAX(position)+1` allocation cannot race: concurrent appenders to
   * one session block on the lock and each resolves the next contiguous slot in turn. The
   * lock is keyed on a hash of the session id — an incidental hash collision between two
   * *different* sessions only serializes them (each still allocates from its own session's
   * `MAX(position)`), it never mis-assigns a position.
   */
  async append(
    tenantId: TenantId,
    sessionId: SessionId,
    event: SessionEventInput,
  ): Promise<number> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      // Serialize appends for this session; peers block until we commit (R4.1/ROB-21).
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [sessionId]);

      // One round-trip under the lock: resolve an already-appended event to its existing
      // position, else insert at the next slot. No position race is possible under the lock.
      const { rows } = await client.query<{ position: string | number }>(
        `WITH existing AS (
           SELECT position FROM session_events
             WHERE session_id = $2 AND event_id = $4
         ),
         ins AS (
           INSERT INTO session_events
             (tenant_id, session_id, position, type, event_id, created_at, payload)
           SELECT $1, $2,
                  COALESCE((SELECT MAX(position) FROM session_events WHERE session_id = $2), -1) + 1,
                  $3, $4, $6, $5
             WHERE NOT EXISTS (SELECT 1 FROM existing)
           RETURNING position
         )
         SELECT position FROM ins
         UNION ALL
         SELECT position FROM existing
         LIMIT 1`,
        [
          tenantId,
          sessionId,
          event.type,
          event.id,
          JSON.stringify(event.payload ?? null),
          event.createdAt,
        ],
      );
      await client.query("COMMIT");
      committed = true;
      return Number(rows[0].position);
    } finally {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection already aborted/broken — nothing more to release.
        }
      }
      client.release();
    }
  }

  /**
   * Read a positional slice of the projection. `start` is inclusive, `end` exclusive
   * (slice semantics — matching `SessionRuntime.getEntries`); `limit` caps the count.
   */
  async read(sessionId: SessionId, range: EntryRange = {}): Promise<SessionEntry[]> {
    const params: unknown[] = [sessionId];
    const clauses: string[] = ["session_id = $1"];
    if (range.start !== undefined) {
      params.push(range.start);
      clauses.push(`position >= $${params.length}`);
    }
    if (range.end !== undefined) {
      params.push(range.end);
      clauses.push(`position < $${params.length}`);
    }
    let sql =
      `SELECT position, type, event_id, created_at, payload
         FROM session_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY position ASC`;
    if (range.limit !== undefined) {
      params.push(range.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await this.pool.query<SessionEventRow>(sql, params);
    return rows.map(rowToEntry);
  }

  /** Number of persisted events for `sessionId`. */
  async count(sessionId: SessionId): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM session_events WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0]?.n ?? 0;
  }

  /** The next position that {@link append} would assign (0 when empty). */
  async head(sessionId: SessionId): Promise<number> {
    const { rows } = await this.pool.query<{ head: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0)::int AS head
         FROM session_events WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0]?.head ?? 0;
  }

  /**
   * Retention: delete every event emitted strictly before `cutoff`, across all sessions.
   * The projection has no other DELETE, so without this it grows without bound; a retention
   * loop (see composition root) calls this on an interval. Backed by an index on
   * `created_at` (migration 037). Returns the number of rows deleted.
   *
   * Positions are never reused: pruning old events does not reset a session's `MAX(position)`
   * unless *all* of its events are removed, so a live session's numbering stays monotonic.
   */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM session_events WHERE created_at < $1`,
      [cutoff.toISOString()],
    );
    return rowCount ?? 0;
  }

  /**
   * Retention: delete the whole projection for one session (e.g. on session teardown).
   * Uses the `(session_id, position)` primary key. Returns the number of rows deleted.
   */
  async pruneSession(sessionId: SessionId): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM session_events WHERE session_id = $1`,
      [sessionId],
    );
    return rowCount ?? 0;
  }
}

/** Map a `session_events` row to the port {@link SessionEntry} (positional). */
function rowToEntry(row: SessionEventRow): SessionEntry {
  return {
    position: Number(row.position),
    type: row.type,
    id: row.event_id,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    payload: row.payload,
  };
}
