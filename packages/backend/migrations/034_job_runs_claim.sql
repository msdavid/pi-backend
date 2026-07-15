-- Up Migration

-- Scheduler recovery-path claim marker — fixes a cross-node double-fire (§17.8).
--
-- The exactly-once *firing* claim is the UNIQUE (job_id, scheduled_at) insert in
-- `fireOccurrence`. The recovery scan (`recoverUntriggered`), however, re-fired
-- any row with `triggered_at IS NULL` via a plain SELECT + execute with no claim:
-- while node A sat inside session creation (its row not yet stamped), node B's
-- recovery SELECT saw the same row and executed it a second time — two sessions
-- for one occurrence. Two nodes running recovery at once double-fired identically.
--
-- `claimed_at` is the recovery CAS marker (mirrors `webhook_deliveries.claimed_at`
-- from 033). `fireOccurrence` stamps it at insert so an in-flight fresh claim is
-- excluded from recovery, and recovery atomically flips it
-- (`… WHERE claimed_at IS NULL OR claimed_at < <lease>` … `RETURNING id`) so
-- exactly one node re-fires a genuinely stale (crashed-mid-execute) row.
ALTER TABLE job_runs
  ADD COLUMN claimed_at timestamptz;

-- Covers the recovery scan predicate (untriggered, unclaimed-or-stale, in-window).
CREATE INDEX idx_job_runs_recovery
  ON job_runs (triggered_at, claimed_at, scheduled_at);

-- Down Migration

DROP INDEX IF EXISTS idx_job_runs_recovery;
ALTER TABLE job_runs DROP COLUMN IF EXISTS claimed_at;
