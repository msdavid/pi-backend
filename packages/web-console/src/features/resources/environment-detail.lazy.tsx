/**
 * Environment detail (WP-C3.2; console-spec §9.2, journeys W10/W12).
 *
 * `cloud`: image, resources, and the network policy with its one-line
 * explanation (DP-6 — `limited` vs `unrestricted`, language from
 * user-journeys T3). `self_hosted`: the worker surface (worker keys,
 * live work-stats, two-step drain) in `./environment-self-hosted.tsx`.
 *
 * Lifecycle (`write` per §6.2 — the backend guards environment mutations
 * with method→scope, `write`; §6.1 disabled-with-reason otherwise): edit
 * (PATCH — not versioned, the dialog says so), archive (terminal) and hard
 * delete, both behind DP-7 typed confirmations naming the real API
 * consequences.
 */
import { createLazyRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Environment } from "@pi-managed/contracts";

import {
  useArchiveEnvironment,
  useDeleteEnvironment,
  useEnvironment,
  useUpdateEnvironment,
} from "../../api/environments.js";
import { useAuth } from "../../app/auth.js";
import { canWrite } from "../../lib/scopes.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { Dialog } from "../../ui/dialog.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { StatusChip } from "../../ui/status-chip.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import { NETWORK_POLICY_EXPLANATIONS } from "./environment-copy.js";
import { SelfHostedPanel } from "./environment-self-hosted.js";
import formStyles from "./environments.module.css";
import styles from "./environment-detail.module.css";

export const Route = createLazyRoute("/resources/environments/$environmentId")({
  component: EnvironmentDetailPage,
});

const routeApi = getRouteApi("/resources/environments/$environmentId");

function EnvironmentDetailPage() {
  const { environmentId } = routeApi.useParams();
  const environment = useEnvironment(environmentId);

  if (environment.isError) {
    return (
      <section>
        <BackLink />
        <ErrorAlert label="environment" error={environment.error} />
        <Button onClick={() => void environment.refetch()}>Retry</Button>
      </section>
    );
  }
  if (environment.isPending) {
    return (
      <section>
        <BackLink />
        <p role="status">Loading environment…</p>
      </section>
    );
  }

  return <EnvironmentDetail env={environment.data} />;
}

type OpenDialog = "edit" | "archive" | "delete" | null;

function EnvironmentDetail({ env }: { env: Environment }) {
  const navigate = useNavigate();
  const { scopes } = useAuth();
  const { toast } = useToast();
  const writable = canWrite(scopes);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const archive = useArchiveEnvironment(env.id);
  const remove = useDeleteEnvironment(env.id);

  const archived = env.status === "archived";
  // §6.1: one shared reason for the disabled management actions.
  const scopeNote = writable ? undefined : "env-actions-scope-note";

  function confirmArchive() {
    archive.mutate(undefined, {
      onSuccess: () => {
        setDialog(null);
        toast({ message: `Environment ${env.name} archived`, tone: "success" });
      },
    });
  }

  function confirmDelete() {
    remove.mutate(undefined, {
      onSuccess: () => {
        setDialog(null);
        toast({ message: `Environment ${env.name} deleted`, tone: "success" });
        void navigate({ to: "/resources/environments" });
      },
    });
  }

  return (
    <section>
      <BackLink />
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{env.name}</h1>
          <span className={styles.actions}>
            <Button
              onClick={() => setDialog("edit")}
              disabled={!writable}
              aria-describedby={scopeNote}
            >
              Edit
            </Button>
            <Button
              variant="destructive"
              onClick={() => setDialog("archive")}
              disabled={!writable || archived || archive.isPending}
              aria-describedby={
                archived ? "env-archived-note" : scopeNote
              }
            >
              Archive
            </Button>
            <Button
              variant="destructive"
              onClick={() => setDialog("delete")}
              disabled={!writable || remove.isPending}
              aria-describedby={scopeNote}
            >
              Delete
            </Button>
            {!writable ? (
              <span id="env-actions-scope-note" className={styles.scopeNote}>
                requires the write scope
              </span>
            ) : null}
            {archived ? (
              <span id="env-archived-note" className={styles.scopeNote}>
                already archived — archival is terminal
              </span>
            ) : null}
          </span>
        </div>

        {archive.isError ? (
          <ErrorAlert label="archive environment" error={archive.error} />
        ) : null}
        {remove.isError ? (
          <ErrorAlert label="delete environment" error={remove.error} />
        ) : null}

        {/* DP-1: the decisive facts lead. */}
        <div className={styles.facts}>
          <span className={styles.fact}>
            <StatusChip status={env.status} />
          </span>
          <span className={styles.fact}>
            <span className={styles.factLabel}>type</span>
            {env.type}
          </span>
        </div>

        <dl className={styles.meta}>
          <MetaRow label="ID">
            <CopyableId id={env.id} maxLength={30} />
          </MetaRow>
          <MetaRow label="Created">{formatTimestamp(env.createdAt)}</MetaRow>
          <MetaRow label="Updated">{formatTimestamp(env.updatedAt)}</MetaRow>
        </dl>
      </header>

      {env.type === "cloud" ? (
        <CloudConfig env={env} />
      ) : (
        <SelfHostedPanel env={env} writable={writable} />
      )}

      <EditDialog
        env={env}
        open={dialog === "edit"}
        onClose={() => setDialog(null)}
      />
      <TypedConfirmDialog
        open={dialog === "archive"}
        onClose={() => setDialog(null)}
        onConfirm={confirmArchive}
        title="Archive environment"
        resourceName={env.name}
        consequence={`Archiving ${env.name} is terminal — there is no unarchive. New sessions and jobs can no longer reference it; running sessions continue.`}
        confirmLabel="Archive"
      />
      <TypedConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        onConfirm={confirmDelete}
        title="Delete environment"
        resourceName={env.name}
        consequence={`Permanently hard-deletes ${env.name}. Running sessions continue, but anything referencing it afterwards fails with 404 not_found. This cannot be undone.`}
        confirmLabel="Delete"
      />
    </section>
  );
}

// --- Cloud configuration (§9.2: image / resources / network policy) ---------

function CloudConfig({ env }: { env: Environment }) {
  const networking = env.networking;
  return (
    <section aria-label="Sandbox configuration" className={styles.panel}>
      <h2 className={styles.panelTitle}>Sandbox configuration</h2>
      <dl className={styles.meta}>
        <MetaRow label="Image">
          {env.image ? (
            <code className={styles.mono}>{env.image}</code>
          ) : (
            "provisioner default"
          )}
        </MetaRow>
        <MetaRow label="Resources">
          {env.resources
            ? [
                env.resources.cpus !== undefined
                  ? `${env.resources.cpus} CPUs`
                  : null,
                env.resources.memoryMiB !== undefined
                  ? `${env.resources.memoryMiB} MiB memory`
                  : null,
                env.resources.diskMiB !== undefined
                  ? `${env.resources.diskMiB} MiB disk`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "provisioner defaults"
            : "provisioner defaults"}
        </MetaRow>
        <MetaRow label="Network policy">
          {networking ? (
            <>
              <strong>{networking.mode}</strong> —{" "}
              {NETWORK_POLICY_EXPLANATIONS[networking.mode]}
              {networking.mode === "limited" ? (
                networking.allowedHosts.length > 0 ? (
                  <ul className={styles.hostList}>
                    {networking.allowedHosts.map((host) => (
                      <li key={host}>
                        <code className={styles.mono}>{host}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.hint}>
                    No hosts allowed — sessions have no network egress at all.
                  </p>
                )
              ) : null}
            </>
          ) : (
            "provisioner default"
          )}
        </MetaRow>
      </dl>
    </section>
  );
}

// --- Edit (PATCH — not versioned) -------------------------------------------

function EditDialog({
  env,
  open,
  onClose,
}: {
  env: Environment;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateEnvironment(env.id);
  const [name, setName] = useState(env.name);
  const [image, setImage] = useState(env.image ?? "");

  function close() {
    update.reset();
    setName(env.name);
    setImage(env.image ?? "");
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(
      {
        name: name.trim(),
        ...(env.type === "cloud" && image.trim() ? { image: image.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast({ message: "Environment updated", tone: "success" });
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Edit environment">
      <form onSubmit={submit} className={formStyles.form}>
        {/* DP-6: what a PATCH does here (api-reference §"Environments"). */}
        <p className={styles.hint}>
          Environments are not versioned — sessions created after this change
          use the new configuration.
        </p>
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          spellCheck={false}
        />
        {env.type === "cloud" ? (
          <Input
            label="Image"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            spellCheck={false}
            placeholder="ubuntu:22.04"
          />
        ) : null}
        {update.isError ? (
          <ErrorAlert label="update environment" error={update.error} />
        ) : null}
        <div className={formStyles.formActions}>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={update.isPending || name.trim() === ""}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function BackLink() {
  return (
    <p className={styles.back}>
      <Link to="/resources/environments" className={styles.backLink}>
        ← Environments
      </Link>
    </p>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.metaRow}>
      <dt className={styles.metaLabel}>{label}</dt>
      <dd className={styles.metaValue}>{children}</dd>
    </div>
  );
}
