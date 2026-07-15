-- Up Migration

-- Shared rate-limit token-bucket store (api-reference.md §"Rate limiting",
-- spec §27.3). Backs `PostgresBucketStore` so the limit ceiling is GLOBAL across
-- replicas (the in-memory `Map` store is per-process → N replicas allow N× the
-- ceiling). One row per bucket key (`tenant:<id>` or `ip:<addr>`); the token
-- count is refilled + decremented atomically via INSERT ... ON CONFLICT ...
-- DO UPDATE ... RETURNING, so concurrent nodes serialize on the row lock.
CREATE TABLE rate_limit_buckets (
  key            text             PRIMARY KEY,          -- bucket key (tenant:<id> | ip:<addr>)
  tokens         double precision NOT NULL,             -- remaining tokens (fractional)
  capacity       double precision NOT NULL,             -- bucket capacity (rpm / anonRpm)
  refill_per_ms  double precision NOT NULL,             -- refill rate (capacity / 60000)
  allowed        boolean          NOT NULL DEFAULT true, -- outcome of the last consume (within the atomic upsert)
  last_refill_ms bigint           NOT NULL,             -- wall-clock ms of the last refill
  updated_at     timestamptz      NOT NULL DEFAULT now()
);

-- The reaper deletes buckets idle past the TTL, keyed off the last refill time.
CREATE INDEX idx_rate_limit_buckets_last_refill ON rate_limit_buckets (last_refill_ms);

-- Down Migration

DROP TABLE IF EXISTS rate_limit_buckets CASCADE;
