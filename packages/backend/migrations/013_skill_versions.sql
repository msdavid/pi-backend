-- Up Migration

-- Skill versions (§3.8). Bundles live in the object store at object_key.
CREATE TABLE skill_versions (
  tenant_id  text        NOT NULL REFERENCES tenants(id),
  skill_id   text        NOT NULL REFERENCES skills(id),
  version    integer     NOT NULL,
  object_key text        NOT NULL,                  -- object-store key for the bundle
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);

CREATE INDEX idx_skill_versions_tenant_skill ON skill_versions (tenant_id, skill_id);

-- Down Migration

DROP TABLE IF EXISTS skill_versions CASCADE;
