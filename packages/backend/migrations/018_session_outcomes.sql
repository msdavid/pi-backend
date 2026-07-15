-- Up Migration

-- Session outcomes (§3.11, Phase 3 — stub now). One outcome at a time per
-- session (§16.5).
CREATE TABLE session_outcomes (
  tenant_id       text        NOT NULL REFERENCES tenants(id),
  session_id      text        NOT NULL REFERENCES sessions(id),
  id              text        PRIMARY KEY,
  description     text        NOT NULL,              -- §16.3
  rubric          jsonb       NOT NULL,             -- {type:'text',content} | {type:'file',fileId} (§16.3)
  max_iterations  integer     NOT NULL DEFAULT 3,    -- max 20 (§16.3)
  status          text        NOT NULL,             -- active | completed | interrupted
  result          text,                              -- satisfied|needs_revision|max_iterations_reached|failed|interrupted (§16.5)
  iteration       integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_outcomes_tenant_session ON session_outcomes (tenant_id, session_id);

-- Down Migration

DROP TABLE IF EXISTS session_outcomes CASCADE;
