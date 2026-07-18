/**
 * Adapter internal HTTP surface (console spec §11.7–11.8, WP-C5.3 F4).
 *
 * The SUBJECT is the machine-authed surface the backend's SDK-free proxy calls:
 * checkout / portal URL issuance and auto-charge config read/write, plus its
 * fail-closed bearer auth. The URL-issuer (the wired {@link BillingAdapter}) is a
 * scripted collaborator here; the auth + routing + USD↔micros translation are the
 * subject. No provider credentials anywhere — the machine token is an obviously
 * test-only string.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createAdapterInternalServer,
  type AdapterUrlIssuer,
} from "./internal-api.js";
import { InMemoryAutoChargeStore, type AutoChargeConfig } from "./auto-charge.js";

const TOKEN = "test-only-adapter-machine-secret-not-a-real-credential";

/** A scripted URL issuer (the collaborator) that echoes its inputs into the URL. */
const issuer: AdapterUrlIssuer = {
  createCheckoutUrl: async (tenantId, amountMicros) =>
    `https://checkout.test/${tenantId}/${amountMicros}`,
  createPortalUrl: async (tenantId, customerRef) =>
    `https://portal.test/${tenantId}/${customerRef}`,
};

function seededConfig(over: Partial<AutoChargeConfig> = {}): AutoChargeConfig {
  return {
    enabled: false,
    thresholdMicros: 0,
    amountMicros: 0,
    dailyCapMicros: 0,
    monthlyCapMicros: 0,
    customerRef: "cus_seed",
    paymentMethodRef: "pm_seed",
    ...over,
  };
}

let server: Server | undefined;

async function start(opts: {
  store?: InMemoryAutoChargeStore;
  provisionToken?: string;
}): Promise<{ baseUrl: string; store: InMemoryAutoChargeStore }> {
  const store = opts.store ?? new InMemoryAutoChargeStore();
  server = createAdapterInternalServer({
    adapter: issuer,
    store,
    provisionToken: opts.provisionToken ?? TOKEN,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, store };
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { authorization: `Bearer ${TOKEN}`, ...(extra.headers ?? {}) } };
}

describe("adapter internal surface — machine auth (fail-closed)", () => {
  it("rejects a request with no Authorization header (401)", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(`${baseUrl}/internal/adapter/auto-charge?tenantId=t1`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong / tenant-style bearer (401)", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(
      `${baseUrl}/internal/adapter/auto-charge?tenantId=t1`,
      { headers: { authorization: "Bearer pi_tenant_key_not_the_machine_secret" } },
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when the expected secret is blank — rejects even a matching blank bearer", async () => {
    const { baseUrl } = await start({ provisionToken: "" });
    const res = await fetch(`${baseUrl}/internal/adapter/auto-charge?tenantId=t1`, {
      headers: { authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });
});

describe("adapter internal surface — auto-charge config", () => {
  it("GET on an unconfigured tenant returns a default-OFF config (200, never 404)", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(`${baseUrl}/internal/adapter/auto-charge?tenantId=t1`, authed());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: false,
      thresholdMicros: 0,
      thresholdUsd: 0,
      amountMicros: 0,
      amountUsd: 0,
      lastChargeAt: null,
      disabledReason: null,
    });
  });

  it("PATCH updates enabled/threshold/amount (USD→micros) and persists", async () => {
    const { baseUrl } = await start({});
    const patch = await fetch(
      `${baseUrl}/internal/adapter/auto-charge`,
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "t1", enabled: true, thresholdUsd: 5, amountUsd: 20 }),
      }),
    );
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched).toMatchObject({
      enabled: true,
      thresholdMicros: 5_000_000,
      thresholdUsd: 5,
      amountMicros: 20_000_000,
      amountUsd: 20,
    });

    // Round-trip: the change persisted for the next GET.
    const get = await fetch(`${baseUrl}/internal/adapter/auto-charge?tenantId=t1`, authed());
    const got = await get.json();
    expect(got).toMatchObject({ enabled: true, thresholdMicros: 5_000_000, amountMicros: 20_000_000 });
  });

  it("GET / PATCH without a tenantId are 422", async () => {
    const { baseUrl } = await start({});
    const get = await fetch(`${baseUrl}/internal/adapter/auto-charge`, authed());
    expect(get.status).toBe(422);
    const patch = await fetch(
      `${baseUrl}/internal/adapter/auto-charge`,
      authed({ method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }),
    );
    expect(patch.status).toBe(422);
  });
});

describe("adapter internal surface — checkout / portal URL issuance", () => {
  it("checkout converts amountUsd→micros and issues the hosted URL", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(
      `${baseUrl}/internal/adapter/checkout`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "t1", amountUsd: 25 }),
      }),
    );
    expect(res.status).toBe(200);
    // $25 → 25_000_000 µUSD passed to the issuer.
    expect(await res.json()).toEqual({ url: "https://checkout.test/t1/25000000" });
  });

  it("checkout without an amount is 422 (the reference engine needs an explicit amount)", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(
      `${baseUrl}/internal/adapter/checkout`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "t1" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("portal issues the URL for the tenant's saved customer", async () => {
    const store = new InMemoryAutoChargeStore();
    store.setConfig("t1", seededConfig({ customerRef: "cus_abc" }));
    const { baseUrl } = await start({ store });
    const res = await fetch(
      `${baseUrl}/internal/adapter/portal`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "t1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://portal.test/t1/cus_abc" });
  });

  it("portal for a tenant with no saved customer is 409 — NOT 404 (which means 'no adapter')", async () => {
    const { baseUrl } = await start({});
    const res = await fetch(
      `${baseUrl}/internal/adapter/portal`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: "t1" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
