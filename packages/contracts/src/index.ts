/**
 * @pi-managed/contracts — wire types + zod schemas.
 *
 * This package mechanically mirrors docs/api-reference.md. Change the doc first, then
 * this package, in the same work package (plan §3.2, WP-0.9). Every schema here has a
 * 1:1 correspondence with a section of the wire contract; do not diverge.
 *
 * Organization mirrors the api-reference.md resource-family headings:
 *   common → ids → agent → environment → session → events → vault → memory →
 *   file → skill → outcome → job → webhook → tenant.
 *
 * Security invariants encoded here:
 *   - Vault credential sensitive fields (`token`, `accessToken`, `clientSecret`,
 *     `secretValue`) are write-only: present in `CredentialCreate`, absent from
 *     `Credential`. Enforced by a golden test.
 *   - Webhook `signingSecret` is present only on `WebhookCreateResponse`, not `Webhook`.
 *   - API key raw `key` is present only on `ApiKeyCreateResponse`, not `ApiKey`.
 *   - `tenantId` is never client-supplied (not present on any create schema).
 */

/** Package version (mirrors docs/api-reference.md). */
export const CONTRACTS_VERSION = "0.0.0";

// --- Shared -----------------------------------------------------------------
export * from "./common.js";
export * from "./ids.js";

// --- Resource families ------------------------------------------------------
export * from "./agent.js";
export * from "./environment.js";
export * from "./session.js";
export * from "./events.js";
export * from "./vault.js";
export * from "./memory.js";
export * from "./file.js";
export * from "./skill.js";
export * from "./outcome.js";
export * from "./job.js";
export * from "./webhook.js";
export * from "./tenant.js";
