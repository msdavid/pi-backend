/**
 * `/v1/tenant` family — fetchers + hooks (WP-C3-prep skeleton; the tenant
 * dashboard, console-spec §9.9 / journey W14, is WP-C3.6).
 *
 * Mirrors `contracts/src/tenant.ts` and api-reference §"Tenant / admin".
 * Reads only: tenant info (quota usage vs the plan's `quotaLimits`) and the
 * WP-C3.0 usage-over-time series (`GET /v1/tenant/usage` — UTC day/month
 * buckets, optional `groupBy` agent/user; NOT paginated, empty buckets
 * omitted). Cost observability is all-modes (§11.2); the console never
 * computes money client-side — it displays what the API reports (§11.9).
 *
 * API keys share the api-reference section but are their own console family
 * (`./api-keys.ts`); the saas billing/balance surfaces are phase 5.
 */

import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  TenantInfo,
  TenantUsageResponse,
  type TenantUsageGranularity,
  type TenantUsageGroupBy,
} from "@pi-managed/contracts";
import { apiClient, type ConsoleApi } from "./client.js";
import { tenantKeys } from "./keys.js";
import { useApiClient } from "./provider.js";
import { withQuery } from "./pagination.js";

/**
 * Query params for `GET /v1/tenant/usage` (contracts `TenantUsageParams`).
 * `from` inclusive / `to` exclusive, RFC 3339; defaults server-side (`to` =
 * now, `from` = −30 d for `day` / −365 d for `month`). Spans over 366 days /
 * 24 months are `422`.
 */
export interface TenantUsageFilters {
  granularity?: TenantUsageGranularity;
  from?: string;
  to?: string;
  groupBy?: TenantUsageGroupBy;
}

// --- Fetchers ---------------------------------------------------------------

/** `GET /v1/tenant` — tenant info + quota usage vs plan limits. */
export function getTenant(
  client: ConsoleApi = apiClient,
): Promise<TenantInfo> {
  return client.get("/v1/tenant", TenantInfo);
}

/** `GET /v1/tenant/usage` — time-bucketed usage + USD spend (WP-C3.0). */
export function getTenantUsage(
  params: TenantUsageFilters = {},
  client: ConsoleApi = apiClient,
): Promise<TenantUsageResponse> {
  return client.get(
    withQuery("/v1/tenant/usage", { ...params }),
    TenantUsageResponse,
  );
}

// --- Query options + hooks ----------------------------------------------------

export function tenantOptions(client: ConsoleApi = apiClient) {
  return queryOptions({
    queryKey: tenantKeys.info(),
    queryFn: () => getTenant(client),
  });
}

/** Tenant info + quota-vs-limit (C§9.9). */
export function useTenant() {
  return useQuery(tenantOptions(useApiClient()));
}

export function tenantUsageOptions(
  params: TenantUsageFilters = {},
  client: ConsoleApi = apiClient,
) {
  return queryOptions({
    queryKey: tenantKeys.usage(params),
    queryFn: () => getTenantUsage(params, client),
  });
}

/** Usage over time (C§9.9, §11.5): spend charts + breakdowns by agent /
 * `metadata.userId`. Each filter set is its own cache entry. */
export function useTenantUsage(params: TenantUsageFilters = {}) {
  return useQuery(tenantUsageOptions(params, useApiClient()));
}
