-- Up Migration

-- API keys (§3.1). Raw key never stored; only the argon2id hash (§8).
CREATE TABLE api_keys (
  id           text        PRIMARY KEY,            -- apikey_… prefixed
  tenant_id    text        NOT NULL REFERENCES tenants(id),
  key_hash     text        NOT NULL,               -- argon2id hash
  name         text        NOT NULL,               -- human label
  scopes       jsonb       NOT NULL DEFAULT '[]',   -- scoped permissions
  last_used_at timestamptz,                         -- nullable
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz                          -- non-null = revoked
);

CREATE INDEX idx_api_keys_tenant_id ON api_keys (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS api_keys CASCADE;
