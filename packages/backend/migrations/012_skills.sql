-- Up Migration

-- Skills (§3.8). Pre-built skills seeded per tenant; custom skills unique by
-- display_title within a tenant (§20.2).
CREATE TABLE skills (
  tenant_id      text        NOT NULL REFERENCES tenants(id),
  id             text        PRIMARY KEY,            -- skill_… prefixed
  display_title  text        NOT NULL,               -- unique among custom skills in tenant (§20.2)
  type           text        NOT NULL,               -- prebuilt | custom (§20.1)
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Custom skills only (§20.2).
CREATE UNIQUE INDEX idx_skills_tenant_title_custom
  ON skills (tenant_id, display_title) WHERE type = 'custom';
CREATE INDEX idx_skills_tenant_id ON skills (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS skills CASCADE;
