#!/usr/bin/env node
/**
 * docs/db-schema.md generator (R3.4).
 *
 * Why this exists: the schema doc drifted from the migrations. `idempotency_keys`
 * (021) was added without a doc entry, so it never came under the design review the
 * doc exists to enable — and it shipped storing credential-bearing response bodies in
 * plaintext (fixed by 026). The doc gap and the vulnerability were the same event.
 * The doc is therefore no longer hand-maintained: it is *derived* from the migrations
 * and CI fails if the committed copy diverges (`pnpm db:schema:check`).
 *
 * How it works (introspection, not SQL parsing — parsing DDL by regex is brittle and
 * would silently miss ALTER TABLE migrations like 022/026/029/033):
 *   1. Start a throwaway Postgres container (podman, or docker if that is what exists).
 *   2. Apply every `packages/backend/migrations/*.sql` in filename order, using only the
 *      `-- Up Migration` half of each file (the node-pg-migrate file format).
 *   3. Introspect `information_schema` / `pg_catalog` for tables, columns, constraints
 *      and indexes, and render deterministic Markdown.
 *
 * The prose sections (principles, conventions, encryption strategy, what is NOT in
 * Postgres, retention, migration notes) are design commentary that cannot be derived
 * from DDL; they live in this file as constants and are emitted verbatim. Everything
 * under "3. Tables" is generated from the live database.
 *
 * Usage:
 *   node scripts/gen-db-schema.mjs           # rewrite docs/db-schema.md  (pnpm db:schema:gen)
 *   node scripts/gen-db-schema.mjs --check   # exit 1 if the committed doc is stale (pnpm db:schema:check)
 *
 * Requires: podman (or docker) and network access to pull postgres:16-alpine on first run.
 * No npm dependencies — psql runs *inside* the container, so the host needs no pg client.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "packages/backend/migrations");
const DOC_PATH = path.join(REPO_ROOT, "docs/db-schema.md");
const IMAGE = process.env.PG_IMAGE ?? "postgres:16-alpine";
const DB = "schemagen";

/** node-pg-migrate's bookkeeping table — not part of the application schema. */
const IGNORED_TABLES = new Set(["pgmigrations"]);

// ---------------------------------------------------------------------------
// Container plumbing
// ---------------------------------------------------------------------------

function containerCli() {
  if (process.env.CONTAINER_CLI) return process.env.CONTAINER_CLI;
  for (const cli of ["podman", "docker"]) {
    const probe = spawnSync(cli, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return cli;
  }
  throw new Error("neither podman nor docker found on PATH (set CONTAINER_CLI to override)");
}

function run(cli, args, input) {
  const res = spawnSync(cli, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`${cli} ${args.join(" ")} failed (exit ${res.status}):\n${res.stderr ?? ""}`);
  }
  return res.stdout;
}

/** Run SQL inside the container. `-Aqt` gives unaligned, quiet, tuples-only output. */
function psql(cli, name, sql, { db = DB, flags = [] } = {}) {
  return run(
    cli,
    ["exec", "-i", name, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-Aqt", ...flags, "-f", "-"],
    sql,
  );
}

function startPostgres(cli) {
  const name = `pi-schemagen-${randomBytes(4).toString("hex")}`;
  run(cli, [
    "run", "-d", "--rm", "--name", name,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_DB=postgres",
    IMAGE,
  ]);
  // pg_isready against the socket inside the container; the port is never published.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = spawnSync(cli, ["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"], { stdio: "ignore" });
    if (ready.status === 0) break;
    if (Date.now() > deadline) {
      spawnSync(cli, ["rm", "-f", name], { stdio: "ignore" });
      throw new Error(`postgres container did not become ready within 60s`);
    }
    execFileSync("sleep", ["0.5"]);
  }
  psql(cli, name, `CREATE DATABASE ${DB};`, { db: "postgres" });
  return name;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Extract the `up` half of a node-pg-migrate SQL migration: everything before the
 * `-- Down Migration` marker (the whole file if there is no marker).
 */
function upSql(file) {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  const match = /^\s*--\s*Down\s+Migration\s*$/im.exec(sql);
  return match ? sql.slice(0, match.index) : sql;
}

function applyMigrations(cli, name) {
  for (const file of migrationFiles()) {
    // `-1` wraps each migration in a transaction, matching node-pg-migrate.
    psql(cli, name, upSql(file), { flags: ["-1"] });
  }
}

/** Map table name -> migration files that mention it, for the "Defined in" provenance line. */
function migrationsByTable(tables) {
  const map = new Map(tables.map((t) => [t, []]));
  for (const file of migrationFiles()) {
    const sql = upSql(file);
    for (const table of tables) {
      if (new RegExp(`\\b${table}\\b`).test(sql)) map.get(table).push(file);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * One query, one JSON document, so the generated doc is a pure function of the
 * database state. `format_type` gives the canonical type (`character varying(64)` →
 * `varchar(64)`, `numeric(12,6)`, `bytea`, `timestamptz`, …).
 */
const INTROSPECT_SQL = `
SELECT coalesce(json_agg(t ORDER BY t.name), '[]'::json)::text FROM (
  SELECT
    c.relname AS name,
    (
      SELECT coalesce(json_agg(col ORDER BY col.ordinal), '[]'::json) FROM (
        SELECT
          a.attnum                                   AS ordinal,
          a.attname                                  AS name,
          format_type(a.atttypid, a.atttypmod)       AS type,
          a.attnotnull                               AS not_null,
          pg_get_expr(ad.adbin, ad.adrelid)          AS default_expr
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ) col
    ) AS columns,
    (
      SELECT coalesce(json_agg(con ORDER BY con.kind, con.name), '[]'::json) FROM (
        SELECT
          co.conname                  AS name,
          co.contype::text            AS kind,
          pg_get_constraintdef(co.oid) AS def
        FROM pg_constraint co
        WHERE co.conrelid = c.oid
      ) con
    ) AS constraints,
    (
      SELECT coalesce(json_agg(idx ORDER BY idx.name), '[]'::json) FROM (
        SELECT
          i.relname                        AS name,
          pg_get_indexdef(x.indexrelid)    AS def,
          x.indisunique                    AS is_unique,
          x.indisprimary                   AS is_primary
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = c.oid
      ) idx
    ) AS indexes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
) t;
`;

function introspect(cli, name) {
  const raw = psql(cli, name, INTROSPECT_SQL).trim();
  const tables = JSON.parse(raw);
  return tables.filter((t) => !IGNORED_TABLES.has(t.name));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HEADER = `# Database Schema

<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->
<!-- Source of truth: packages/backend/migrations/*.sql -->
<!-- Regenerate: pnpm db:schema:gen   Verify:  pnpm db:schema:check (runs in CI) -->

> **This document is generated from the migrations.** \`scripts/gen-db-schema.mjs\` applies
> every \`packages/backend/migrations/*.sql\` to a throwaway Postgres and introspects the
> result, so §3 below is the schema as it actually exists — not as someone remembered it.
> A hand-edit will be reverted by the next regeneration, and \`pnpm db:schema:check\` fails
> CI whenever a migration lands without the doc being regenerated.
>
> **Why it is generated.** The previous hand-maintained doc documented ~20 tables while the
> migrations created 28. \`idempotency_keys\` was added with no doc entry and therefore never
> got the schema review this doc exists to enable; it shipped persisting credential-bearing
> response bodies in plaintext (remediated by \`026_idempotency_no_store_bodies.sql\`). The
> documentation gap and the vulnerability were the same event.
>
> **Design intent** (the *why* behind the DDL) lives in \`spec.md\` §28 (Persistence & State),
> §27 (Multi-Tenancy), §6 (Resource Model), §12.4 (Vault constraints), §13.5 (Memory
> versions), §17.8 (Scheduler exactly-once), and §23.6 (Webhook retry queue). The prose
> sections here (§1, §2, §4–§7) are hand-written commentary
> maintained in \`scripts/gen-db-schema.mjs\`; only §3 is machine-derived.

## 1. Principles

1. **Postgres holds metadata only.** The JSONL session tree is the canonical conversation
   record and is **NOT** duplicated into Postgres (§28). Postgres holds a row per session
   for queryability (status, usage, config) — never the conversation itself.
2. **Every tenant-scoped table has \`tenant_id\`.** Row-level filtering on \`tenantId\` is
   mandatory on every query (§27.1). The \`tenantScoped(query)\` helper in code makes the
   filter impossible to omit (compile-time: first arg is \`TenantCtx\`; runtime: asserts the
   SQL references \`tenant_id\`).
3. **Cross-tenant access is impossible by construction** (§27.1).
4. **Forward-only migrations** via node-pg-migrate (SQL files, §3.2). No heavyweight ORM;
   queries stay explicit so tenant filtering is auditable.
5. **Secrets never land in a column that was not designed for them.** Ciphertext columns are
   \`bytea\` alongside \`key_id\`/\`nonce\`; response/​payload columns must never be used to
   persist a credential (see §4).

## 2. Conventions

| Convention | Choice | Rationale |
|---|---|---|
| \`tenant_id\` | \`text\` (prefixed, e.g. \`tnt_…\`) | Consistent with the wire ID format (§6.6); IDs are opaque strings throughout. |
| Resource IDs | \`text\` (prefixed per §6.6) | \`agent_\`, \`env_\`, \`sess_\`, \`vault_\`, \`mem_\`, \`memver_\`, \`skill_\`, \`file_\`, \`job_\`, \`wh_\`; ULID payload, server-generated. |
| Timestamps | \`timestamptz\` | RFC 3339 UTC. Every resource has \`created_at\`; mutable ones have \`updated_at\`. |
| \`metadata\` | \`jsonb\` | Max 4 KiB serialized, keys \`[a-zA-Z0-9_.-]+\`, scalar values only (app-enforced, §8). |
| Secrets | \`bytea\` (AES-256-GCM ciphertext + \`key_id\` + \`nonce\`) | Never plaintext; never logged (§12.4, §28). |
| API keys | argon2id hash only | Raw key never stored (§8). |
| Soft delete | \`status\` text column (\`active\`/\`archived\`/\`deleted\`) | Agents/vaults use archive (terminal, audit trail); environments/files have hard delete too (§6.2, §21). |
| Enums | \`text\` + app-level validation, not Postgres \`ENUM\` | Adding a value must not require a type migration. |

---

## 3. Tables

Generated by introspecting a database with all \`packages/backend/migrations/*.sql\` applied.
Column order is physical order; constraints and indexes are listed as Postgres reports them
(\`pg_get_constraintdef\` / \`pg_get_indexdef\`), so what you read here is exactly what the
database enforces.
`;

const FOOTER = `---

## 4. Encrypted-Column Strategy

\`vault_credentials.secret_enc\` is stored as **AES-256-GCM** ciphertext, alongside \`key_id\`
(which KMS/keyfile key was used) and \`nonce\` (the GCM nonce).

- **Key source:** KMS-managed key for SaaS; a key file for self-hosted (§28).
- **The key is required for restore** and must be backed up **separately** from the
  database (§28). Losing the key = losing all vault credentials.
- Encryption/decryption happens in the application layer (the \`SecretStore\` port, §25.3);
  Postgres never sees plaintext.
- On credential archive, \`secret_enc\`/\`key_id\`/\`nonce\` are set to null (secret purged,
  key freed, audit row retained — §12.7).
- API-key hashing uses **argon2id** (§8) — distinct from secret encryption; the raw key
  is never stored, only the hash.

### Columns that must never hold a credential

| Table.column | Rule |
|---|---|
| \`idempotency_keys.response_body\` | Nullable *by design*. Credential-issuing routes (API-key create, webhook create/rotate) record the idempotency key with a **NULL** body; a replay yields \`409 idempotency_conflict\` rather than re-serving a \`pmb_live_\`/\`whsec_\` secret (\`026_idempotency_no_store_bodies.sql\`, §25.1, §8). |
| \`webhook_deliveries.payload\` | Thin payload only — type + id + createdAt (§23.2). Never the resource body. |
| \`api_keys.key_hash\` | argon2id hash of the key, never the key. |
| \`webhooks.signing_secret_hash\` | Hash of the \`whsec_\` secret, never the secret. |

## 5. What is NOT in Postgres

Explicit list (§28):

| State | Store |
|---|---|
| Session JSONL tree (conversation) | Object store (\`<key from sessions.jsonl_object_key>\`) |
| Memory store contents | Object store (\`memory_stores.object_key_prefix\` + path) |
| Uploaded files | Object store (\`files.object_key\`) |
| Skill bundles | Object store (\`skill_versions.object_key\`) |
| Sandbox filesystems | microsandbox home (\`~/.microsandbox/\`) — ephemeral, checkpointed on idle |
| Raw vault secrets | Only ciphertext in Postgres; raw values in the microsandbox host-side store at runtime, purged on session end |

The backend does **not** duplicate the conversation into Postgres (§28).

### Object-store key layout

| Artifact | Key |
|---|---|
| Session JSONL log | \`tenants/<tenant_id>/sessions/<session_id>/log.jsonl\` |
| Memory store contents | \`tenants/<tenant_id>/memory/<store_id>/<memory_path>\` |
| Uploaded files | \`tenants/<tenant_id>/files/<file_id>\` |
| Skill bundles | \`tenants/<tenant_id>/skills/<skill_id>/v<version>/\` |
| Sandbox snapshots | \`tenants/<tenant_id>/snapshots/<session_id>/\` |

JSONL durability policy (§28): active sessions append to local disk (Pi-native); the backend
syncs to the object store on every \`session.status_idle\` transition and at a periodic
interval while running (default 30s). A host loss can lose at most the tail of the current
turn — never an idle session.

## 6. Retention & Purge

| Table | Column | Policy | Source |
|---|---|---|---|
| \`sessions\` | \`last_activity_at\` | 30-day checkpoint window (idle sandbox retained); 90-day JSONL retention (purge-on-request supported) | §6.3 |
| \`memory_versions\` | \`expires_at\` | 30-day retention; recent versions always kept regardless of age | §13.5 |
| \`idempotency_keys\` | \`expires_at\` | 24h replay window; rows swept after expiry | api-reference.md, §"Idempotency-Key" |
| \`job_runs\` | \`created_at\` | 90-day default (configurable) | this doc |
| \`webhook_deliveries\` | \`created_at\` | 90-day default (configurable) | this doc |
| \`usage_records\` | \`recorded_at\` | 365-day default (configurable per tier) | this doc |
| \`session_events\` | \`created_at\` | Follows the owning session's retention | this doc |
| \`rate_limit_buckets\` | \`window_start\` | Transient; rows expire with their window | this doc |

Per-tier overrides land in WP-5.5 (§29.6).

## 7. Migration Notes

- **Forward-only** SQL migrations via node-pg-migrate (§3.2). No down migrations in prod;
  the \`-- Down Migration\` half exists for the up/down clean test and local development.
- Each migration is a single \`.sql\` file in \`packages/backend/migrations/\`, numbered and
  applied in filename order.
- Adding a migration means **regenerating this doc** (\`pnpm db:schema:gen\`) and committing
  the result. \`pnpm db:schema:check\` fails CI otherwise — that check is the control that
  makes a new table impossible to land unreviewed.
- New tables must also be added to the \`TABLES\` list in
  \`packages/backend/src/infra/db/__tests__/migrations.test.ts\`, which is what makes the
  down-migration round-trip test able to catch a leaked table.
- FKs reference tenant-scoped PKs. The \`tenantScoped(query)\` helper makes omitting the
  \`tenant_id\` filter a compile-time error and a runtime assertion failure (§27.1).
`;

/** Markdown-escape a cell (pipes would break the table; backticks are fine inside code spans). */
function cell(text) {
  return String(text).replace(/\|/g, "\\|");
}

function renderDefault(expr) {
  if (expr === null || expr === undefined) return "";
  return `\`${cell(expr)}\``;
}

function renderTable(table, migrations) {
  const lines = [];
  lines.push(`### \`${table.name}\``);
  lines.push("");
  lines.push(`*Defined in: ${migrations.map((m) => `\`${m}\``).join(", ")}*`);
  lines.push("");
  lines.push("| Column | Type | Nullable | Default |");
  lines.push("|---|---|---|---|");
  for (const col of table.columns) {
    lines.push(
      `| \`${cell(col.name)}\` | \`${cell(col.type)}\` | ${col.not_null ? "NOT NULL" : "nullable"} | ${renderDefault(col.default_expr)} |`,
    );
  }
  lines.push("");

  const constraints = table.constraints.filter((c) => c.kind !== "t"); // skip trigger constraints
  if (constraints.length > 0) {
    lines.push("| Constraint | Definition |");
    lines.push("|---|---|");
    for (const c of constraints) {
      lines.push(`| \`${cell(c.name)}\` | \`${cell(c.def)}\` |`);
    }
    lines.push("");
  }

  // Indexes that merely back a PK/UNIQUE constraint are already shown above.
  const constraintIndexNames = new Set(table.constraints.map((c) => c.name));
  const indexes = table.indexes.filter((i) => !constraintIndexNames.has(i.name));
  if (indexes.length > 0) {
    lines.push("| Index | Definition |");
    lines.push("|---|---|");
    for (const i of indexes) {
      lines.push(`| \`${cell(i.name)}\` | \`${cell(i.def)}\` |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function render(tables) {
  const byTable = migrationsByTable(tables.map((t) => t.name));
  const toc = tables.map((t) => `- [\`${t.name}\`](#${t.name.replace(/_/g, "")})`).join("\n");
  const body = tables.map((t) => renderTable(t, byTable.get(t.name))).join("\n");
  return [
    HEADER,
    `**${tables.length} tables** (alphabetical):`,
    "",
    toc,
    "",
    body,
    FOOTER,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function generate() {
  const cli = containerCli();
  const name = startPostgres(cli);
  try {
    applyMigrations(cli, name);
    return render(introspect(cli, name));
  } finally {
    spawnSync(cli, ["rm", "-f", name], { stdio: "ignore" });
  }
}

function main() {
  const check = process.argv.includes("--check");
  const generated = generate();

  if (!check) {
    writeFileSync(DOC_PATH, generated);
    process.stdout.write(`wrote ${path.relative(REPO_ROOT, DOC_PATH)}\n`);
    return;
  }

  const committed = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : "";
  if (committed === generated) {
    process.stdout.write("docs/db-schema.md is up to date with packages/backend/migrations/\n");
    return;
  }

  // Show the first divergence rather than dumping the whole file.
  const a = committed.split("\n");
  const b = generated.split("\n");
  const at = a.findIndex((line, i) => line !== b[i]);
  process.stderr.write(
    [
      "docs/db-schema.md is out of date with packages/backend/migrations/.",
      "",
      `First divergence at line ${at + 1}:`,
      `  committed: ${a[at] ?? "<end of file>"}`,
      `  generated: ${b[at] ?? "<end of file>"}`,
      "",
      "A migration changed the schema without the doc being regenerated. Run:",
      "",
      "  pnpm db:schema:gen",
      "",
      "and commit docs/db-schema.md. Every new table must get a schema review — that is",
      "what this check exists to force (see the doc header).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

main();
