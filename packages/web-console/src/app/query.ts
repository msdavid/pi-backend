/**
 * TanStack Query client factory. One client per app (created in main.tsx);
 * tests create their own so cache state never leaks between tests.
 *
 * Query-key conventions live in `src/api/keys.ts` (WP-C1.5); SSE-driven
 * invalidation lands with WP-C2.1.
 */
import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // DP-9: failures surface immediately with their `code`/`requestId`
        // and an explicit Retry affordance next to them — TanStack's default
        // silent 3× retry would hide them for seconds instead. A query that
        // genuinely wants automatic retries opts in per-query.
        retry: false,
      },
    },
  });
}
