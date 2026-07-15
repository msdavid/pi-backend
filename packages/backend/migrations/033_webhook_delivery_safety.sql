-- Up Migration

-- R5.4 — Webhook dispatcher multi-node safety.
--
-- The dispatcher's "claim" (FOR UPDATE SKIP LOCKED) now runs inside a
-- transaction that flips pending → 'delivering' before COMMIT, so another
-- node's status='pending' claim SELECT skips in-flight rows. `claimed_at`
-- records when a row was claimed so a reaper can reset rows stuck in
-- 'delivering' (a crashed node) back to 'pending'.
ALTER TABLE webhook_deliveries
  ADD COLUMN claimed_at timestamptz;

-- Real dedup for enqueue (replacing the check-then-act): the docstring already
-- claimed idempotency per (webhook_id, event_id); enforce it so a concurrent
-- double-enqueue collapses to one row via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX idx_webhook_deliveries_webhook_event
  ON webhook_deliveries (webhook_id, event_id);

-- GIN index for the fanout `event_types @> '[type]'` containment query.
CREATE INDEX idx_webhooks_event_types
  ON webhooks USING gin (event_types jsonb_path_ops);

-- Down Migration

DROP INDEX IF EXISTS idx_webhooks_event_types;
DROP INDEX IF EXISTS idx_webhook_deliveries_webhook_event;
ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS claimed_at;
