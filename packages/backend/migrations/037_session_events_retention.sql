-- Up Migration

-- Bound the append-only session-events projection (PERF-9). The projection (migration 030)
-- has no DELETE anywhere, so it grows without bound; the store now exposes retention methods
-- (SessionEventsStore.deleteOlderThan / pruneSession) that a background loop or operator can
-- call. These indexes make those retention/tenant sweeps cheap:
--
--  - `created_at` supports time-based retention (`DELETE ... WHERE created_at < cutoff`), the
--    primary defence against unbounded growth.
--  - `tenant_id` supports tenant-scoped ops (e.g. purging a tenant's events on offboarding),
--    which the FK `session_events.tenant_id -> tenants(id)` otherwise forces a full scan for.
--
-- Per-session reads/replay (§9.3) and pruneSession already use the `(session_id, position)`
-- primary key, so no additional index is needed for those.
CREATE INDEX idx_session_events_created_at ON session_events (created_at);
CREATE INDEX idx_session_events_tenant_id ON session_events (tenant_id);

-- Down Migration

DROP INDEX IF EXISTS idx_session_events_tenant_id;
DROP INDEX IF EXISTS idx_session_events_created_at;
