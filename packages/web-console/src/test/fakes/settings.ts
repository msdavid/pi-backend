/**
 * `/v1/api-keys` + `/v1/webhooks` families of the {@link FakeConsoleApi}
 * (WP-C3-prep). Show-once semantics mirror the real API: the raw api key /
 * `whsec_` signing secret exists ONLY in the create response (obviously fake
 * values — never real-looking credentials); stored records never carry it.
 */
import type { ApiKey, Webhook } from "@pi-managed/contracts";

import { notFound, fullSet } from "./wire.js";

/** A wire-shaped API-key record (contracts `ApiKey` — no raw key). */
export function makeApiKey(
  overrides: Partial<ApiKey> & { id: string },
): ApiKey {
  return {
    name: "ci-key",
    scopes: ["read"],
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A wire-shaped webhook record (contracts `Webhook` — no signing secret). */
export function makeWebhook(
  overrides: Partial<Webhook> & { id: string },
): Webhook {
  return {
    url: "https://hooks.example.com/pi-managed",
    eventTypes: ["session.status_idle"],
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The slice of `FakeConsoleApi` state these families use. */
export interface SettingsState {
  apiKeys: ApiKey[];
  webhooks: Webhook[];
  webhookTestResult: { delivered: boolean; responseCode?: number };
}

/** `GET /v1/api-keys` + `GET /v1/webhooks*`; `undefined` if unmatched. */
export function settingsGet(
  state: SettingsState,
  pathname: string,
): unknown | undefined {
  if (pathname === "/v1/api-keys") return fullSet(state.apiKeys);
  if (pathname === "/v1/webhooks") return fullSet(state.webhooks);
  const match = pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const found = state.webhooks.find((w) => w.id === id);
    if (!found) throw notFound(id);
    return found;
  }
  return undefined;
}

/** `POST /v1/api-keys` + `POST /v1/webhooks(/:id/test)`. */
export function settingsPost(
  state: SettingsState,
  pathname: string,
  body: unknown,
): unknown | undefined {
  if (pathname === "/v1/api-keys") {
    const { name, scopes } = body as { name: string; scopes?: string[] };
    const record = makeApiKey({
      id: `apikey_01TESTNEW${state.apiKeys.length + 1}`,
      name,
      scopes: scopes ?? ["read"],
    });
    state.apiKeys.push(record);
    // Raw key ONLY in this response — the stored record never carries it.
    return { ...record, key: "pmb_live_TESTISSUEDKEYNOTASECRET" };
  }
  if (pathname === "/v1/webhooks") {
    const { url, eventTypes } = body as Pick<Webhook, "url" | "eventTypes">;
    const record = makeWebhook({
      id: `wh_01TESTNEW${state.webhooks.length + 1}`,
      url,
      eventTypes,
    });
    state.webhooks.push(record);
    // Signing secret ONLY in this response (§23.3).
    return { ...record, signingSecret: "whsec_TESTSECRETNOTASECRET" };
  }
  const test = pathname.match(/^\/v1\/webhooks\/([^/]+)\/test$/);
  if (test) {
    const id = decodeURIComponent(test[1]!);
    if (!state.webhooks.some((w) => w.id === id)) throw notFound(id);
    return state.webhookTestResult;
  }
  return undefined;
}

/** `DELETE /v1/api-keys/:id` (revoke) + `DELETE /v1/webhooks/:id`. */
export function settingsDel(state: SettingsState, pathname: string): boolean {
  const key = pathname.match(/^\/v1\/api-keys\/([^/]+)$/);
  if (key) {
    const id = decodeURIComponent(key[1]!);
    const found = state.apiKeys.find((k) => k.id === id);
    if (!found) throw notFound(id);
    found.revokedAt = "2026-07-15T12:00:00.000Z";
    return true;
  }
  const wh = pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
  if (wh) {
    const id = decodeURIComponent(wh[1]!);
    const found = state.webhooks.find((w) => w.id === id);
    if (!found) throw notFound(id);
    state.webhooks.splice(state.webhooks.indexOf(found), 1);
    return true;
  }
  return false;
}
