-- Up Migration

-- Webhooks (§3.10). Auto-disable after ~20 consecutive failures, or immediately
-- on private-IP resolution / redirect (§23.5).
CREATE TABLE webhooks (
  tenant_id            text        NOT NULL REFERENCES tenants(id),
  id                   text        PRIMARY KEY,      -- wh_… prefixed
  url                  text        NOT NULL,         -- HTTPS :443, public hostname (§23.3)
  signing_secret_hash  text        NOT NULL,         -- hash of whsec_… secret (shown once, §23.3)
  event_types          jsonb       NOT NULL DEFAULT '[]', -- subscribed event types (§23.1)
  status               text        NOT NULL DEFAULT 'active', -- active | disabled
  disabled_reason      text,                           -- machine-readable (§23.5)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_tenant_id ON webhooks (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS webhooks CASCADE;
