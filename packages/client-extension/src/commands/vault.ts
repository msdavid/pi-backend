/**
 * @pi-managed/client — `/remote:vault` commands (spec §24.5, §12).
 * Vault & credential lifecycle. Sensitive fields are write-only (never echoed).
 *
 * Commands:
 * - `/remote:vault list` — list vaults.
 * - `/remote:vault create` — interactively create a vault.
 * - `/remote:vault add-cred <vaultId>` — add a credential (prompts for the
 *   secret; the secret is sent to the backend and never stored/logged locally).
 * - `/remote:vault validate <vaultId> <key>` — validate OAuth status (Phase 2).
 *
 * SECURITY: the credential secret is collected via `ui.input`, sent to the
 * backend over TLS, and never written to disk, the recorder, or widget output.
 *
 * The run* functions are decoupled from Pi types (deps-injected) so they can be
 * unit-tested against a mock client.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CredentialCategory, CredentialCreate, Vault } from "@pi-managed/contracts";
import { ApiClientError, type ManagedApiClient } from "../api-client.js";
import { buildClientFromContext } from "./remote.js";

/** UI slice these commands need (structural subset of ctx.ui). */
export interface VaultUi {
  notify(msg: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, lines: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
}

/** Dependencies for the run* functions (all injectable for testing). */
export interface VaultCommandDeps {
  ui: VaultUi;
  /** Build an authenticated client, or undefined if the backend isn't configured. */
  createClient(): ManagedApiClient | undefined;
}

const CATEGORIES: CredentialCategory[] = ["static_bearer", "environment_variable", "mcp_oauth"];

// --- helpers ----------------------------------------------------------------

function parseArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter((t) => t !== "");
}

function notConfigured(ui: VaultUi): void {
  ui.notify("Pi Managed Backend is not configured. Run /remote:config first.", "error");
}

function catchClientError(ui: VaultUi, e: unknown, what: string): boolean {
  if (e instanceof ApiClientError) {
    ui.notify(`${what} failed: ${e.message}`, "error");
    return true;
  }
  return false;
}

// --- /remote:vault list -----------------------------------------------------

export async function runVaultList(deps: VaultCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  let page;
  try {
    page = await client.listVaults({ limit: 50 });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Listing vaults")) return;
    throw e;
  }
  if (page.data.length === 0) {
    deps.ui.notify("No vaults.", "info");
    return;
  }
  const lines = ["Vaults:"];
  for (const v of page.data) {
    lines.push(`  ${v.id} · ${v.status} · ${v.name}`);
  }
  deps.ui.setWidget("pi-managed:vaults", lines.slice(0, 50));
  deps.ui.setStatus("pi-managed", `${page.data.length} vault(s)`);
}

// --- /remote:vault create --------------------------------------------------

export async function runVaultCreate(deps: VaultCommandDeps): Promise<void> {
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  const name = await deps.ui.input("Vault name", "ci-secrets");
  if (!name) return;
  let vault: Vault;
  try {
    vault = await client.createVault({ name });
  } catch (e) {
    if (catchClientError(deps.ui, e, "Creating vault")) return;
    throw e;
  }
  deps.ui.notify(`Created vault ${vault.id} (${vault.status}).`, "info");
}

// --- /remote:vault add-cred <vaultId> --------------------------------------

export async function runVaultAddCred(deps: VaultCommandDeps, args: string): Promise<void> {
  const [vaultId] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!vaultId) {
    deps.ui.notify("Usage: /remote:vault add-cred <vaultId>", "error");
    return;
  }
  const category = await deps.ui.select("Credential category", CATEGORIES);
  if (!category) return;
  const key = await deps.ui.input("Key (mcpServerUrl / secretName)", "");
  if (!key) return;
  const secret = await deps.ui.input(`Secret for ${category}`, "");
  if (!secret) return;

  // Build the discriminated credential body. The secret is forwarded to the
  // backend and never echoed in any local output (§12.4 write-only).
  const body = buildCredentialBody(category as CredentialCategory, key, secret);
  if (body === null) return;
  let cred;
  try {
    cred = await client.addCredential(vaultId, body);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Adding credential")) return;
    throw e;
  }
  deps.ui.notify(
    `Added ${cred.category} credential '${cred.key}' to vault ${vaultId} (${cred.id}).`,
    "info",
  );
}

function buildCredentialBody(
  category: CredentialCategory,
  key: string,
  secret: string,
): CredentialCreate {
  if (category === "static_bearer") {
    return { key, category: "static_bearer", token: secret };
  }
  if (category === "environment_variable") {
    return { key, category: "environment_variable", secretValue: secret };
  }
  // Phase 1 stores without refresh (§12.3); the tool surface exposes the full shape.
  return { key, category: "mcp_oauth", accessToken: secret };
}

// --- /remote:vault validate <vaultId> <key> --------------------------------

export async function runVaultValidate(deps: VaultCommandDeps, args: string): Promise<void> {
  const [vaultId, key] = parseArgs(args);
  const client = deps.createClient();
  if (!client) return notConfigured(deps.ui);
  if (!vaultId || !key) {
    deps.ui.notify("Usage: /remote:vault validate <vaultId> <key>", "error");
    return;
  }
  let result;
  try {
    result = await client.validateCredential(vaultId, key);
  } catch (e) {
    if (catchClientError(deps.ui, e, "Validating credential")) return;
    throw e;
  }
  deps.ui.notify(`Credential '${key}' status: ${result}.`, "info");
}

// --- Pi wiring -------------------------------------------------------------

/**
 * Register the `/remote:vault` command with Pi. RPC-invokable.
 */
export function registerVaultCommands(pi: ExtensionAPI): void {
  const deps = (ctx: ExtensionCommandContext): VaultCommandDeps => ({
    ui: ctx.ui,
    createClient: () => buildClientFromContext(ctx),
  });

  pi.registerCommand("remote:vault", {
    description: "Manage vaults: /remote:vault <list|create|add-cred|validate> (spec §24.5, §12).",
    handler: async (args, ctx) => {
      const [sub, ...rest] = parseArgs(args);
      const restArgs = rest.join(" ");
      const d = deps(ctx);
      switch (sub) {
        case "list":
          return runVaultList(d);
        case "create":
          return runVaultCreate(d);
        case "add-cred":
          return runVaultAddCred(d, restArgs);
        case "validate":
          return runVaultValidate(d, restArgs);
        default:
          d.ui.notify(
            "Usage: /remote:vault <list|create|add-cred|validate>",
            "error",
          );
      }
    },
  });
}
