/**
 * Placement router (WP-4.3, §7.2, §4.2).
 *
 * `chooseHost` decides which healthy host runs a new microVM. Strategy: filter by
 * health + capacity fit, then pick the **least-loaded** host (fewest current
 * placements, ties broken by most free capacity). microsandbox has no multi-host
 * scheduler — the backend owns this routing (§7.2).
 *
 * See `docs/multi-host-design.md` §4.
 */

import type { ProvisionSpec } from "../../domain/ports.js";
import type { HostLoad, SandboxHost } from "./types.js";

/** Thrown when no healthy host can fit the provision spec. */
export class NoHostAvailableError extends Error {
  constructor(public readonly required: { cpus: number; memoryMiB: number }) {
    super(
      `No healthy host can fit the provision spec ` +
        `(required cpus=${required.cpus}, memoryMiB=${required.memoryMiB})`,
    );
    this.name = "NoHostAvailableError";
  }
}

/** A host scored for least-loaded selection: placement count + remaining free CPU. */
export interface ScoredHost {
  host: SandboxHost;
  /** Number of microVMs currently placed on this host. */
  placements: number;
  /** Free CPU cores after subtracting the host's live placements (ROB-17). */
  freeCpus: number;
}

/**
 * Choose the least-loaded host with enough REMAINING capacity for `spec` (ROB-17).
 *
 * Admission control: a host is eligible only when its capacity MINUS the cpus/memory already
 * reserved by its live placements still fits the spec — so a host is never oversubscribed.
 * Among eligible hosts, pick the fewest placements, breaking ties by most free CPU.
 *
 * @param spec   the provision spec (drives the capacity fit filter).
 * @param hosts  all hosts (only `healthy` ones are eligible).
 * @param load   per-host reserved load (from `HostRegistry.placementUsage`). Hosts absent
 *               from the map are treated as empty (0 placements, 0 reserved).
 */
export function chooseHost(
  spec: ProvisionSpec,
  hosts: SandboxHost[],
  load: ReadonlyMap<string, HostLoad> = new Map(),
): SandboxHost {
  const eligible: ScoredHost[] = [];
  for (const host of hosts) {
    if (host.status !== "healthy") continue;
    const used = load.get(host.id);
    const freeCpus = host.cpus - (used?.cpus ?? 0);
    const freeMemoryMiB = host.memoryMiB - (used?.memoryMiB ?? 0);
    if (freeCpus < spec.cpus || freeMemoryMiB < spec.memoryMiB) continue;
    eligible.push({ host, placements: used?.count ?? 0, freeCpus });
  }
  if (eligible.length === 0) {
    throw new NoHostAvailableError({ cpus: spec.cpus, memoryMiB: spec.memoryMiB });
  }
  // Least-loaded: fewest placements first, then most free capacity.
  eligible.sort((a, b) => {
    if (a.placements !== b.placements) return a.placements - b.placements;
    return b.freeCpus - a.freeCpus;
  });
  return eligible[0].host;
}
