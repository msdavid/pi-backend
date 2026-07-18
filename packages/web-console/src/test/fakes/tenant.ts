/**
 * `/v1/tenant` family of the {@link FakeConsoleApi} (WP-C3-prep): tenant
 * info (quota usage vs limits) + the WP-C3.0 usage-over-time series. Tests
 * overwrite `tenantInfo` / `tenantUsage` wholesale to script a scenario.
 */
import type { TenantInfo, TenantUsageResponse } from "@pi-managed/contracts";

/** A full wire-shaped tenant info (contracts `TenantInfo`). */
export function makeTenantInfo(overrides: Partial<TenantInfo> = {}): TenantInfo {
  return {
    tenantId: "tnt_01TEST",
    name: "Acme Corp",
    quotaPlan: "default",
    quotaUsage: {
      concurrentSessions: 0,
      concurrentSandboxes: 0,
      jobs: 0,
      vaultSize: 0,
      memorySize: 0,
      fileStorage: 0,
      tokenSpendUsd: 0,
    },
    quotaLimits: {
      concurrentSessions: 10,
      concurrentSandboxes: 10,
      maxJobs: 100,
      maxVaultCredentials: 100,
      maxMemoryStores: 25,
      maxFileStorageBytes: 10_737_418_240,
      monthlyTokenSpendUsd: 200,
    },
    ...overrides,
  };
}

/** An empty usage series with the effective default `day` bounds echoed. */
export function makeTenantUsage(
  overrides: Partial<TenantUsageResponse> = {},
): TenantUsageResponse {
  return {
    granularity: "day",
    from: "2026-06-15T00:00:00.000Z",
    to: "2026-07-15T00:00:00.000Z",
    data: [],
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state the tenant family reads. */
export interface TenantState {
  tenantInfo: TenantInfo;
  tenantUsage: TenantUsageResponse;
}

/** `GET /v1/tenant` + `GET /v1/tenant/usage`; `undefined` if unmatched. */
export function tenantGet(
  state: TenantState,
  pathname: string,
): unknown | undefined {
  if (pathname === "/v1/tenant") return state.tenantInfo;
  if (pathname === "/v1/tenant/usage") return state.tenantUsage;
  return undefined;
}
