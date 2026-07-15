-- Up Migration

-- Memory versions (§3.6, §13.5). Versions belong to the store, not individual
-- memory entries. contentSha256 is the optimistic-concurrency precondition (§13.4).
CREATE TABLE memory_versions (
  tenant_id          text        NOT NULL REFERENCES tenants(id),
  store_id           text        NOT NULL REFERENCES memory_stores(id),
  id                 text        PRIMARY KEY,        -- memver_… prefixed
  memory_path        text,                           -- nullable — survives memory deletion (§13.5)
  content_sha256     text        NOT NULL,           -- optimistic concurrency (§13.4)
  content_object_key text,                            -- object-store key; null when redacted
  redacted           boolean     NOT NULL DEFAULT false, -- §13.6
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz                     -- 30-day retention; recent versions always kept (§13.5)
);

CREATE INDEX idx_memory_versions_store_created ON memory_versions (store_id, created_at);
CREATE INDEX idx_memory_versions_tenant_id ON memory_versions (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS memory_versions CASCADE;
