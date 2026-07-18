/**
 * Route tree + router (code-based routing, no file-route plugin).
 *
 * Conventions for later WPs:
 *   - The backend serves the app under /console, so the router runs with
 *     `basepath: "/console"` (console-spec §3.1); route paths are written
 *     without the prefix.
 *   - Every route's component module is a sibling `*.lazy.tsx` attached with
 *     `.lazy()` — route-level code splitting keeps the entry bundle inside
 *     the §12.1 budget (enforced by scripts/check-budget.mjs).
 *   - Feature routes live in src/features/<family>/ mirroring
 *     backend/src/api and contracts/src 1:1 (docs/console.md §6).
 */
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";

import { ConsoleRoot } from "./shell.js";

const rootRoute = createRootRoute({ component: ConsoleRoot });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
}).lazy(() => import("../features/home/home.lazy.js").then((m) => m.Route));

// §7.1 top-level sections. The sidebar hides what the key's scopes cannot use
// (./nav.ts); the ROUTES stay registered for every scope — deep links must
// resolve (§1.4), and the backend is the enforcer for anything the page then
// calls (§6.4).
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
}).lazy(() =>
  import("../features/sessions/sessions.lazy.js").then((m) => m.Route),
);

// Session detail (WP-C1.7, §7.3): the deep-link target the CLI prints
// (`/console/sessions/<id>`, §1.4).
const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
}).lazy(() =>
  import("../features/sessions/session-detail.lazy.js").then((m) => m.Route),
);

// Signup (WP-C3-prep, §9.6/§5.3): registered in EVERY mode and gated at
// render (`signup.lazy.tsx` checks /console/config); rendered OUTSIDE the
// auth gate by `ConsoleRoot` (shell.tsx) — signup precedes any session.
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
}).lazy(() =>
  import("../features/onboarding/signup.lazy.js").then((m) => m.Route),
);

// Verify-email (WP-C5.4, §11.1): the trial-verification email links here with
// `?token=…`. Public (rendered outside the auth gate by `ConsoleRoot`), like
// /signup — the link may be opened before signing in.
const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/verify-email",
}).lazy(() =>
  import("../features/onboarding/verify-email.lazy.js").then((m) => m.Route),
);

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
}).lazy(() => import("../features/agents/agents.lazy.js").then((m) => m.Route));

// Agent detail (WP-C3.1, §9.1): flat sibling like the session detail.
const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId",
}).lazy(() =>
  import("../features/agents/agent-detail.lazy.js").then((m) => m.Route),
);

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
}).lazy(() => import("../features/jobs/jobs.lazy.js").then((m) => m.Route));

// Job detail (WP-C2.4, §9.4): definition + pause reason + runs history.
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$jobId",
}).lazy(() =>
  import("../features/jobs/job-detail.lazy.js").then((m) => m.Route),
);

// Resources is a SECTION LAYOUT (§7.1 contextual submenu, WP-C3-prep): the
// layout renders the persistent sub-navigation and an <Outlet/>; the family
// screens are its children. Memory stores are live (WP-C2.4, §9.5);
// environments (WP-C3.2), vaults (WP-C3.3), files/skills (WP-C3.6) are
// placeholders their WPs replace.
const resourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/resources",
}).lazy(() =>
  import("../features/resources/resources.lazy.js").then((m) => m.Route),
);

const resourcesIndexRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/",
}).lazy(() =>
  import("../features/resources/resources-index.lazy.js").then((m) => m.Route),
);

const environmentsRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/environments",
}).lazy(() =>
  import("../features/resources/environments.lazy.js").then((m) => m.Route),
);

const environmentDetailRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/environments/$environmentId",
}).lazy(() =>
  import("../features/resources/environment-detail.lazy.js").then(
    (m) => m.Route,
  ),
);

const vaultsRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/vaults",
}).lazy(() =>
  import("../features/resources/vaults.lazy.js").then((m) => m.Route),
);

const vaultDetailRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/vaults/$vaultId",
}).lazy(() =>
  import("../features/resources/vault-detail.lazy.js").then((m) => m.Route),
);

const memoryStoresRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/memory-stores",
}).lazy(() =>
  import("../features/resources/memory-stores.lazy.js").then((m) => m.Route),
);

const memoryStoreDetailRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/memory-stores/$storeId",
}).lazy(() =>
  import("../features/resources/memory-store-detail.lazy.js").then(
    (m) => m.Route,
  ),
);

const filesRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/files",
}).lazy(() =>
  import("../features/resources/files.lazy.js").then((m) => m.Route),
);

const skillsRoute = createRoute({
  getParentRoute: () => resourcesRoute,
  path: "/skills",
}).lazy(() =>
  import("../features/resources/skills.lazy.js").then((m) => m.Route),
);

// Settings is a SECTION LAYOUT too (§7.1): API keys · Webhooks · Tenant ·
// Billing[saas] · Health[solo/team] (mode rules live in settings.lazy.tsx).
// Routes stay registered in every mode (deep links resolve; each page states
// why it is empty out of mode).
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
}).lazy(() =>
  import("../features/settings/settings.lazy.js").then((m) => m.Route),
);

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
}).lazy(() =>
  import("../features/settings/settings-index.lazy.js").then((m) => m.Route),
);

const apiKeysRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/api-keys",
}).lazy(() =>
  import("../features/settings/api-keys.lazy.js").then((m) => m.Route),
);

const webhooksRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/webhooks",
}).lazy(() =>
  import("../features/settings/webhooks.lazy.js").then((m) => m.Route),
);

const tenantRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/tenant",
}).lazy(() =>
  import("../features/settings/tenant.lazy.js").then((m) => m.Route),
);

const billingRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/billing",
}).lazy(() =>
  import("../features/settings/billing.lazy.js").then((m) => m.Route),
);

const healthRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/health",
}).lazy(() =>
  import("../features/settings/health.lazy.js").then((m) => m.Route),
);

const routeTree = rootRoute.addChildren([
  homeRoute,
  signupRoute,
  verifyEmailRoute,
  sessionsRoute,
  sessionDetailRoute,
  agentsRoute,
  agentDetailRoute,
  jobsRoute,
  jobDetailRoute,
  resourcesRoute.addChildren([
    resourcesIndexRoute,
    environmentsRoute,
    environmentDetailRoute,
    vaultsRoute,
    vaultDetailRoute,
    memoryStoresRoute,
    memoryStoreDetailRoute,
    filesRoute,
    skillsRoute,
  ]),
  settingsRoute.addChildren([
    settingsIndexRoute,
    apiKeysRoute,
    webhooksRoute,
    tenantRoute,
    billingRoute,
    healthRoute,
  ]),
]);

/** Build the console router; tests pass a memory `history`. */
export function createConsoleRouter(opts: { history?: RouterHistory } = {}) {
  return createRouter({
    routeTree,
    basepath: "/console",
    history: opts.history,
  });
}

export const router = createConsoleRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
