-- Up Migration

-- Tenancy root (§3.1). Single-tenant deployments auto-create the implicit
-- tenant (§7.1). Every tenant-scoped table FKs to this.
CREATE TABLE tenants (
  id          text        PRIMARY KEY,             -- tnt_… prefixed (§2)
  name        text        NOT NULL,                -- org name
  quota_plan  text,                                 -- default tier (§27.3)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS tenants CASCADE;
