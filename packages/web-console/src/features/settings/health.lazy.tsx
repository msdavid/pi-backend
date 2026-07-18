/**
 * Backend health (WP-C3.6; console-spec §5.1) — the solo/team Settings
 * widget over the PUBLIC probes: `/healthz` (process liveness) and `/readyz`
 * (per-dependency readiness — db, object store, sandbox). Decided (console.md
 * §10.4 / plan decision 4): NO health widget in saas mode — the route stays
 * registered in every mode (deep links resolve, §1.4), but in saas the page
 * states the decision and probes nothing.
 *
 * Up/down chips are feature-local (`health.module.css` on the shared status
 * tokens): the ui-kit `StatusChip` vocabulary is the resource lifecycle
 * (active/running/…), and probe states are not lifecycle states.
 */
import { createLazyRoute } from "@tanstack/react-router";

import { useConsoleConfig } from "../../api/console.js";
import { useHealthz, useReadyz } from "../../api/health.js";
import type { ReadyzCheck } from "../../api/health.js";
import { Button } from "../../ui/button.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Table, type Column } from "../../ui/table.js";
import styles from "./health.module.css";

export const Route = createLazyRoute("/settings/health")({
  component: HealthPage,
});

function HealthPage() {
  const config = useConsoleConfig();
  if (config.data?.mode === "saas") {
    return (
      <section>
        <h2 className={styles.title}>Health</h2>
        <p className={styles.microcopy}>
          Backend health is operated by the service provider — there is no
          in-product health widget in saas mode.
        </p>
      </section>
    );
  }
  if (!config.data) {
    // Mode unknown (config still loading or failed): probing before knowing
    // the mode would leak the widget into saas — render nothing but state.
    return (
      <section>
        <h2 className={styles.title}>Health</h2>
        {config.isError ? (
          <ErrorAlert label="console config" error={config.error} />
        ) : (
          <p role="status">Loading…</p>
        )}
      </section>
    );
  }
  return <HealthWidget />;
}

/** Solo/team only — mounting this component is what starts the probes. */
function HealthWidget() {
  const healthz = useHealthz();
  const readyz = useReadyz();

  return (
    <section>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Health</h2>
          <p className={styles.microcopy}>
            Public probes served by the backend itself: <code>/healthz</code>{" "}
            is process liveness, <code>/readyz</code> aggregates dependency
            checks. Ops monitors can read the same endpoints unauthenticated.
          </p>
        </div>
        <Button
          onClick={() => {
            void healthz.refetch();
            void readyz.refetch();
          }}
          disabled={healthz.isRefetching || readyz.isRefetching}
        >
          Refresh
        </Button>
      </header>

      <h3 className={styles.probe}>
        <code>/healthz</code> — liveness
      </h3>
      {healthz.isError ? (
        <ErrorAlert label="liveness probe" error={healthz.error} />
      ) : healthz.isPending ? (
        <p role="status">Probing…</p>
      ) : (
        <p className={styles.line}>
          <StateChip up /> the backend process is serving requests
        </p>
      )}

      <h3 className={styles.probe}>
        <code>/readyz</code> — readiness
      </h3>
      {readyz.isError ? (
        <ErrorAlert label="readiness probe" error={readyz.error} />
      ) : readyz.isPending ? (
        <p role="status">Probing…</p>
      ) : (
        <>
          <p className={styles.line}>
            <StateChip up={readyz.data.ready} label={readyz.data.ready ? "ready" : "not_ready"} />
            {readyz.data.ready
              ? "every dependency reports up"
              : "at least one dependency reports down"}
          </p>
          <Table
            columns={CHECK_COLUMNS}
            rows={readyz.data.checks}
            rowKey={(check) => check.name}
            caption="Readiness checks"
            empty={<p>The backend registered no readiness checks.</p>}
          />
        </>
      )}
    </section>
  );
}

const CHECK_COLUMNS: Array<Column<ReadyzCheck>> = [
  {
    key: "name",
    header: "Dependency",
    render: (check) => <code className={styles.mono}>{check.name}</code>,
  },
  {
    key: "status",
    header: "Status",
    render: (check) => <StateChip up={check.status === "up"} />,
  },
  {
    key: "detail",
    header: "Detail",
    render: (check) => check.detail ?? "—",
  },
];

/** Probe-state chip: the API's token verbatim, toned via the status tokens. */
function StateChip({ up, label }: { up: boolean; label?: string }) {
  return (
    <span className={up ? styles.up : styles.down}>
      {label ?? (up ? "up" : "down")}
    </span>
  );
}
