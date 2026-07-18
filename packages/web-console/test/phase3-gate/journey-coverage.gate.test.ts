// @vitest-environment node
/**
 * Phase-3 gate — the plan's acceptance criterion for WP-C3.8: every
 * tenant-admin journey W8–W16 (except W15, phase 5) is achievable in the
 * console without curl.
 *
 * The human-readable coverage table lives in `./README.md`; this file is the
 * machine half that keeps the table's POINTERS honest: every claimed
 * covering test is asserted to still exist — file present, `it(...)` title
 * verbatim — so a renamed or deleted test breaks the gate instead of
 * silently rotting the journey claim. Steps WITHOUT automated coverage are
 * declared as explicit gaps in the README (nothing here pretends otherwise).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pkgRoot } from "../phase1-gate/helpers.js";

interface Pointer {
  /** Package-relative test file. */
  file: string;
  /** Verbatim `it(...)` titles claimed to cover the step. */
  tests: string[];
}

/** journey → the covering tests the README table cites. */
const COVERAGE: Record<string, Pointer[]> = {
  "W8 — onboard and first minute (saas)": [
    {
      file: "src/features/onboarding/signup.test.tsx",
      tests: [
        "renders the signup form signed-out in saas mode with onboarding enabled",
        "confirming signs in via the real session flow and lands on the checklist; the key is gone (§9.6)",
        "marks steps done as the real APIs report progress",
      ],
    },
    {
      file: "src/api/__tests__/onboarding.contract.test.ts",
      tests: [
        "public signup creates the tenant and issues the admin key once (§9.6)",
        "first-run progress flips as the real W8 steps complete (DP-12)",
      ],
    },
    {
      file: "src/features/home/home.test.tsx",
      tests: ["links the incomplete checklist from Home (saas + onboarding)"],
    },
    {
      // W8 step 3: install instructions reprinted in Settings any time.
      file: "src/features/settings/settings-index.test.tsx",
      tests: [
        "reprints the install instructions for admin in saas mode",
        "reprints the install instructions for admin in solo mode",
        "reprints the install instructions for admin in team mode",
      ],
    },
  ],
  "W9 — issue keys with least privilege": [
    {
      file: "src/features/settings/api-keys.test.tsx",
      tests: [
        "scopes opt UP from [read]: read pre-checked, write/admin unchecked",
        "issues with the opted-up scopes, reveals the key exactly once, and forgets it after copy-and-confirm (DP-8 DOM-absence)",
        "typed confirmation names the real consequences — console sessions die with the key",
        "renders scope chips per key — the over-broad admin key and the worker binding are visible at a glance",
      ],
    },
    {
      file: "src/api/__tests__/settings-mutations.contract.test.ts",
      tests: [
        "issue → authenticate → revoke → 401: the raw key exists only in the create response and dies with revocation",
      ],
    },
  ],
  "W10 — define agents and environments": [
    {
      file: "src/features/agents/agents.test.tsx",
      tests: [
        "admin: create dialog submits the AgentCreate body and lands on the new detail",
      ],
    },
    {
      file: "src/features/agents/agent-detail.test.tsx",
      tests: [
        "edit says plainly that PATCH creates version n+1 and running sessions keep theirs (§9.1)",
        "version history is browsable and each version's config viewable",
        "archive: DP-7 dialog names the real consequence — the count of scheduled jobs auto-archived",
      ],
    },
    {
      file: "src/features/resources/environments.test.tsx",
      tests: [
        "creates a cloud environment and navigates to its detail",
        "limited network policy explains itself (DP-6) and sends allowedHosts",
      ],
    },
    {
      file: "src/features/resources/environment-detail.test.tsx",
      tests: ["explains `unrestricted` in one line (DP-6)"],
    },
    {
      file: "src/api/__tests__/agents-lifecycle.contract.test.ts",
      tests: [
        "create → PATCH → archive round-trip with the version bump the UI narrates",
      ],
    },
  ],
  "W11 — register credentials": [
    {
      file: "src/features/resources/vaults.test.tsx",
      tests: [
        "creates a vault and lands on its detail page",
        "takes the secret as a password field and never echoes it after submit",
        "explains fail-closed and ~60 s rotation propagation (DP-6)",
        "validates a credential live and renders the outcome (§12.5)",
      ],
    },
    {
      file: "src/api/__tests__/vaults.contract.test.ts",
      tests: [
        "adds one credential per category; records come back without secrets",
        "static_bearer probing a live endpoint (the harness /healthz) → valid",
      ],
    },
  ],
  "W12 — operate self-hosted execution": [
    {
      file: "src/features/resources/environment-self-hosted.test.tsx",
      tests: [
        "mints show-once: copy-and-confirm, and the key NEVER renders again",
        "renders depth, pending, oldest queued, and workers polling",
        "clean stop first; force unlocks only after, behind a typed confirmation",
      ],
    },
    {
      file: "src/api/__tests__/environments.contract.test.ts",
      tests: [
        "mints a worker key: shown-once shape, and the LIST record carries only the scope marker",
        "work-stats reflects a seeded queue; work-stop drains clean → force",
      ],
    },
  ],
  "W13 — wire notifications": [
    {
      file: "src/features/settings/webhooks.test.tsx",
      tests: [
        "enumerates every contracts event type in the picker",
        "registers, reveals the whsec_ secret exactly once, and forgets it after copy-and-confirm (DP-8 DOM-absence)",
        "reports an acknowledged delivery inline",
        "surfaces an auto-disabled endpoint prominently, with the delete + re-register path (§9.8)",
      ],
    },
    {
      file: "src/api/__tests__/settings-mutations.contract.test.ts",
      tests: [
        "register → whsec_ once → test-delivery reports honest state → delete removes it",
      ],
    },
  ],
  "W14 — watch usage and spend": [
    {
      file: "src/features/settings/tenant.test.tsx",
      tests: [
        "pairs every usage figure with its plan ceiling (backend quota mapping)",
        "renders the series and refetches on the granularity toggle",
        "groupBy=agent: the picker sends the param; agent ids link to the detail route",
        "groupBy=user: renders userIds and labels the null (no metadata.userId) rows",
        "downloads the fetched rows verbatim as CSV — no rounding, no totals",
      ],
    },
    {
      file: "src/api/__tests__/tenant-files-skills.contract.test.ts",
      tests: [
        "groupBy=agent splits buckets by agentId (the console's breakdown)",
        "groupBy=user attributes by metadata.userId, null for unattributed",
      ],
    },
  ],
  "W16 — govern tool execution": [
    {
      file: "src/features/agents/agent-detail.test.tsx",
      tests: [
        "renders the definition readably: model, prompt, per-tool permission policies with microcopy",
      ],
    },
    {
      // The session trace doubles as the audit log (persisted, replayable).
      file: "src/features/sessions/trace-tab.test.tsx",
      tests: [
        "opens the stream for a non-terminal session and appends streamed entries",
      ],
    },
  ],
};

describe("W8–W16 (except W15) — the README coverage pointers are live", () => {
  for (const [journey, pointers] of Object.entries(COVERAGE)) {
    describe(journey, () => {
      for (const pointer of pointers) {
        it(`${pointer.file} still carries its cited tests`, () => {
          const path = join(pkgRoot, pointer.file);
          expect(existsSync(path), `missing file: ${pointer.file}`).toBe(true);
          const source = readFileSync(path, "utf8");
          for (const title of pointer.tests) {
            expect(
              source.includes(`"${title}"`),
              `${pointer.file}: cited test not found: "${title}"`,
            ).toBe(true);
          }
        });
      }
    });
  }

  it("W15 is deliberately absent (phase 5 — §11 billing)", () => {
    expect(Object.keys(COVERAGE).some((j) => j.startsWith("W15"))).toBe(false);
  });
});
