/**
 * Host-agent channel authentication (WP-4.3, §6.1 trust model).
 *
 * The host-agent API is a privileged control channel (`/exec` runs arbitrary commands
 * in any VM, `/list-by-labels` enumerates VMs cross-tenant, `/register-secret-binding`
 * wires credentials). Every request must carry `Authorization: Bearer <token>` where the
 * token is a per-host shared secret sourced from config. This module provides:
 *
 * - {@link createHostAgentTokenSource}: resolve a host's secret from the environment,
 *   failing closed when none is configured.
 * - {@link isValidHostAgentToken}: constant-time verification for the receiving side
 *   (the standalone agent binary and the in-repo mock host both use it).
 *
 * The secret is never hardcoded and never logged. See `docs/spec/multi-host-design.md` §6.1.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { SandboxHost } from "./types.js";

/** Env var holding the pool-wide fallback secret. */
const POOL_WIDE_ENV = "SANDBOX_HOST_AGENT_TOKEN";
/** Per-host override prefix: `SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>`. */
const PER_HOST_PREFIX = "SANDBOX_HOST_AGENT_TOKEN_";

/** Resolves the shared secret for a given host. */
export type HostAgentTokenSource = (host: SandboxHost) => string;

/** Env-like map (string | undefined), matching {@link infra/config}. */
export type EnvLike = Record<string, string | undefined>;

/** Thrown when no host-agent secret is configured for a host (fail closed). */
export class HostAgentTokenMissingError extends Error {
  constructor(public readonly hostId: string) {
    super(
      `No host-agent secret configured for host ${hostId}: set ` +
        `${PER_HOST_PREFIX}${envSuffix(hostId)} or ${POOL_WIDE_ENV}`,
    );
    this.name = "HostAgentTokenMissingError";
  }
}

/** Normalize a host id into an env-var suffix: upper-case, non-alnum → `_`. */
function envSuffix(hostId: string): string {
  return hostId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Build a {@link HostAgentTokenSource} from an env map. A host's secret is the per-host
 * override (`SANDBOX_HOST_AGENT_TOKEN_<HOST_ID>`) if present, else the pool-wide
 * `SANDBOX_HOST_AGENT_TOKEN`. Fails closed: a host with neither throws
 * {@link HostAgentTokenMissingError} rather than yielding an empty/absent secret.
 */
export function createHostAgentTokenSource(env: EnvLike): HostAgentTokenSource {
  return (host: SandboxHost): string => {
    const perHost = env[`${PER_HOST_PREFIX}${envSuffix(host.id)}`];
    const token = perHost ?? env[POOL_WIDE_ENV];
    if (!token) throw new HostAgentTokenMissingError(host.id);
    return token;
  };
}

/**
 * Constant-time verification of a presented `Authorization` header against the host's
 * expected secret. Requires the `Bearer` scheme (case-insensitive). Returns `false` for a
 * missing/malformed header or a wrong token. Both sides are SHA-256 digested before
 * {@link timingSafeEqual} so neither the token value nor its length leaks via timing.
 */
export function isValidHostAgentToken(
  authorization: string | undefined,
  expected: string,
): boolean {
  if (!authorization) return false;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const presented = match[1];
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
