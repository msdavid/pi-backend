-- Up Migration

-- Webhook deliveries (§3.10). At-least-once delivery; 2xx-only ack; no redirect
-- following (§23.5). Retention: 90 days (configurable). event_id is unique per
-- event, not per delivery — same id across retries (§23.2).
CREATE TABLE webhook_deliveries (
  tenant_id           text        NOT NULL REFERENCES tenants(id),
  id                  text        PRIMARY KEY,
  webhook_id          text        NOT NULL REFERENCES webhooks(id),
  event_id            text        NOT NULL,           -- unique per event, not per delivery (§23.2)
  event_type          text        NOT NULL,
  payload             jsonb       NOT NULL,           -- thin payload: type+id+createdAt (§23.2)
  attempt             integer     NOT NULL DEFAULT 1,
  status              text        NOT NULL DEFAULT 'pending', -- pending | succeeded | failed
  next_attempt_at     timestamptz,                     -- for the retry loop
  last_response_code  integer,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Retry-loop polling index (§8): pending deliveries due now.
CREATE INDEX idx_webhook_deliveries_pending_next_attempt
  ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_tenant_id ON webhook_deliveries (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS webhook_deliveries CASCADE;
