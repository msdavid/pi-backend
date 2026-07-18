/**
 * Test-only render helper: mounts the real app tree (Query provider → API
 * client provider → router with memory history) around an injected
 * {@link ConsoleApi} fake — the same composition `main.tsx` builds, with the
 * client swapped at its seam.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";

import type { ConsoleApi } from "../api/client.js";
import { ApiClientProvider } from "../api/provider.js";
import { createQueryClient } from "../app/query.js";
import { createConsoleRouter } from "../app/router.js";

export function renderConsole(
  api: ConsoleApi,
  path = "/console/",
): {
  router: ReturnType<typeof createConsoleRouter>;
  queryClient: QueryClient;
  view: RenderResult;
} {
  const router = createConsoleRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = createQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider api={api}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { router, queryClient, view };
}
