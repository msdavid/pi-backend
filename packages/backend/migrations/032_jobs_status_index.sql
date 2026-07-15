-- Up Migration

-- Partial index matching the scheduler tick scan predicate (§17.8). The cron
-- loop sweeps `SELECT * FROM jobs WHERE status = 'active'` every tick across all
-- tenants; a partial index on the active subset keeps that scan cheap as the
-- archived/paused population grows.
CREATE INDEX idx_jobs_status ON jobs (status) WHERE status = 'active';

-- Down Migration

DROP INDEX IF EXISTS idx_jobs_status;
