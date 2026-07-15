-- Up Migration

-- Append-only per-session event projection (R4.1, §9.1/§9.3). The one coherent, numbered
-- event universe: every OutboundEvent the runtime emits is persisted here with a
-- per-session 0-based monotonic `position` that MUST equal the SSE `id` (§9.3). History,
-- pagination, and reconnect replay are served from this projection instead of Pi's raw
-- JSONL, so a `Last-Event-ID` resume replays the SAME numbered stream it streamed live
-- (the pre-R4.1 replay read a differently-typed, differently-numbered JSONL — a category
-- error, not a gap-free resume).
--
-- `event_id` is the OutboundEvent id, the idempotency key: re-appending the same event
-- (a retry) resolves to its existing position rather than duplicating it. The primary
-- key `(session_id, position)` already provides the ascending read/replay index (§9.3);
-- the extra `(session_id, event_id)` index serves the append-time idempotency lookup.
CREATE TABLE session_events (
  tenant_id   text        NOT NULL REFERENCES tenants(id),
  session_id  text        NOT NULL REFERENCES sessions(id),
  position    bigint      NOT NULL,             -- per-session 0-based sequence == SSE id (§9.3)
  type        text        NOT NULL,             -- {domain}.{action} (§9.1)
  event_id    text        NOT NULL,             -- the OutboundEvent id (idempotency key)
  created_at  timestamptz NOT NULL DEFAULT now(),
  payload     jsonb       NOT NULL,
  PRIMARY KEY (session_id, position)
);

-- Idempotency lookup: resolve an already-appended event by its id (see the store's
-- append). The (session_id, position) read/replay index is the primary key above.
CREATE INDEX idx_session_events_session_event_id ON session_events (session_id, event_id);

-- Down Migration

DROP TABLE IF EXISTS session_events CASCADE;
