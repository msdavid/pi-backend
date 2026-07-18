/**
 * Test-only helper for the src/ui suites. Importing it:
 *
 * - registers the vitest-axe matcher (`toHaveNoViolations`) on vitest's
 *   `expect` and re-exports `axe` (console-spec §12.2: axe-core clean on
 *   every component). vitest-axe 0.1.0 ships its own augmentation for the
 *   pre-1.0 `Vi` namespace only, so the module augmentation for today's
 *   vitest lives here;
 * - registers Testing Library's `cleanup` after each test — RTL only
 *   auto-cleans when the runner exposes a global `afterEach`, and this
 *   repo runs vitest without `globals`.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import * as matchers from "vitest-axe/matchers";
import type { AxeMatchers } from "vitest-axe/matchers";

expect.extend(matchers);
afterEach(cleanup);

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  interface Matchers<T = any> extends AxeMatchers {}
}

export { axe } from "vitest-axe";
