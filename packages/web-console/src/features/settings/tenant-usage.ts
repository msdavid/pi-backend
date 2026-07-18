/**
 * Pure display/export helpers for the tenant dashboard (WP-C3.6; console-spec
 * §9.9, journey W14). No client-side money math anywhere (§11.9): the CSV
 * emits the API's numbers verbatim, and every on-screen figure is either the
 * API's value or unit formatting of it.
 */
import type { TenantInfo, TenantUsageResponse } from "@pi-managed/contracts";

import { formatUsd } from "../sessions/format.js";

// --- CSV export (client-side; C§9.9 "CSV export") ---------------------------

/** RFC-4180-style field: quote when the value needs it. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The fetched series, row-for-row and digit-for-digit as the API returned it
 * (`String(n)` — no rounding, no summing, §11.9). The group column appears
 * iff the response is grouped; a `null` `userId` (spend without
 * `metadata.userId`) exports as an empty field.
 */
export function buildUsageCsv(usage: TenantUsageResponse): string {
  const groupColumn =
    usage.groupBy === "agent"
      ? (["agentId"] as const)
      : usage.groupBy === "user"
        ? (["userId"] as const)
        : ([] as const);
  const header = [
    "bucketStart",
    ...groupColumn,
    "inputTokens",
    "outputTokens",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "usdCost",
  ];
  const lines = [header.join(",")];
  for (const row of usage.data) {
    const group =
      usage.groupBy === "agent"
        ? [csvField(row.agentId ?? "")]
        : usage.groupBy === "user"
          ? [csvField(row.userId ?? "")]
          : [];
    lines.push(
      [
        csvField(row.bucketStart),
        ...group,
        String(row.inputTokens),
        String(row.outputTokens),
        String(row.cacheCreationInputTokens),
        String(row.cacheReadInputTokens),
        String(row.usdCost),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `tenant-usage-day.csv`, `tenant-usage-month-by-agent.csv`, … */
export function usageCsvFilename(usage: TenantUsageResponse): string {
  const suffix = usage.groupBy ? `-by-${usage.groupBy}` : "";
  return `tenant-usage-${usage.granularity}${suffix}.csv`;
}

// --- Bucket + unit formatting -----------------------------------------------

/** UTC bucket label: `2026-07-01` (day) / `2026-07` (month). */
export function formatBucket(
  bucketStart: string,
  granularity: TenantUsageResponse["granularity"],
): string {
  return granularity === "month" ? bucketStart.slice(0, 7) : bucketStart.slice(0, 10);
}

/** Bytes with a binary-unit suffix (`5.0 GiB`), integers below 1 KiB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit: string = units[0];
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

// --- Quota vs limit (C§9.9; shapes per contracts `TenantInfo`) ---------------

export interface QuotaRow {
  resource: string;
  used: string;
  limit: string;
  /** used/limit clamped to [0,1] — drives the bar width (display scaling). */
  ratio: number;
}

/**
 * The seven quota dimensions, paired per the backend's own mapping
 * (`domain/quota/enforce.ts`: `vaultSize` counts active credentials vs
 * `maxVaultCredentials`, `memorySize` counts active memory stores vs
 * `maxMemoryStores`, `fileStorage` is bytes vs `maxFileStorageBytes`).
 */
export function quotaRows(info: TenantInfo): QuotaRow[] {
  const usage = info.quotaUsage;
  const limits = info.quotaLimits;
  const count = (label: string, used: number, limit: number): QuotaRow => ({
    resource: label,
    used: String(used),
    limit: String(limit),
    ratio: clampRatio(used, limit),
  });
  return [
    count("Concurrent sessions", usage.concurrentSessions, limits.concurrentSessions),
    count("Concurrent sandboxes", usage.concurrentSandboxes, limits.concurrentSandboxes),
    count("Jobs", usage.jobs, limits.maxJobs),
    count("Vault credentials", usage.vaultSize, limits.maxVaultCredentials),
    count("Memory stores", usage.memorySize, limits.maxMemoryStores),
    {
      resource: "File storage",
      used: formatBytes(usage.fileStorage),
      limit: formatBytes(limits.maxFileStorageBytes),
      ratio: clampRatio(usage.fileStorage, limits.maxFileStorageBytes),
    },
    {
      resource: "Token spend (this month)",
      used: formatUsd(usage.tokenSpendUsd),
      limit: formatUsd(limits.monthlyTokenSpendUsd),
      ratio: clampRatio(usage.tokenSpendUsd, limits.monthlyTokenSpendUsd),
    },
  ];
}

function clampRatio(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(1, Math.max(0, used / limit));
}
