-- Up Migration

-- Memory stores (§3.6). Contents live in the object store, not Postgres (§28).
CREATE TABLE memory_stores (
  tenant_id         text        NOT NULL REFERENCES tenants(id),
  id                text        PRIMARY KEY,        -- mem_… prefixed
  display_title     text        NOT NULL,           -- unique among stores in tenant
  instructions      text,                          -- ≤4096 chars (§13.2)
  access            text        NOT NULL DEFAULT 'read_write', -- read_write | read_only (§13.2)
  status            text        NOT NULL DEFAULT 'active',
  object_key_prefix text        NOT NULL,           -- object-store prefix for contents
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_memory_stores_tenant_title ON memory_stores (tenant_id, display_title);
CREATE INDEX idx_memory_stores_tenant_id ON memory_stores (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS memory_stores CASCADE;
