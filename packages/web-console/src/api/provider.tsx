/**
 * API-client context (WP-C1.6) — the seam that lets UI tests hand the hooks a
 * fake {@link ConsoleApi} while production code runs on the real singleton.
 *
 * Default value is the app-wide {@link apiClient}, so the provider is optional
 * in production (`main.tsx` mounts nothing extra). Tests wrap trees in
 * `<ApiClientProvider api={fake}>`; the fake stands in for a COLLABORATOR of
 * the component under test (CONVENTIONS.md "Fakes at the seam") — the client
 * itself is contract-tested against the real backend in `__tests__/`.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { apiClient, type ConsoleApi } from "./client.js";

const ApiClientContext = createContext<ConsoleApi>(apiClient);

export function ApiClientProvider({
  api,
  children,
}: {
  api: ConsoleApi;
  children: ReactNode;
}) {
  return (
    <ApiClientContext.Provider value={api}>{children}</ApiClientContext.Provider>
  );
}

/** The client every `use*` hook talks through; `apiClient` unless overridden. */
export function useApiClient(): ConsoleApi {
  return useContext(ApiClientContext);
}
