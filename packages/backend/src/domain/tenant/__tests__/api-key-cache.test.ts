/**
 * Verified-API-key cache tests (SEC-1) — pure unit, no database.
 *
 * Covers the security-relevant behavior the argon2 fast path depends on:
 * - a hit returns the cached ctx (letting verifyApiKey skip argon2);
 * - a wrong secret for a cached id misses (constant-time digest mismatch);
 * - entries expire on the TTL;
 * - invalidate (revoke) drops the entry immediately;
 * - the returned ctx is a copy, so callers cannot mutate cached state.
 */

import { describe, expect, it } from "vitest";
import { ApiKeyCache } from "../api-key-cache.js";

const RAW = "pmb_live_01ARZ3NDEKTSV4RRFFQ69G5FAV_ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const ID = "apikey_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("ApiKeyCache", () => {
  it("returns the cached ctx on a matching id + raw key (argon2 fast path)", () => {
    const cache = new ApiKeyCache();
    expect(cache.get(ID, RAW)).toBeNull();
    cache.set(ID, RAW, { tenantId: "tnt_1", scopes: ["read"] });
    expect(cache.get(ID, RAW)).toEqual({ tenantId: "tnt_1", scopes: ["read"] });
  });

  it("misses when the raw key differs for a cached id (constant-time compare)", () => {
    const cache = new ApiKeyCache();
    cache.set(ID, RAW, { tenantId: "tnt_1", scopes: ["read"] });
    const wrongSecret = RAW.slice(0, -1) + "0";
    expect(cache.get(ID, wrongSecret)).toBeNull();
  });

  it("expires entries once the TTL elapses", () => {
    let now = 1_000;
    const cache = new ApiKeyCache({ ttlMs: 500, now: () => now });
    cache.set(ID, RAW, { tenantId: "tnt_1" });
    now = 1_499;
    expect(cache.get(ID, RAW)).not.toBeNull();
    now = 1_500;
    expect(cache.get(ID, RAW)).toBeNull();
    // Reading a stale entry drops it from the map.
    expect(cache.size()).toBe(0);
  });

  it("invalidate drops the entry immediately (revoke path)", () => {
    const cache = new ApiKeyCache();
    cache.set(ID, RAW, { tenantId: "tnt_1" });
    cache.invalidate(ID);
    expect(cache.get(ID, RAW)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("returns a copy so cached state cannot be mutated by a caller", () => {
    const cache = new ApiKeyCache();
    cache.set(ID, RAW, { tenantId: "tnt_1", scopes: ["read"] });
    const first = cache.get(ID, RAW)!;
    first.scopes!.push("admin");
    first.tenantId = "tnt_evil";
    expect(cache.get(ID, RAW)).toEqual({ tenantId: "tnt_1", scopes: ["read"] });
  });
});
