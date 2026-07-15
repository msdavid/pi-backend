-- Up Migration

-- Usage & quota accounting (§3.13). Append-only — per-session/per-tenant/
-- per-agent rollups (§9.7, §26.2). Attribution via session metadata.userId (§26.2).
CREATE TABLE usage_records (
  tenant_id                   text        NOT NULL REFERENCES tenants(id),
  session_id                  text        NOT NULL REFERENCES sessions(id),
  model                       text        NOT NULL, -- provider + model id
  input_tokens                bigint      NOT NULL DEFAULT 0,
  output_tokens               bigint      NOT NULL DEFAULT 0,
  cache_creation_input_tokens bigint      NOT NULL DEFAULT 0, -- §9.7
  cache_read_input_tokens     bigint      NOT NULL DEFAULT 0,
  usd_cost                    numeric(12,6) NOT NULL DEFAULT 0, -- per-model price table (§9.7)
  recorded_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_records_tenant_session_recorded
  ON usage_records (tenant_id, session_id, recorded_at);
CREATE INDEX idx_usage_records_tenant_recorded ON usage_records (tenant_id, recorded_at);

-- Down Migration

DROP TABLE IF EXISTS usage_records CASCADE;
