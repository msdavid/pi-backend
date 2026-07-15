-- Up Migration

-- Agents (§3.2). No hard delete — only archive (§6.1); archived blocks new sessions.
CREATE TABLE agents (
  tenant_id        text        NOT NULL REFERENCES tenants(id),
  id               text        PRIMARY KEY,        -- agent_… prefixed
  name             text        NOT NULL,           -- 1–128 chars
  current_version  integer     NOT NULL DEFAULT 1, -- points at agent_versions.version
  status           text        NOT NULL DEFAULT 'active', -- active | archived
  metadata         jsonb       NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Per-tenant name uniqueness (§6.6).
CREATE UNIQUE INDEX idx_agents_tenant_id_name ON agents (tenant_id, name);
-- Row-level tenant filter index (§8).
CREATE INDEX idx_agents_tenant_id ON agents (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS agents CASCADE;
