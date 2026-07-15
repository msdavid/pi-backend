-- Up Migration

-- Harden the session-events projection idempotency guard into a hard DB invariant.
--
-- The store's append (session-events-store.ts) is idempotent on `event_id` via a
-- read-then-insert CTE, and the runtime now sources every event's position from that
-- append (the single numbered universe, R4.1) — but two appenders that race past the
-- `NOT EXISTS` check could still insert the same `event_id` at two positions, which would
-- reintroduce exactly the divergence R4.1 exists to prevent. Replace the non-unique
-- idempotency-lookup index (migration 030) with a UNIQUE constraint so the projection can
-- never hold the same event twice. `append` catches the resulting unique-violation and
-- resolves to the event's existing position.
DROP INDEX IF EXISTS idx_session_events_session_event_id;

CREATE UNIQUE INDEX idx_session_events_session_event_id
  ON session_events (session_id, event_id);

-- Down Migration

DROP INDEX IF EXISTS idx_session_events_session_event_id;

CREATE INDEX idx_session_events_session_event_id
  ON session_events (session_id, event_id);
