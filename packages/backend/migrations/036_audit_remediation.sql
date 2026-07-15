-- Up Migration

-- Audit remediation (ROB-13, PERF-8, ROB-17). Three independent schema changes bundled
-- into one forward-only migration.

-- ROB-13 — instance ownership for boot recovery.
-- Boot recovery resets in-flight (`running`/`rescheduling`) sessions to `idle` after a
-- restart. A global reset flips a PEER instance's live sessions too. `owner_instance_id`
-- records which backend instance last claimed a session so recovery can scope the reset to
-- rows this instance owns, ownerless rows, or rows whose ownership lease has expired.
ALTER TABLE sessions ADD COLUMN owner_instance_id text;

-- PERF-8 — supporting index for `listSessions` (ORDER BY created_at DESC, id DESC).
-- The listing is per-tenant and always excludes archived rows, so a partial composite index
-- matches the query's sort + filter exactly and avoids a full scan + sort.
CREATE INDEX idx_sessions_tenant_created_id
  ON sessions (tenant_id, created_at DESC, id DESC)
  WHERE status <> 'archived';

-- ROB-17 — per-placement resource footprint for real admission control.
-- The placement router previously compared a spec against a host's TOTAL capacity, ignoring
-- VMs already placed there, so a host could be oversubscribed without bound. Record each
-- placement's cpus/memory so the router can subtract live usage from remaining capacity.
-- Defaults cover rows written before this migration (compileProvisionSpec's own defaults).
ALTER TABLE sandbox_host_placements
  ADD COLUMN cpus       integer NOT NULL DEFAULT 1,
  ADD COLUMN memory_mib integer NOT NULL DEFAULT 512;

-- Down Migration

ALTER TABLE sandbox_host_placements
  DROP COLUMN IF EXISTS cpus,
  DROP COLUMN IF EXISTS memory_mib;

DROP INDEX IF EXISTS idx_sessions_tenant_created_id;

ALTER TABLE sessions DROP COLUMN IF EXISTS owner_instance_id;
