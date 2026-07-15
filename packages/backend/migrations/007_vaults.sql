-- Up Migration

-- Vaults (§3.5). Archive cascades to all credentials (§12.7).
CREATE TABLE vaults (
  tenant_id  text        NOT NULL REFERENCES tenants(id),
  id         text        PRIMARY KEY,              -- vault_… prefixed
  name       text        NOT NULL,                 -- 1–128 chars
  status     text        NOT NULL DEFAULT 'active', -- active | archived (§12.7)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_vaults_tenant_id_name ON vaults (tenant_id, name);
CREATE INDEX idx_vaults_tenant_id ON vaults (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS vaults CASCADE;
