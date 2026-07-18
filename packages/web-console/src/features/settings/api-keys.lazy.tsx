/**
 * API keys (WP-C3.4; console-spec §9.7, journey W9): list with scope chips —
 * an over-broad key is visible at a glance — issue with scopes opt-UP from
 * `["read"]` (write/admin are explicit opt-ins), the raw key shown EXACTLY
 * once (DP-8 copy-and-confirm via {@link SecretReveal}), and revoke behind a
 * DP-7 typed confirmation naming the real consequence: revocation is
 * immediate, and console sessions signed in with the key die with it
 * (backend `domain/tenant/console-session.ts` fails resolution on
 * `revoked_at`).
 *
 * Issue/revoke are the §9.7 admin surface; the Settings nav item is already
 * admin-only (§6.1 hides it), so the disabled-with-reason state below serves
 * deep-linked non-admin keys.
 */
import { createLazyRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import type { ApiKey } from "@pi-managed/contracts";

import { useApiKeys, useIssueApiKey, useRevokeApiKey, workerKeyScopeOf } from "../../api/api-keys.js";
import { useAuth } from "../../app/auth.js";
import { isAdmin } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { Dialog } from "../../ui/dialog.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { StatusChip } from "../../ui/status-chip.js";
import { Table, type Column } from "../../ui/table.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { SecretReveal } from "../../ui/secret-reveal.js";
import styles from "./api-keys.module.css";

export const Route = createLazyRoute("/settings/api-keys")({
  component: ApiKeysPage,
});

/** The grantable org scopes, least → most privilege (api-reference §scopes).
 * Scope matching is EXACT (backend `middleware/scope.ts`): `write` does NOT
 * imply `read`, so `read` is the always-on floor here — a key without it
 * could mutate but never browse. */
const SCOPE_OPTIONS = [
  {
    scope: "read",
    hint: "the floor — browse everything: sessions, traces, usage (GET only)",
    locked: true,
  },
  {
    scope: "write",
    hint: "mutations — start sessions, send events, manage agents/environments/vaults/jobs/webhooks",
    locked: false,
  },
  {
    scope: "admin",
    hint: "wildcard — the only scope that manages API keys; prefer read/write",
    locked: false,
  },
] as const;

/** Scope chips (W9): `admin` is visually loud so over-broad keys stand out. */
function ScopeChips({ apiKey }: { apiKey: ApiKey }) {
  const workerEnv = workerKeyScopeOf(apiKey);
  if (workerEnv) {
    return (
      <span className={styles.chips}>
        <span className={styles.workerChip}>worker · {workerEnv}</span>
      </span>
    );
  }
  return (
    <span className={styles.chips}>
      {(apiKey.scopes ?? []).map((scope) => (
        <span
          key={scope}
          className={scope === "admin" ? styles.adminChip : styles.chip}
        >
          {scope}
        </span>
      ))}
    </span>
  );
}

function ApiKeysPage() {
  const { scopes } = useAuth();
  const admin = isAdmin(scopes);
  const keys = useApiKeys();
  const { toast } = useToast();
  const revoke = useRevokeApiKey();
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const rows = keys.data?.data ?? [];

  const columns: Array<Column<ApiKey>> = [
    { key: "name", header: "Name", render: (k) => k.name },
    {
      key: "id",
      header: "Id",
      render: (k) => <CopyableId id={k.id} maxLength={26} />,
    },
    { key: "scopes", header: "Scopes", render: (k) => <ScopeChips apiKey={k} /> },
    {
      key: "created",
      header: "Created",
      render: (k) => formatTimestamp(k.createdAt),
    },
    {
      key: "status",
      header: "Status",
      render: (k) => <StatusChip status={k.revokedAt ? "revoked" : "active"} />,
    },
    {
      key: "actions",
      header: "Actions",
      render: (k) =>
        k.revokedAt ? (
          <span className={styles.revokedAt}>
            revoked {formatTimestamp(k.revokedAt)}
          </span>
        ) : (
          <Button
            variant="destructive"
            onClick={() => setRevoking(k)}
            disabled={!admin}
            aria-describedby={admin ? undefined : "api-keys-scope-note"}
          >
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <section>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>API keys</h2>
          {/* DP-6: one line — and the DP-8 least-privilege nudge lives in the
              issue dialog, where scopes are chosen. */}
          <p className={styles.microcopy}>
            Keys authenticate the CLI, the Pi extension, and API clients.
            Scopes opt up from <code>read</code>; the raw key is shown once at
            issuance and stored hashed.
          </p>
        </div>
        <span className={styles.actions}>
          <Button
            variant="primary"
            onClick={() => setIssuing(true)}
            disabled={!admin}
            aria-describedby={admin ? undefined : "api-keys-scope-note"}
          >
            Issue key
          </Button>
          {!admin ? (
            <span id="api-keys-scope-note" className={styles.scopeNote}>
              requires the admin scope
            </span>
          ) : null}
        </span>
      </header>

      {revoke.isError ? (
        <ErrorAlert label="revoke key" error={revoke.error} />
      ) : null}

      {keys.isError ? (
        <ErrorAlert label="API keys" error={keys.error} />
      ) : keys.isPending ? (
        <p role="status">Loading API keys…</p>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(k) => k.id}
          caption="API keys"
          empty={
            <EmptyState
              title="No API keys yet"
              description="Issue purpose-bound keys: read for dashboards and CI reporting, read+write for coders. Keep admin keys offline."
              cliCommand={`curl -X POST $PI_BACKEND_URL/v1/api-keys -H "Authorization: Bearer $PI_ADMIN_KEY" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{"name":"ci-reporter","scopes":["read"]}'`}
            >
              {admin ? (
                <Button variant="primary" onClick={() => setIssuing(true)}>
                  Issue key
                </Button>
              ) : null}
            </EmptyState>
          }
        />
      )}

      <IssueKeyDialog open={issuing} onClose={() => setIssuing(false)} />

      <TypedConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke API key"
        resourceName={revoking?.name ?? ""}
        consequence={`Revoking "${revoking?.name ?? ""}" immediately cuts off everything authenticating with it — CLI, extension, API clients — and any console sessions signed in with this key are signed out. Revocation is permanent; issue a replacement key first if anything still depends on it.`}
        confirmLabel="Revoke key"
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () =>
              toast({ message: "Key revoked", tone: "success" }),
          });
          setRevoking(null);
        }}
      />
    </section>
  );
}

/**
 * Issue flow (§9.7): scopes opt UP from `["read"]` — read is the always-on
 * floor (checked + locked; backend scope matching is exact, so dropping it
 * would issue a key that can mutate but never browse), write/admin start
 * unchecked. On success the dialog swaps to the show-once reveal; closing
 * it drops the mutation result, the raw key's only home.
 */
function IssueKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const issue = useIssueApiKey();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<string[]>(["read"]);

  function toggle(scope: string) {
    // `read` is the floor (§9.7) — it can never be unchecked.
    if (scope === "read") return;
    setChecked((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function close() {
    // Dropping the mutation result forgets the raw key (DP-8).
    issue.reset();
    setName("");
    setChecked(["read"]);
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || checked.length === 0) return;
    issue.mutate({ name: name.trim(), scopes: checked });
  }

  return (
    <Dialog open={open} onClose={close} title="Issue API key">
      {issue.isSuccess ? (
        <SecretReveal
          label="API key"
          secret={issue.data.key}
          note={`Use it as the Authorization bearer for "${issue.data.name}". It is stored hashed server-side and can never be retrieved again — only revoked.`}
          onConfirm={() => {
            toast({ message: `Key "${issue.data.name}" issued`, tone: "success" });
            close();
          }}
        />
      ) : (
        <form onSubmit={submit}>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="What will use this key, e.g. ci-reporter"
            autoComplete="off"
            spellCheck={false}
          />
          <fieldset className={styles.scopesFieldset}>
            <legend className={styles.scopesLegend}>Scopes</legend>
            {/* DP-8 nudge: least privilege is the default, not a lecture. */}
            <p className={styles.scopesHint}>
              Every key starts from read (the floor); opt up only to what the
              consumer needs.
            </p>
            {SCOPE_OPTIONS.map(({ scope, hint, locked }) => (
              <div key={scope}>
                <label className={styles.scopeOption}>
                  <input
                    type="checkbox"
                    checked={checked.includes(scope)}
                    onChange={() => toggle(scope)}
                    disabled={locked}
                    aria-describedby={`scope-hint-${scope}`}
                  />
                  <code className={styles.scopeName}>{scope}</code>
                </label>
                <p id={`scope-hint-${scope}`} className={styles.scopeHint}>
                  {hint}
                </p>
              </div>
            ))}
          </fieldset>
          {issue.isError ? (
            <ErrorAlert label="issue key" error={issue.error} />
          ) : null}
          <div className={styles.dialogActions}>
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim() || checked.length === 0 || issue.isPending}
              aria-describedby={
                !name.trim() || checked.length === 0
                  ? "issue-key-disabled-note"
                  : undefined
              }
            >
              {issue.isPending ? "Issuing…" : "Issue key"}
            </Button>
          </div>
          {!name.trim() || checked.length === 0 ? (
            <p id="issue-key-disabled-note" className={styles.scopeNote}>
              {!name.trim()
                ? "name the key to issue it"
                : "select at least one scope"}
            </p>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
