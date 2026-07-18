/**
 * DP-6 microcopy for the environments surface (WP-C3.2; console-spec §9.2,
 * journey W12). One line per concept, language reused from
 * docs/user-journeys.md T3/T5 — shared between the create dialog and the
 * detail page so both teach the same words.
 */
import type { Networking } from "@pi-managed/contracts";

/** One-line explanation per network policy mode (§9.2: `limited` vs
 * `unrestricted`; T3: "`unrestricted` still can't reach the host or cloud
 * metadata; `limited` is default-deny plus named hosts"). */
export const NETWORK_POLICY_EXPLANATIONS = {
  unrestricted:
    "Outbound to the public internet only — the host, local network, and cloud metadata stay unreachable.",
  limited:
    "Default-deny egress — sessions can reach only the hosts listed explicitly.",
} as const satisfies Record<Networking["mode"], string>;

/** What an environment is (DP-6, list/create). */
export const ENVIRONMENT_EXPLAINER =
  "An environment is the execution shape sessions run in: a cloud sandbox (image, resources, network policy) or a self_hosted queue served by your own workers.";

/** What `self_hosted` means (T5). */
export const SELF_HOSTED_EXPLAINER =
  "Sessions on this environment queue as work items; workers on your own machines claim and run them.";

/** The W12 rule the self-hosted page must repeat wherever keys appear. */
export const WORKER_KEY_RULE =
  "A worker key is the only key that belongs on a worker host — never install your org API key on a worker.";

/** The shipped worker's invocation (user-journeys T5) — the DP-5 teach. */
export const WORKER_CLI_COMMAND =
  "pi-managed-worker --backend-url … --env-id … --worker-key …";
