-- Up Migration

-- Durable last-synced object-store etag for the session's JSONL log (R2.10). The
-- backend syncs the local JSONL to the object store with a conditional put keyed by
-- this etag (§28). Previously the etag lived only in an in-process Map, so a restart
-- lost the optimistic-concurrency basis and forced a redundant full re-sync. Persisting
-- it here makes the JSONL sync's optimistic concurrency survive process restarts.
ALTER TABLE sessions ADD COLUMN synced_etag text;

-- Down Migration

ALTER TABLE sessions DROP COLUMN IF EXISTS synced_etag;
