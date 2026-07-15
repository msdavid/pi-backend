-- Up Migration

-- Files (§3.7). Independent resources — deleting a session does NOT delete its
-- files (§21). Content lives in the object store at files.object_key.
CREATE TABLE files (
  tenant_id     text        NOT NULL REFERENCES tenants(id),
  id            text        PRIMARY KEY,            -- file_… prefixed
  name          text        NOT NULL,
  content_type  text,
  size_bytes    bigint      NOT NULL,
  object_key    text        NOT NULL,               -- object-store key
  session_id    text        REFERENCES sessions(id), -- nullable — set for session outputs (§21, §16.6)
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_files_tenant_session ON files (tenant_id, session_id);
CREATE INDEX idx_files_tenant_id ON files (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS files CASCADE;
