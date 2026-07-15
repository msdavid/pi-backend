/**
 * GATE-1 / §29.2 — Credential-injection test (WP-1.14, `@kvm`).
 *
 * Registers a vault `environment_variable` credential, provisions a sandbox with
 * the secret binding, and proves from **inside** the sandbox that:
 *   - the `$MSB_<VAR>` placeholder is visible in the guest env,
 *   - the real secret value is NOT present in any guest-readable location
 *     (`env`, `/proc/self/environ`, the msb config dir).
 *
 * §25.5 invariant: the real value is resolved **host-side** by the
 * `SecretResolver` (the only path a raw secret enters the provider) and handed to
 * the msb SDK's secret mechanism; the guest sees only the placeholder. Egress
 * substitution (real value injected only into TLS traffic to `allowedHosts`)
 * requires a TLS-intercepting host to verify end-to-end (§30 item 14 — OPEN);
 * this test proves the placeholder-is-visible / real-value-is-absent half and
 * documents egress substitution as a follow-up (see `docs/capacity.md`).
 *
 * Gates on `/dev/kvm` + `isInstalled()` + a container runtime (for Postgres). Skips
 * cleanly otherwise so `pnpm test` stays green on non-KVM hosts.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addCredential,
  closePool,
  createPool,
  createTenant,
  createVault,
  getDefaultVaultCrypto,
  runMigrations,
  type Pool,
  type TenantCtx,
} from "../../src/index.js";
import {
  MicrosandboxProvider,
  type SecretResolver,
} from "../../src/infra/sandbox/provider.js";
import type {
  EncryptedSecret,
  VaultCrypto,
} from "../../src/domain/vault/crypto.js";
import type {
  ProvisionSpec,
  SandboxHandle,
  SecretBinding,
  SecretCredentialRef,
} from "../../src/domain/ports.js";
import {
  startPostgres,
  hasContainerRuntime,
  type TestDb,
} from "../../src/infra/db/__tests__/test-runtime.js";
import { kvmRuntimeAvailable } from "../../src/infra/sandbox/__tests__/kvm-gate.js";
import type { Environment } from "@pi-managed/contracts";

const SUITE = "GATE-1 credential-injection gate (@kvm, real microVM + Postgres)";

/**
 * Capability gates. Both hard-fail (instead of skipping) under
 * `PI_REQUIRE_INTEGRATION` — see `src/infra/sandbox/__tests__/kvm-gate.ts` and
 * `src/infra/db/__tests__/test-runtime.ts` (R1.2).
 */
const KVM = kvmRuntimeAvailable(SUITE);
const CONTAINER = hasContainerRuntime(SUITE);
const RUN = KVM && CONTAINER;

const BOOT_TIMEOUT = 300_000;
const STEP_TIMEOUT = 600_000;

/** A unique, alphanumeric secret so `grep -F` is safe without shell escaping. */
const SECRET_VALUE = `sk-gate-secret-${randomUUID().replace(/-/g, "")}`;
const SECRET_KEY = "GATE_TOKEN";
const ENV_VAR = `MSB_${SECRET_KEY}`; // envVarFromPlaceholder strips the leading `$`
const PLACEHOLDER = `$MSB_${SECRET_KEY}`;
const ALLOWED_HOST = "example.com";

/**
 * Test-local `SecretResolver`: decrypts the env-var credential from the vault
 * DB host-side (the only path the raw value enters the provider, §25.5). This is
 * the resolver the real composition root does not yet wire (Phase-1 gap); the gate
 * supplies it to exercise the full credential-injection trust boundary.
 */
function makeResolver(pool: Pool, crypto: VaultCrypto): SecretResolver {
  return {
    async resolve(
      ref: SecretCredentialRef,
      _category: string,
      _mcpServerUrl?: string,
    ): Promise<{ value: string; allowedHosts: string[] }> {
      const { rows } = await pool.query<{
        secret_enc: Buffer;
        nonce: Buffer;
        key_id: string;
      }>(
        `SELECT secret_enc, nonce, key_id
           FROM vault_credentials
          WHERE tenant_id = $1 AND vault_id = $2 AND key = $3 AND status = 'active'`,
        [ref.tenantId, ref.vaultId, ref.credentialKey],
      );
      if (rows.length === 0) {
        throw new Error(
          `gate resolver: credential not found for vault ${ref.vaultId} key ${ref.credentialKey}`,
        );
      }
      const r = rows[0];
      const enc: EncryptedSecret = {
        ciphertext: r.secret_enc,
        nonce: r.nonce,
        keyId: r.key_id,
      };
      return { value: crypto.decrypt(enc), allowedHosts: [ALLOWED_HOST] };
    },
  };
}

describe.skipIf(!RUN)("GATE-1 §29.2: credential injection (@gate, @kvm)", () => {
  let db: TestDb;
  let pool: Pool;
  let tenantCtx: TenantCtx;
  let vaultId: string;
  let crypto: VaultCrypto;
  let provider: MicrosandboxProvider;
  let handle: SandboxHandle | undefined;
  const sandboxName = `pi-gate-cred-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = await startPostgres();
    await runMigrations(db.connectionString, "up");
    pool = createPool({ connectionString: db.connectionString });

    const tenant = await createTenant(pool, { name: "gate-cred-tenant" });
    tenantCtx = { tenantId: tenant.id };
    crypto = getDefaultVaultCrypto();
    const vault = await createVault(pool, tenantCtx, { name: "gate-cred-vault" });
    vaultId = vault.id;
    await addCredential(pool, tenantCtx, crypto, vaultId, {
      key: SECRET_KEY,
      category: "environment_variable",
      secretValue: SECRET_VALUE,
    });

    provider = new MicrosandboxProvider({
      secretResolver: makeResolver(pool, crypto),
    });

    const binding: SecretBinding = {
      placeholderName: PLACEHOLDER,
      category: "environment_variable",
      credentialRef: {
        tenantId: tenantCtx.tenantId,
        vaultId,
        credentialKey: SECRET_KEY,
      },
    };
    const env: Environment = {
      id: "env_gate",
      name: "gate-env",
      type: "cloud",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      image: "ubuntu:22.04",
      resources: { cpus: 1, memoryMiB: 512 },
      networking: { mode: "limited", allowedHosts: [ALLOWED_HOST] },
    };
    const spec: ProvisionSpec = {
      name: sandboxName,
      image: env.image,
      cpus: env.resources!.cpus!,
      memoryMiB: env.resources!.memoryMiB!,
      networkPolicy: {
        mode: "limited",
        allowedHosts: env.networking!.allowedHosts!,
      },
      labels: { tenant: tenantCtx.tenantId, session: "gate-cred" },
      detached: true,
      // NOTE: secretBindings are NOT applied at provision time with this msb version;
      // the placeholder is materialized by `registerSecretBinding` (modify + restart)
      // after provision — mirroring the real `ManagedSessionRuntime.ensureSandboxRunning`
      // path (provision → registerSecretBinding for each binding).
    };
    handle = await provider.provision(spec);
    await provider.registerSecretBinding(handle, binding);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    if (provider && handle) await provider.destroy(handle).catch(() => {});
    if (pool) await closePool(pool).catch(() => {});
    if (db) await db.container.stop().catch(() => {});
  });

  it(
    "placeholder $MSB_<VAR> is visible in the guest env; real value is not",
    async () => {
      const r = await provider.exec(handle!, { cmd: "env | grep MSB_ || true" });
      // The placeholder env var is present in the guest...
      expect(r.stdout).toContain(ENV_VAR);
      expect(r.stdout).toContain(PLACEHOLDER);
      // ...and the real secret value is NOT in the guest env.
      expect(r.stdout).not.toContain(SECRET_VALUE);
    },
    STEP_TIMEOUT,
  );

  it(
    "real value is absent from /proc/self/environ",
    async () => {
      const r = await provider.exec(handle!, {
        cmd: `cat /proc/self/environ | tr '\\0' '\\n' | grep -F -- '${SECRET_VALUE}'`,
      });
      // grep exits non-zero when no match — exactly what we want.
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain(SECRET_VALUE);
    },
    STEP_TIMEOUT,
  );

  it(
    "real value is absent from the msb config / common guest-readable files",
    async () => {
      // Bounded search over likely guest-readable config locations. `grep -s` suppresses
      // errors for paths that don't exist; `rc=1` means grep found no match anywhere,
      // `rc=2` means a path was absent (also fine — the secret isn't there either way).
      // A full-FS scan is the egress-substitution follow-up (§30 item 14); this proves
      // the value is not sitting in a config file the guest can read.
      const r = await provider.exec(handle!, {
        cmd: `grep -RFs -- '${SECRET_VALUE}' /root/.microsandbox /etc/environment /etc/profile.d 2>/dev/null; echo "rc=$?"`,
      });
      expect(r.stdout).not.toContain(SECRET_VALUE);
      const rcMatch = r.stdout.match(/rc=(\d+)/);
      expect(rcMatch).not.toBeNull();
      expect(["1", "2"]).toContain(rcMatch![1]);
    },
    STEP_TIMEOUT,
  );

  it(
    "documents egress-substitution verification as a follow-up (§30 item 14)",
    () => {
      // Egress substitution (real value injected into TLS traffic to allowedHosts
      // only) requires a TLS-intercepting host to verify end-to-end. This gate
      // proves the placeholder is visible + the real value is absent from the
      // guest — the host-side resolution + registration half of the §25.5
      // invariant. The egress half is tracked in docs/capacity.md.
      expect(PLACEHOLDER).toBe(`$MSB_${SECRET_KEY}`);
      expect(ALLOWED_HOST).toBe("example.com");
    },
    STEP_TIMEOUT,
  );
});
