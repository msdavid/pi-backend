-- Up Migration

-- Commercialization ledger + tenant billing lifecycle (WP-C5.1, console spec
-- §11.1/§11.3). Prepaid, single-unit (dollars). The backend ledger — not any
-- payment engine — is the SOURCE OF TRUTH for balance (§11.3): balance is a
-- materialized column on `tenant_billing`, updated in the SAME transaction as
-- the ledger insert under a row lock, so concurrent credits/debits serialize
-- and can never race the balance negative or double-apply. Enforcement (§11.1)
-- reads only this local state; nothing in a request path calls a payment engine.
--
-- Unit: integer micro-dollars (`micros`), 1 USD = 1_000_000. Integers avoid
-- float rounding on money. Amounts are SIGNED — credits (grant/topup) positive,
-- debits negative — so balance = sum(amount_micros).

-- Per-tenant billing lifecycle + materialized balance + trial-verification state.
CREATE TABLE tenant_billing (
  tenant_id                text        PRIMARY KEY REFERENCES tenants(id),
  -- trial → active (on first verified grant), plus suspended (balance ≤ 0).
  -- NO past_due — prepaid cannot be past due (§11.1).
  lifecycle                text        NOT NULL DEFAULT 'trial'
    CHECK (lifecycle IN ('trial', 'active', 'suspended')),
  -- Materialized balance in micro-dollars; the ONLY read on the enforcement hot
  -- path (§11.1). Kept transactionally in step with `ledger_entries`.
  balance_micros           bigint      NOT NULL DEFAULT 0,
  -- Trial-verification (§11.1): the $5 grant is PENDING until the emailed token
  -- is verified. Only the token's SHA-256 hash is stored (a leaked row cannot be
  -- replayed as a verification link). Cleared once consumed.
  verification_token_hash  text,
  verification_expires_at  timestamptz,
  verified_at              timestamptz,
  -- The pending grant amount (micros) applied on verification; 0 once granted.
  pending_grant_micros     bigint      NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Append-only ledger. Every entry carries an idempotency key (§11.3): replaying
-- a key (e.g. a payment-webhook retry) hits the UNIQUE constraint and returns the
-- existing entry — it NEVER double-credits (THE money invariant). Idempotency is
-- scoped per tenant so one tenant's key can never collide with another's.
CREATE TABLE ledger_entries (
  id                    text        PRIMARY KEY,          -- led_<ULID>
  tenant_id             text        NOT NULL REFERENCES tenants(id),
  kind                  text        NOT NULL
    CHECK (kind IN ('grant', 'topup', 'debit', 'adjustment')),
  -- Signed micro-dollars; must be non-zero. Credits (grant/topup) are positive,
  -- debits negative; adjustment may be either sign.
  amount_micros         bigint      NOT NULL CHECK (amount_micros <> 0),
  CONSTRAINT ledger_amount_sign CHECK (
    (kind IN ('grant', 'topup') AND amount_micros > 0)
    OR (kind = 'debit' AND amount_micros < 0)
    OR (kind = 'adjustment')
  ),
  -- Running balance immediately after this entry (audit + O(1) history render).
  balance_after_micros  bigint      NOT NULL,
  idempotency_key       text        NOT NULL,
  source                text,                              -- 'trial' | 'stripe' | 'manual' | …
  metadata              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- History render + cursor pagination scan by (tenant, time).
CREATE INDEX idx_ledger_entries_tenant_created
  ON ledger_entries (tenant_id, created_at DESC, id DESC);

-- Row-level security backstop, matching migration 040 (SEC-10): permissive when
-- `app.current_tenant` is unset (the SYSTEM paths — credit-surface, verification
-- — deliberately do not set the GUC), pinned to the tenant whenever a
-- tenant-scoped query sets it (the console billing reads).
ALTER TABLE tenant_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_billing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_billing
  USING (app_tenant_visible(tenant_id))
  WITH CHECK (app_tenant_visible(tenant_id));

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_entries
  USING (app_tenant_visible(tenant_id))
  WITH CHECK (app_tenant_visible(tenant_id));

-- Down Migration

DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS tenant_billing CASCADE;
