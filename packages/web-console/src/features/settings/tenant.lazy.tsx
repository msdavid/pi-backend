/**
 * Tenant dashboard (WP-C3.6; console-spec §9.9, journey W14). Cost
 * observability is all-modes (§11.2): quota-vs-limit from `GET /v1/tenant`,
 * spend over time from the WP-C3.0 `GET /v1/tenant/usage` series
 * (day/month granularity toggle), breakdowns by agent and by
 * `metadata.userId` (`groupBy` — the table's columns follow what the
 * RESPONSE reports, not the picker), and a client-side CSV export of the
 * fetched rows. The console computes no money (§11.9): buckets render/export
 * the API's numbers; the ui-kit Sparkline only scales them for trend (DP-14).
 */
import { createLazyRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type {
  TenantInfo,
  TenantUsageBucket,
  TenantUsageGranularity,
  TenantUsageGroupBy,
  TenantUsageResponse,
} from "@pi-managed/contracts";

import { useTenant, useTenantUsage } from "../../api/tenant.js";
import { Button } from "../../ui/button.js";
import { CopyableId } from "../../ui/copyable-id.js";
import { EmptyState } from "../../ui/empty-state.js";
import { ErrorAlert } from "../../ui/error-alert.js";
import { Select } from "../../ui/select.js";
import { Sparkline } from "../../ui/sparkline.js";
import { Table, type Column } from "../../ui/table.js";
import { formatTimestamp, formatUsd } from "../sessions/format.js";
import {
  buildUsageCsv,
  formatBucket,
  quotaRows,
  usageCsvFilename,
  type QuotaRow,
} from "./tenant-usage.js";
import styles from "./tenant.module.css";

export const Route = createLazyRoute("/settings/tenant")({
  component: TenantPage,
});

function TenantPage() {
  const tenant = useTenant();

  return (
    <section>
      {tenant.isError ? (
        <>
          <h2 className={styles.title}>Tenant</h2>
          <ErrorAlert label="tenant info" error={tenant.error} />
          <Button onClick={() => void tenant.refetch()}>Retry</Button>
        </>
      ) : tenant.isPending ? (
        <>
          <h2 className={styles.title}>Tenant</h2>
          <p role="status">Loading tenant…</p>
        </>
      ) : (
        <TenantFacts info={tenant.data} />
      )}
      <UsageSection />
    </section>
  );
}

// --- Tenant facts + quota vs limit (DP-1; C§9.9) -----------------------------

const QUOTA_COLUMNS: Array<Column<QuotaRow>> = [
  { key: "resource", header: "Resource", render: (row) => row.resource },
  { key: "used", header: "Used", render: (row) => row.used },
  { key: "limit", header: "Limit", render: (row) => row.limit },
  {
    key: "bar",
    header: "Utilization",
    render: (row) => (
      // Display scaling of the two figures already shown — decorative.
      <span className={styles.track} aria-hidden="true">
        <span
          className={styles.fill}
          style={{ width: `${Math.round(row.ratio * 100)}%` }}
        />
      </span>
    ),
  },
];

function TenantFacts({ info }: { info: TenantInfo }) {
  return (
    <>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>{info.name}</h2>
          <p className={styles.microcopy}>
            Usage and spend live here in every mode — self-hosters pay model
            providers real dollars too (W14).
          </p>
        </div>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Tenant</dt>
            <dd className={styles.factValue}>
              <CopyableId id={info.tenantId} maxLength={24} />
            </dd>
          </div>
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Quota plan</dt>
            <dd className={styles.factValue}>{info.quotaPlan}</dd>
          </div>
        </dl>
      </header>

      <h3 className={styles.section}>Quota vs limit</h3>
      <Table
        columns={QUOTA_COLUMNS}
        rows={quotaRows(info)}
        rowKey={(row) => row.resource}
        caption="Quota vs limit"
      />
    </>
  );
}

// --- Spend over time + breakdowns (C§9.9, §11.5) -----------------------------

function UsageSection() {
  const [granularity, setGranularity] = useState<TenantUsageGranularity>("day");
  const [groupBy, setGroupBy] = useState<TenantUsageGroupBy | "">("");
  const usage = useTenantUsage({
    granularity,
    ...(groupBy === "" ? {} : { groupBy }),
  });

  return (
    <>
      <h3 className={styles.section}>Spend over time</h3>
      <div className={styles.controls}>
        <Select
          label="Granularity"
          value={granularity}
          onChange={(e) =>
            setGranularity(e.target.value as TenantUsageGranularity)
          }
        >
          <option value="day">Daily (last 30 days)</option>
          <option value="month">Monthly (last 12 months)</option>
        </Select>
        <Select
          label="Break down by"
          hint="agent, or the session's metadata.userId"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as TenantUsageGroupBy | "")}
        >
          <option value="">Nothing (one series)</option>
          <option value="agent">Agent</option>
          <option value="user">User (metadata.userId)</option>
        </Select>
        <span className={styles.export}>
          <Button
            onClick={() => usage.data && downloadCsv(usage.data)}
            disabled={!usage.data || usage.data.data.length === 0}
            aria-describedby={
              usage.data && usage.data.data.length > 0
                ? undefined
                : "tenant-usage-csv-note"
            }
          >
            Download CSV
          </Button>
          {!usage.data || usage.data.data.length === 0 ? (
            <span id="tenant-usage-csv-note" className={styles.exportNote}>
              nothing to export — no rows in this range
            </span>
          ) : null}
        </span>
      </div>

      {usage.isError ? (
        <ErrorAlert label="tenant usage" error={usage.error} />
      ) : usage.isPending ? (
        <p role="status">Loading usage…</p>
      ) : (
        <UsageSeries usage={usage.data} />
      )}
    </>
  );
}

function UsageSeries({ usage }: { usage: TenantUsageResponse }) {
  return (
    <>
      <p className={styles.range}>
        {formatTimestamp(usage.from)} → {formatTimestamp(usage.to)} · UTC{" "}
        {usage.granularity} buckets, empty buckets omitted
        {usage.groupBy ? ` · grouped by ${usage.groupBy}` : ""}
      </p>
      {!usage.groupBy && usage.data.length >= 2 ? (
        <div className={styles.trend}>
          <Sparkline
            values={usage.data.map((row) => row.usdCost)}
            width={240}
            height={32}
            label={`Spend per ${usage.granularity} bucket, USD`}
          />
        </div>
      ) : null}
      <Table
        columns={usageColumns(usage)}
        rows={usage.data}
        rowKey={(row) =>
          `${row.bucketStart}:${row.agentId ?? ""}:${row.userId ?? "∅"}`
        }
        caption="Usage over time"
        empty={
          <EmptyState
            title="No spend in this range"
            description="Usage appears as sessions run; buckets with no usage are omitted from the series."
            cliCommand="/remote:start"
          />
        }
      />
    </>
  );
}

/** Columns follow the RESPONSE's `groupBy` — display what the API reports. */
function usageColumns(
  usage: TenantUsageResponse,
): Array<Column<TenantUsageBucket>> {
  const columns: Array<Column<TenantUsageBucket>> = [
    {
      key: "bucket",
      header: "Bucket (UTC)",
      render: (row) => (
        <code className={styles.mono}>
          {formatBucket(row.bucketStart, usage.granularity)}
        </code>
      ),
    },
  ];
  if (usage.groupBy === "agent") {
    columns.push({
      key: "agent",
      header: "Agent",
      render: (row) =>
        row.agentId ? (
          <CopyableId
            id={row.agentId}
            maxLength={22}
            link={(code) => (
              <Link
                to="/agents/$agentId"
                params={{ agentId: row.agentId! }}
                className={styles.idLink}
                onClick={(event) => event.stopPropagation()}
              >
                {code}
              </Link>
            )}
          />
        ) : (
          "—"
        ),
    });
  }
  if (usage.groupBy === "user") {
    columns.push({
      key: "user",
      header: "User",
      render: (row) =>
        // null = spend whose session carries no metadata.userId (§26.2).
        row.userId != null ? (
          <code className={styles.mono}>{row.userId}</code>
        ) : (
          <span className={styles.noUser}>(no userId)</span>
        ),
    });
  }
  columns.push(
    {
      key: "input",
      header: "Input tokens",
      render: (row) => String(row.inputTokens),
    },
    {
      key: "output",
      header: "Output tokens",
      render: (row) => String(row.outputTokens),
    },
    {
      key: "cost",
      header: "Cost",
      render: (row) => formatUsd(row.usdCost),
    },
  );
  return columns;
}

/** Client-side export — a Blob of the fetched rows, no server round-trip. */
function downloadCsv(usage: TenantUsageResponse): void {
  const blob = new Blob([buildUsageCsv(usage)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = usageCsvFilename(usage);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke off the click tick — some engines resolve the blob URL async.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
