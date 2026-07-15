-- Up Migration

-- Environments (§3.2). Not versioned (§6.2). Both hard delete and archive exist.
CREATE TABLE environments (
  tenant_id     text        NOT NULL REFERENCES tenants(id),
  id            text        PRIMARY KEY,            -- env_… prefixed
  name          text        NOT NULL,               -- 1–128 chars
  type          text        NOT NULL,               -- cloud | self_hosted (§6.2)
  image         text        NOT NULL,               -- OCI image ref
  resources     jsonb       NOT NULL,               -- {cpus, memoryMiB, diskMiB?}
  networking    jsonb       NOT NULL,               -- {mode:'unrestricted'} | {mode:'limited',allowedHosts:[]}
  packages      jsonb       NOT NULL DEFAULT '[]',
  mounts        jsonb       NOT NULL DEFAULT '[]',
  max_duration  integer,                              -- wall-clock seconds
  idle_timeout  integer,                              -- seconds before idle-stop (§10.3)
  status        text        NOT NULL DEFAULT 'active', -- active | archived | deleted
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_environments_tenant_id_name ON environments (tenant_id, name);
CREATE INDEX idx_environments_tenant_id ON environments (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS environments CASCADE;
