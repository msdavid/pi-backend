-- Up Migration

-- Idempotency-Key replay store (api-reference.md §"Idempotency-Key").
-- Persists the response for a (tenant_id, key_hash) pair so a replayed
-- mutating POST returns the stored response byte-for-byte within a 24h window.
-- Same key + different request body → 409 idempotency_conflict.
CREATE TABLE idempotency_keys (
  tenant_id         text        NOT NULL REFERENCES tenants(id),
  key_hash          text        NOT NULL,               -- sha256 hex of Idempotency-Key
  request_body_hash text        NOT NULL,               -- sha256 hex of normalized body
  response_status   integer     NOT NULL,               -- stored HTTP status
  response_body     text        NOT NULL,               -- stored response body (JSON text)
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,               -- created_at + 24h
  UNIQUE (tenant_id, key_hash)                          -- per-tenant key uniqueness (§"Idempotency-Key")
);

CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

-- Down Migration

DROP TABLE IF EXISTS idempotency_keys CASCADE;
