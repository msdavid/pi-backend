/**
 * Self-hosted worker surface of the environment detail (WP-C3.2;
 * console-spec §9.2, journey W12 / user-journeys T5):
 *
 *  - worker keys: list (worker keys are `api_keys` rows carrying the
 *    `self_hosted_worker:<envId>` scope marker — there is no dedicated list
 *    route, so this filters `GET /v1/api-keys`) + mint, with the raw key
 *    rendered EXACTLY once behind copy-and-confirm (DP-8) and the W12 rule
 *    repeated wherever keys appear;
 *  - live `work-stats` (depth, pending, oldest queued, workers polling),
 *    polled while the page is visible;
 *  - drain via `work-stop`: a clean stop first, `{force: true}` only as the
 *    explicit SECOND step behind a DP-7 typed confirmation.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { ApiKey, Environment } from "@pi-managed/contracts";

import { workerKeyScopeOf, useApiKeys } from "../../api/api-keys.js";
import {
  useMintWorkerKey,
  useStopWork,
  useWorkStats,
} from "../../api/environments.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { Dialog } from "../../ui/dialog.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Input } from "../../ui/input.js";
import { SecretReveal } from "../../ui/secret-reveal.js";
import { Table, type Column } from "../../ui/table.js";
import { TypedConfirmDialog } from "../../ui/typed-confirm-dialog.js";
import { useToast } from "../../ui/toast.js";
import { formatTimestamp } from "../sessions/format.js";
import {
  SELF_HOSTED_EXPLAINER,
  WORKER_CLI_COMMAND,
  WORKER_KEY_RULE,
} from "./environment-copy.js";
import formStyles from "./environments.module.css";
import styles from "./environment-detail.module.css";

export function SelfHostedPanel({
  env,
  writable,
}: {
  env: Environment;
  /** `write` scope (§6.2) — the backend guards these mutations method→scope. */
  writable: boolean;
}) {
  return (
    <section aria-label="Self-hosted execution" className={styles.panel}>
      <h2 className={styles.panelTitle}>Self-hosted execution</h2>
      <p className={styles.hint}>{SELF_HOSTED_EXPLAINER}</p>
      <WorkStatsPanel envId={env.id} />
      <WorkerKeysPanel env={env} writable={writable} />
      <DrainPanel env={env} writable={writable} />
    </section>
  );
}

// --- Work stats (live queue depth, §9.2) ------------------------------------

function WorkStatsPanel({ envId }: { envId: string }) {
  const stats = useWorkStats(envId);

  return (
    <section aria-label="Work queue" className={styles.subPanel}>
      <h3 className={styles.subTitle}>Work queue</h3>
      {stats.isError ? (
        <ErrorAlert label="work stats" error={stats.error} />
      ) : stats.isPending ? (
        <p role="status">Loading work stats…</p>
      ) : (
        <dl className={styles.statsRow}>
          <StatFact label="depth" value={String(stats.data.depth)} />
          <StatFact label="pending" value={String(stats.data.pending)} />
          <StatFact
            label="oldest queued"
            value={formatTimestamp(stats.data.oldestQueuedAt)}
          />
          <StatFact
            label="workers polling"
            value={String(stats.data.workersPolling)}
          />
        </dl>
      )}
      <p className={styles.hint}>
        Refreshes every 10 seconds while this page is open. A growing depth
        with zero workers polling means the workers are dead or unreachable.
      </p>
    </section>
  );
}

function StatFact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{value}</dd>
    </div>
  );
}

// --- Worker keys (list + show-once mint, W12) -------------------------------

const WORKER_KEY_COLUMNS: Array<Column<ApiKey>> = [
  { key: "name", header: "Name", render: (key) => key.name },
  {
    key: "id",
    header: "ID",
    render: (key) => <CopyableId id={key.id} maxLength={24} />,
  },
  {
    key: "created",
    header: "Created",
    render: (key) => formatTimestamp(key.createdAt),
  },
];

function WorkerKeysPanel({
  env,
  writable,
}: {
  env: Environment;
  writable: boolean;
}) {
  const keys = useApiKeys();
  const [minting, setMinting] = useState(false);
  const workerKeys =
    keys.data?.data.filter((key) => workerKeyScopeOf(key) === env.id) ?? [];

  return (
    <section aria-label="Worker keys" className={styles.subPanel}>
      <div className={styles.subHeader}>
        <h3 className={styles.subTitle}>Worker keys</h3>
        <span className={formStyles.action}>
          <Button
            variant="primary"
            onClick={() => setMinting(true)}
            disabled={!writable}
            aria-describedby={writable ? undefined : "mint-scope-note"}
          >
            Mint worker key
          </Button>
          {!writable ? (
            <span id="mint-scope-note" className={styles.scopeNote}>
              requires the write scope
            </span>
          ) : null}
        </span>
      </div>
      {/* W12: the page repeats the rule wherever keys appear. */}
      <p className={styles.hint}>{WORKER_KEY_RULE}</p>
      {keys.isError ? (
        <ErrorAlert label="worker keys" error={keys.error} />
      ) : keys.isPending ? (
        <p role="status">Loading worker keys…</p>
      ) : (
        <Table
          columns={WORKER_KEY_COLUMNS}
          rows={workerKeys}
          rowKey={(key) => key.id}
          caption="Worker keys"
          empty={
            <EmptyState
              title="No worker keys yet"
              description={`A worker key lets a worker claim this environment's queue and post results — nothing else. ${WORKER_KEY_RULE}`}
              cliCommand={WORKER_CLI_COMMAND}
            >
              {writable ? (
                <Button variant="primary" onClick={() => setMinting(true)}>
                  Mint worker key
                </Button>
              ) : null}
            </EmptyState>
          }
        />
      )}
      <MintWorkerKeyDialog
        env={env}
        open={minting}
        onClose={() => setMinting(false)}
      />
    </section>
  );
}

/**
 * Mint dialog. Two states: the name form, then the SHOW-ONCE panel (the
 * shared {@link SecretReveal}, gated on Copy) — the raw key exists only in
 * the mutation result and is dropped (reset) on any close, so it can never
 * render a second time (DP-8; copy-and-confirm, §9.2/T5).
 */
function MintWorkerKeyDialog({
  env,
  open,
  onClose,
}: {
  env: Environment;
  open: boolean;
  onClose: () => void;
}) {
  const mint = useMintWorkerKey(env.id);
  const [name, setName] = useState("");

  function close() {
    // Drop the one-time key from memory no matter how the dialog closes.
    mint.reset();
    setName("");
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    mint.mutate({ name: name.trim() });
  }

  return (
    <Dialog open={open} onClose={close} title="Mint worker key">
      {mint.isSuccess ? (
        <SecretReveal
          label="worker key"
          secret={mint.data.key}
          warning={
            <>
              Copy the key now — <strong>it is shown exactly once</strong> and
              cannot be retrieved again. {WORKER_KEY_RULE}
            </>
          }
          confirmVia="copy"
          confirmLabel="I've stored the key"
          lockedReason="copy the key first — it will not be shown again"
          onConfirm={close}
        >
          <p className={styles.hint}>
            Start a worker with it:{" "}
            <code className={styles.mono}>{WORKER_CLI_COMMAND}</code>
          </p>
        </SecretReveal>
      ) : (
        <form onSubmit={submit} className={formStyles.form}>
          <p className={styles.hint}>
            Scoped to this environment&apos;s work queue only.{" "}
            {WORKER_KEY_RULE}
          </p>
          <Input
            label="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            spellCheck={false}
            placeholder="worker-host-1"
          />
          {mint.isError ? (
            <ErrorAlert label="mint worker key" error={mint.error} />
          ) : null}
          <div className={formStyles.formActions}>
            <Button onClick={close}>Cancel</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={mint.isPending || name.trim() === ""}
            >
              {mint.isPending ? "Minting…" : "Mint"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// --- Drain (work-stop; force is the explicit second step) -------------------

function DrainPanel({
  env,
  writable,
}: {
  env: Environment;
  writable: boolean;
}) {
  const { toast } = useToast();
  const stop = useStopWork(env.id);
  const [sessionId, setSessionId] = useState("");
  // Sessions a clean stop was requested for in this visit — force unlocks
  // per-session only AFTER the clean attempt (§9.2: an explicit second step).
  const [cleanRequested, setCleanRequested] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [confirmingForce, setConfirmingForce] = useState(false);

  const target = sessionId.trim();
  const forceUnlocked = target !== "" && cleanRequested.has(target);

  function requestCleanStop(event: FormEvent) {
    event.preventDefault();
    stop.mutate(
      { sessionId: target },
      {
        onSuccess: () => {
          setCleanRequested((prev) => new Set(prev).add(target));
          toast({
            message: `Clean stop requested for ${target}`,
            tone: "success",
          });
        },
      },
    );
  }

  function confirmForce() {
    stop.mutate(
      { sessionId: target, force: true },
      {
        onSuccess: () => {
          setConfirmingForce(false);
          toast({ message: `Force stop requested for ${target}`, tone: "info" });
        },
      },
    );
  }

  return (
    <section aria-label="Drain work" className={styles.subPanel}>
      <h3 className={styles.subTitle}>Drain work</h3>
      <p className={styles.hint}>
        Ask the worker handling a session to stop. A clean stop lets it finish
        the current step and hand back; force interrupts immediately and is
        only offered after a clean stop was requested.
      </p>
      <form onSubmit={requestCleanStop} className={styles.drainForm}>
        <Input
          label="Session id"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          spellCheck={false}
          placeholder="sess_…"
          hint="The session whose queued or claimed work item should stop."
        />
        <div className={formStyles.formActions}>
          <Button
            type="submit"
            disabled={!writable || target === "" || stop.isPending}
            aria-describedby={writable ? undefined : "drain-scope-note"}
          >
            {stop.isPending ? "Requesting…" : "Request clean stop"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => setConfirmingForce(true)}
            disabled={!writable || !forceUnlocked || stop.isPending}
            aria-describedby={
              writable && !forceUnlocked ? "force-second-step-note" : undefined
            }
          >
            Force stop…
          </Button>
        </div>
        {!writable ? (
          <p id="drain-scope-note" className={styles.scopeNote}>
            requires the write scope
          </p>
        ) : !forceUnlocked ? (
          <p id="force-second-step-note" className={styles.scopeNote}>
            request a clean stop first — force is the second step
          </p>
        ) : null}
        {stop.isError ? (
          <ErrorAlert label="work stop" error={stop.error} />
        ) : null}
      </form>
      <TypedConfirmDialog
        open={confirmingForce}
        onClose={() => setConfirmingForce(false)}
        onConfirm={confirmForce}
        title="Force stop work"
        resourceName={env.name}
        consequence={`Force-stops the work item for ${target || "the session"} on ${env.name}: the worker interrupts mid-execution and the session ends without finishing cleanly.`}
        confirmLabel="Force stop"
      />
    </section>
  );
}
