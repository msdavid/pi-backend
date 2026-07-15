/**
 * Object-store readiness probe adapter (WP-P0.3).
 *
 * Builds a {@link ReadinessCheck} for the `objectStore` dependency by delegating to
 * the concrete impl's `probe()` when present. Unknown stores (e.g. the testkit fake,
 * which exposes no `probe()`) are assumed healthy so tests aren't falsely marked down.
 *
 * Kept in its own module (type-only imports) so `server.ts` can wire the probe
 * without pulling the S3 SDK into the server's import graph.
 */

import type { ReadinessCheck } from "../../api/health.js";
import type { ObjectStore } from "../../domain/ports.js";

/** A concrete object-store impl that exposes a non-mutating liveness probe. */
interface Probeable {
  probe(): Promise<{ status: "up" | "down"; detail?: string }>;
}

/** `true` when `store` exposes a `probe()` method (fs + s3 impls do). */
function isProbeable(store: ObjectStore): store is ObjectStore & Probeable {
  return (
    typeof (store as unknown as Partial<Probeable>).probe === "function"
  );
}

/**
 * Build a `/readyz` probe named `"objectStore"` for `store`. Delegates to
 * `store.probe()` when available; otherwise assumes `up`.
 */
export function createObjectStoreReadinessCheck(store: ObjectStore): ReadinessCheck {
  return {
    name: "objectStore",
    check: async () => {
      if (!isProbeable(store)) return { status: "up" };
      return store.probe();
    },
  };
}
