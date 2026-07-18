/**
 * Webhooks (WP-C3.4; console-spec §9.8, journey W13): register with an
 * event-type picker enumerated from the contracts {@link WebhookEventType}
 * enum, the `whsec_` signing secret shown EXACTLY once (DP-8 via
 * {@link SecretReveal}), a send-test button so an endpoint is verified before
 * it is trusted (delivery state renders inline), and auto-disabled endpoints
 * surfaced prominently with the re-enable path.
 *
 * RE-ENABLE PATH (§9.8): no enable/disable-in-place op exists on the API
 * (verified against the backend routes — auto-disable is server-side); the
 * only re-enable path today is delete + re-register, which mints a NEW
 * `whsec_` secret. The disabled banner says exactly that.
 */
import { createLazyRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { WebhookEventType, type Webhook } from "@pi-managed/contracts";

import { useDeleteWebhook, useRegisterWebhook, useTestWebhook, useWebhooks } from "../../api/webhooks.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
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
import { SecretReveal } from "../../ui/secret-reveal.js";
import styles from "./webhooks.module.css";

export const Route = createLazyRoute("/settings/webhooks")({
  component: WebhooksPage,
});

/** The typable confirmation token for a delete — the endpoint's host. */
function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Event types grouped by resource prefix (`session.*`, `job.*`, …). */
function groupedEventTypes(): Array<[string, WebhookEventType[]]> {
  const groups = new Map<string, WebhookEventType[]>();
  for (const type of WebhookEventType.options) {
    const prefix = type.slice(0, type.indexOf("."));
    const group = groups.get(prefix) ?? [];
    group.push(type);
    groups.set(prefix, group);
  }
  return [...groups.entries()];
}

/** W13: "send test before trusting it" — result renders where the button is.
 * A mutation like the rest (`POST /v1/webhooks/:id/test` — the backend
 * requires `write`), so it gates on {@link canWrite} with the reason shown. */
function TestCell({ webhook, writable }: { webhook: Webhook; writable: boolean }) {
  const test = useTestWebhook(webhook.id);
  const disabled = webhook.status === "disabled";
  const note = !writable
    ? "requires the write scope"
    : disabled
      ? "disabled endpoints receive no deliveries"
      : null;
  return (
    <span className={styles.testCell}>
      <Button
        onClick={() => test.mutate()}
        disabled={test.isPending || disabled || !writable}
        aria-describedby={note ? `test-disabled-${webhook.id}` : undefined}
      >
        {test.isPending ? "Sending…" : "Send test"}
      </Button>
      {note ? (
        <span id={`test-disabled-${webhook.id}`} className={styles.testNote}>
          {note}
        </span>
      ) : null}
      {test.isError ? <ErrorAlert label="test delivery" error={test.error} /> : null}
      {test.isSuccess ? (
        <span role="status" className={styles.testResult}>
          {test.data.delivered
            ? `delivered (HTTP ${test.data.responseCode ?? "—"})`
            : test.data.responseCode !== undefined
              ? `not delivered (HTTP ${test.data.responseCode})`
              : "not delivered (no response)"}
        </span>
      ) : null}
    </span>
  );
}

function WebhooksPage() {
  const { scopes } = useAuth();
  const writable = canWrite(scopes);
  const webhooks = useWebhooks();
  const { toast } = useToast();
  const remove = useDeleteWebhook();
  const [registering, setRegistering] = useState(false);
  const [deleting, setDeleting] = useState<Webhook | null>(null);

  const rows = webhooks.data?.data ?? [];
  const disabledRows = rows.filter((w) => w.status === "disabled");

  const columns: Array<Column<Webhook>> = [
    {
      key: "endpoint",
      header: "Endpoint",
      render: (w) => (
        <span className={styles.endpoint}>
          <span className={styles.url}>{w.url}</span>
          <CopyableId id={w.id} maxLength={24} />
        </span>
      ),
    },
    {
      key: "events",
      header: "Events",
      render: (w) => (
        <span className={styles.events}>{w.eventTypes.join(", ")}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (w) => (
        <span className={styles.statusCell}>
          <StatusChip status={w.status} />
          {w.disabledReason ? (
            <span className={styles.disabledReason}>{w.disabledReason}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "test",
      header: "Delivery",
      render: (w) => <TestCell webhook={w} writable={writable} />,
    },
    {
      key: "actions",
      header: "Actions",
      render: (w) => (
        <Button
          variant="destructive"
          onClick={() => setDeleting(w)}
          disabled={!writable}
          aria-describedby={writable ? undefined : "webhooks-scope-note"}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <section>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Webhooks</h2>
          <p className={styles.microcopy}>
            Webhook endpoints are notified of major state changes without
            polling. Deliveries are signed with the endpoint&apos;s{" "}
            <code>whsec_</code> secret — send a test before trusting one.
          </p>
        </div>
        <span className={styles.actions}>
          <Button
            variant="primary"
            onClick={() => setRegistering(true)}
            disabled={!writable}
            aria-describedby={writable ? undefined : "webhooks-scope-note"}
          >
            Register endpoint
          </Button>
          {!writable ? (
            <span id="webhooks-scope-note" className={styles.scopeNote}>
              requires the write scope
            </span>
          ) : null}
        </span>
      </header>

      {/* §9.8: auto-disabled state surfaced PROMINENTLY, with the re-enable
          path (delete + re-register — the only path the API offers). */}
      {disabledRows.length > 0 ? (
        <div role="alert" className={styles.disabledBanner}>
          <strong>
            {disabledRows.length === 1
              ? "One endpoint is auto-disabled"
              : `${disabledRows.length} endpoints are auto-disabled`}{" "}
            and receives no deliveries.
          </strong>{" "}
          <ul className={styles.disabledList}>
            {disabledRows.map((w) => (
              <li key={w.id}>
                <span className={styles.url}>{w.url}</span>
                {w.disabledReason ? <> — {w.disabledReason}</> : null}
              </li>
            ))}
          </ul>
          To re-enable, delete the endpoint and register it again — note that
          re-registering mints a <em>new</em> <code>whsec_</code> signing
          secret.
        </div>
      ) : null}

      {remove.isError ? (
        <ErrorAlert label="delete webhook" error={remove.error} />
      ) : null}

      {webhooks.isError ? (
        <ErrorAlert label="webhooks" error={webhooks.error} />
      ) : webhooks.isPending ? (
        <p role="status">Loading webhooks…</p>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(w) => w.id}
          caption="Webhooks"
          empty={
            <EmptyState
              title="No webhook endpoints yet"
              description="Register an HTTPS endpoint to be notified of session, job, and credential events — instead of polling the API."
              cliCommand={`curl -X POST $PI_BACKEND_URL/v1/webhooks -H "Authorization: Bearer $PI_API_KEY" -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{"url":"<https endpoint>","eventTypes":["session.status_idle"]}'`}
            >
              {writable ? (
                <Button variant="primary" onClick={() => setRegistering(true)}>
                  Register endpoint
                </Button>
              ) : null}
            </EmptyState>
          }
        />
      )}

      <RegisterWebhookDialog
        open={registering}
        onClose={() => setRegistering(false)}
      />

      <TypedConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete webhook endpoint"
        resourceName={deleting ? webhookHost(deleting.url) : ""}
        consequence={`Deliveries to ${deleting?.url ?? ""} stop immediately and its whsec_ signing secret is discarded. Deletion is permanent — registering the endpoint again mints a NEW signing secret.`}
        confirmLabel="Delete endpoint"
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () =>
              toast({ message: "Endpoint deleted", tone: "success" }),
          });
          setDeleting(null);
        }}
      />
    </section>
  );
}

/**
 * Register flow (§9.8): URL + event-type picker from the contracts enum; on
 * success the dialog swaps to the show-once `whsec_` reveal, and closing it
 * drops the mutation result — the secret's only home.
 */
function RegisterWebhookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const register = useRegisterWebhook();
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<WebhookEventType[]>([]);

  function toggle(type: WebhookEventType) {
    setChecked((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  function close() {
    // Dropping the mutation result forgets the signing secret (DP-8).
    register.reset();
    setUrl("");
    setChecked([]);
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || checked.length === 0) return;
    register.mutate({ url: url.trim(), eventTypes: checked });
  }

  return (
    <Dialog open={open} onClose={close} title="Register webhook endpoint">
      {register.isSuccess ? (
        <SecretReveal
          label="signing secret"
          secret={register.data.signingSecret}
          note="Verify every delivery's signature with this secret. Then send a test delivery from the list — trust the endpoint only after it acknowledges one."
          onConfirm={() => {
            toast({ message: "Endpoint registered", tone: "success" });
            close();
          }}
        />
      ) : (
        <form onSubmit={submit}>
          {/* No https:// placeholder literal — the phase-1 §3.4 gate scans
              dist/ for URL-shaped strings and allows only pinned inert ones. */}
          <Input
            label="Endpoint URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            hint="HTTPS on port 443, publicly resolvable — private addresses are rejected"
            autoComplete="off"
            spellCheck={false}
          />
          <fieldset className={styles.eventsFieldset}>
            <legend className={styles.eventsLegend}>Event types</legend>
            {groupedEventTypes().map(([prefix, types]) => (
              <div key={prefix} className={styles.eventGroup}>
                <p className={styles.eventGroupLabel}>{prefix}.*</p>
                {types.map((type) => (
                  <label key={type} className={styles.eventOption}>
                    <input
                      type="checkbox"
                      checked={checked.includes(type)}
                      onChange={() => toggle(type)}
                    />
                    <code className={styles.eventName}>{type}</code>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          {register.isError ? (
            <ErrorAlert label="register webhook" error={register.error} />
          ) : null}
          <div className={styles.dialogActions}>
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!url.trim() || checked.length === 0 || register.isPending}
              aria-describedby={
                !url.trim() || checked.length === 0
                  ? "register-webhook-disabled-note"
                  : undefined
              }
            >
              {register.isPending ? "Registering…" : "Register"}
            </Button>
          </div>
          {!url.trim() || checked.length === 0 ? (
            <p id="register-webhook-disabled-note" className={styles.scopeNote}>
              {!url.trim()
                ? "enter the endpoint URL"
                : "select at least one event type"}
            </p>
          ) : null}
        </form>
      )}
    </Dialog>
  );
}
