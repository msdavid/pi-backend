-- Up Migration

-- Agent versions (§3.2). Immutable once created (update creates a new version).
CREATE TABLE agent_versions (
  tenant_id  text        NOT NULL REFERENCES tenants(id),
  agent_id   text        NOT NULL REFERENCES agents(id),
  version    integer     NOT NULL,
  config     jsonb       NOT NULL,                 -- model, systemPrompt, tools, skills, …
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)                  -- §3.2 PK
);

CREATE INDEX idx_agent_versions_tenant_agent ON agent_versions (tenant_id, agent_id);

-- Down Migration

DROP TABLE IF EXISTS agent_versions CASCADE;
