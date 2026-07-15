-- Up Migration

-- Vault credentials (§3.5, §12.4). Secrets stored as AES-256-GCM ciphertext;
-- raw values never in Postgres (§4, §28). Archive purges secret_enc but keeps
-- the key visible/freed for replacement (§12.7).
CREATE TABLE vault_credentials (
  tenant_id  text        NOT NULL REFERENCES tenants(id),
  vault_id   text        NOT NULL REFERENCES vaults(id),
  key        text        NOT NULL,                 -- mcpServerUrl | secretName (§12.1); immutable
  category   text        NOT NULL,                 -- static_bearer|environment_variable|mcp_oauth (§12.1)
  secret_enc bytea,                                 -- AES-256-GCM ciphertext; null when archived
  key_id     text,                                    -- which KMS/keyfile key encrypted this
  nonce      bytea,                                   -- GCM nonce
  metadata   jsonb       NOT NULL DEFAULT '{}',     -- non-sensitive (e.g. mcp_oauth refresh config)
  status     text        NOT NULL DEFAULT 'active',  -- active | archived
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique key per vault (§12.4).
CREATE UNIQUE INDEX idx_vault_credentials_vault_key ON vault_credentials (vault_id, key);
CREATE INDEX idx_vault_credentials_tenant_id ON vault_credentials (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS vault_credentials CASCADE;
