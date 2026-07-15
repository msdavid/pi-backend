-- Up Migration

-- WP-1.9: add the missing `id` primary-key column to `vault_credentials`.
--
-- The original 008 migration created `vault_credentials` WITHOUT an `id`
-- column, but the contracts `Credential` resource (ids.ts `vcredId`) and
-- api-reference.md §"Vaults" both require a `vcred_…` id on every credential.
-- This additive, forward-only migration closes that gap: it adds the column,
-- backfills any existing rows with a deterministic, Crockford-valid id, and
-- establishes it as the primary key.
--
-- Backfill note: `upper(left(md5(vault_id || ':' || key), 26))` yields 26 chars
-- in [0-9A-F], which is a subset of the Crockford Base32 alphabet
-- [0-9A-HJKMNP-TV-Z] (no I/L/O/U in hex), so backfilled ids match the
-- `vcred_<ulid>` contract pattern. Fresh deployments have no rows here.

ALTER TABLE vault_credentials ADD COLUMN IF NOT EXISTS id text;

UPDATE vault_credentials
   SET id = 'vcred_' || upper(left(md5(vault_id || ':' || key), 26))
 WHERE id IS NULL;

ALTER TABLE vault_credentials ALTER COLUMN id SET NOT NULL;

ALTER TABLE vault_credentials
  DROP CONSTRAINT IF EXISTS vault_credentials_pkey;

ALTER TABLE vault_credentials
  ADD CONSTRAINT vault_credentials_pkey PRIMARY KEY (id);

-- Down Migration

ALTER TABLE vault_credentials DROP CONSTRAINT IF EXISTS vault_credentials_pkey;
ALTER TABLE vault_credentials DROP COLUMN IF EXISTS id;
