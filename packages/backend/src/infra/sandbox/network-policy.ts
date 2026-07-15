/**
 * Network-policy compiler (WP-1.3, §6.2, §10.5, Appendix A.1 #3).
 *
 * Maps the port-level {@link NetworkPolicy} (ports.ts) onto the microsandbox SDK's
 * `NetworkPolicy` object (the `policy/types.NetworkPolicy` plain-object shape accepted
 * by `SandboxBuilder.network((n) => n.policy(...))`).
 *
 * - `unrestricted` → `NetworkPolicy.publicOnly()` preset. Public internet egress is
 *   allowed; private/loopback/link-local/cloud-metadata/**host** are denied. This is
 *   **not** `NetworkPolicy.allowAll()` (spec is explicit: §10.5, ports.ts docstring).
 * - `limited` → a default-deny policy (egress + ingress) plus one egress-allow rule per
 *   entry in `allowedHosts`. Each host is compiled to a `Destination.domain(host)`
 *   allow-egress rule.
 *
 * **Spec wording note (§10.5):** ports.ts describes `limited` as "default-deny +
 * `allowHost()` rules per `allowedHosts`". The microsandbox SDK's `RuleBuilder.allowHost()`
 * is a no-argument convenience that allows the `host` destination *group* (the VM host
 * machine) — it does not take a hostname. `allowedHosts` in the port contract are egress
 * destination hostnames, so the faithful, functional mapping is one
 * `Rule.allowEgress(Destination.domain(host))` rule per host. This preserves the spec
 * intent (permit egress to each listed host, deny everything else) without changing the
 * port contract; flagged in the WP-1.3 report as a terminology reconciliation.
 */

import { Destination, NetworkPolicy, Rule } from "microsandbox";
import type { NetworkPolicy as MsbNetworkPolicy } from "microsandbox";
import type { NetworkPolicy as PortNetworkPolicy } from "../../domain/ports.js";

/**
 * Compile a port-level {@link PortNetworkPolicy} into a microsandbox SDK
 * {@link MsbNetworkPolicy} that can be handed to `SandboxBuilder.network()`.
 *
 * The returned object is a plain SDK `NetworkPolicy` value — no native builder call is
 * required, so this function is safe to unit-test without KVM or the msb runtime.
 */
export function compileNetworkPolicy(
  np: PortNetworkPolicy,
): MsbNetworkPolicy {
  if (np.mode === "unrestricted") {
    // publicOnly(): public internet allowed; private/loopback/link-local/metadata/host
    // denied. NOT allowAll().
    return NetworkPolicy.publicOnly();
  }
  // limited: default-deny both directions, then one egress-allow rule per host.
  return {
    defaultEgress: "deny",
    defaultIngress: "deny",
    rules: np.allowedHosts.map((host) =>
      Rule.allowEgress(Destination.domain(host)),
    ),
  };
}

/**
 * Whether `compileNetworkPolicy(unrestricted)` is the `publicOnly()` preset (not
 * `allowAll()`). Exposed for the upgrade-gating test suite (§30 item 13).
 */
export function unrestrictedIsPublicOnly(): boolean {
  const pub = NetworkPolicy.publicOnly();
  const all = NetworkPolicy.allowAll();
  return (
    pub.defaultEgress === "deny" &&
    all.defaultEgress === "allow" &&
    JSON.stringify(pub) !== JSON.stringify(all)
  );
}
