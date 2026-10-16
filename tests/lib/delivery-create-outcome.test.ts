import { afterEach, describe, expect, it, vi } from "vitest";

// No real DNS: assertPublicHost's lookup is stubbed to a public IP.
const dns = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryOutcomeUnknownError,
  DeliveryUnavailableError,
  isDefiniteCreateRefusalStatus,
} from "@/lib/integrations/delivery/errors";
import {
  ARAMEX_API_HOSTS,
  assertAllowedCarrierBaseUrl,
  isAllowedCarrierHost,
  isAllowedCarrierUrl,
  OZONEXPRESS_API_HOSTS,
  SENDIT_LABEL_HOSTS,
} from "@/lib/integrations/delivery/carrier-hosts";
import { OzonExpressClient } from "@/lib/integrations/delivery/providers/ozonexpress/client";
import { ozonExpressConfigSchema } from "@/lib/integrations/delivery/providers/ozonexpress/types";
import { ozonExpressAdapter } from "@/lib/integrations/delivery/providers/ozonexpress";
import { AramexClient } from "@/lib/integrations/delivery/providers/aramex/client";
import { AmeexClient, AmeexRateLimiter } from "@/lib/integrations/delivery/providers/ameex/client";

/**
 * 2026-10-16 review — parcel creation on every carrier:
 *  - a SENT creation answered by anything but an unambiguous refusal
 *    (400/401/403/404/422 + Sendit's documented 250-252) is an unknown
 *    outcome (« à vérifier »), never ECHEC — incl. HTTP 408 and 409;
 *  - a tenant-editable carrier base URL may only target the carrier's own
 *    official hosts (credentials travel in the URL path / request body).
 * Stubbed fetch only; nothing touches the network.
 */

const ozCreds = { customerId: "11111", apiKey: "fake-oz-key-SHOULD-NOT-LEAK" };
const aramexCreds = {
  userName: "fake-user@example.com",
  password: "fake-password",
  accountNumber: "000000",
  accountPin: "000000",
  accountEntity: "CMN",
  accountCountryCode: "MA",
};
const ameexCreds = { apiId: "fake-id", apiKey: "fake-ameex-key-SHOULD-NOT-LEAK" };

function stubFetch(make: () => Response | Promise<Response>) {
  const fn = vi.fn(async () => make());
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isDefiniteCreateRefusalStatus", () => {
  it("only 400/401/403/404/422 (+ carrier extras) are definite", () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isDefiniteCreateRefusalStatus(s)).toBe(true);
    for (const s of [408, 409, 410, 413, 418, 429, 500, 502, 503, 250]) expect(isDefiniteCreateRefusalStatus(s)).toBe(false);
    expect(isDefiniteCreateRefusalStatus(250, [250, 251, 252])).toBe(true);
  });
});

describe("carrier host allowlist", () => {
  it("exact host match only — no suffix / lookalike", () => {
    expect(isAllowedCarrierHost("api.ozonexpress.ma", OZONEXPRESS_API_HOSTS)).toBe(true);
    expect(isAllowedCarrierHost("API.OZONEXPRESS.MA.", OZONEXPRESS_API_HOSTS)).toBe(true);
    expect(isAllowedCarrierHost("evil.api.ozonexpress.ma", OZONEXPRESS_API_HOSTS)).toBe(false);
    expect(isAllowedCarrierHost("api.ozonexpress.ma.evil.com", OZONEXPRESS_API_HOSTS)).toBe(false);
    expect(isAllowedCarrierHost("ws.dev.aramex.net", ARAMEX_API_HOSTS)).toBe(true);
  });

  it("https only, no userinfo, default port", () => {
    expect(isAllowedCarrierUrl("https://app.sendit.ma/signed-files/x", SENDIT_LABEL_HOSTS)).toBe(true);
    expect(isAllowedCarrierUrl("http://app.sendit.ma/x", SENDIT_LABEL_HOSTS)).toBe(false);
    expect(isAllowedCarrierUrl("https://u:p@app.sendit.ma/x", SENDIT_LABEL_HOSTS)).toBe(false);
    expect(isAllowedCarrierUrl("https://app.sendit.ma:444/x", SENDIT_LABEL_HOSTS)).toBe(false);
    expect(isAllowedCarrierUrl("javascript:alert(1)", SENDIT_LABEL_HOSTS)).toBe(false);
    expect(isAllowedCarrierUrl(null, SENDIT_LABEL_HOSTS)).toBe(false);
  });

  it("the mock hosts used by fixtures are accepted ONLY under NODE_ENV=test", () => {
    expect(isAllowedCarrierHost("example.com", OZONEXPRESS_API_HOSTS)).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(isAllowedCarrierHost("example.com", OZONEXPRESS_API_HOSTS)).toBe(false);
      expect(isAllowedCarrierHost("93.184.216.34", ARAMEX_API_HOSTS)).toBe(false);
      expect(isAllowedCarrierHost("api.ozonexpress.ma", OZONEXPRESS_API_HOSTS)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("assertAllowedCarrierBaseUrl never echoes the URL (it can embed credentials)", () => {
    const err = (() => {
      try {
        assertAllowedCarrierBaseUrl("https://attacker.test/customers/11111/secret-key", OZONEXPRESS_API_HOSTS, "OzonExpress");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err).toBeInstanceOf(DeliveryConfigError);
    expect(err.message).not.toContain("attacker.test");
    expect(err.message).not.toContain("secret-key");
  });
});

describe("OzonExpress — add-parcel ({ once: true })", () => {
  const ozClient = () => new OzonExpressClient(ozCreds, "https://api.ozonexpress.ma", { timeoutMs: 1000 });
  const addParcel = () => ozClient().post("add-parcel", { "parcel-receiver": "A" }, { once: true });

  it.each([408, 409, 418])("HTTP %i → DeliveryOutcomeUnknownError, sent exactly once", async (status) => {
    const fetchFn = stubFetch(() => new Response("", { status }));
    const err = await caught(addParcel());
    expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain(ozCreds.apiKey);
  });

  it("HTTP 401 stays a definite auth refusal", async () => {
    stubFetch(() => new Response("", { status: 401 }));
    expect(await caught(addParcel())).toBeInstanceOf(DeliveryAuthError);
  });

  it("a read (not once) answered 408 keeps its regular typed error", async () => {
    stubFetch(() => new Response("", { status: 408 }));
    const err = await caught(ozClient().post("tracking", { "tracking-number": "X" }));
    expect(err).toBeInstanceOf(DeliveryUnavailableError);
    expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });

  it("a config baseUrl on a non-OzonExpress host is refused before anything is sent (credentials are in the path)", async () => {
    const fetchFn = stubFetch(() => new Response("{}", { status: 200 }));
    for (const baseUrl of ["https://attacker.test", "https://api.ozonexpress.ma.attacker.test", "http://api.ozonexpress.ma"]) {
      expect(() => new OzonExpressClient(ozCreds, baseUrl)).toThrow(DeliveryConfigError);
    }
    const err = await caught(ozonExpressAdapter.testConnection(ozCreds, { baseUrl: "https://attacker.test" }));
    expect(err).toBeInstanceOf(DeliveryConfigError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("portalBaseUrl must be https on client.ozoneexpress.ma", () => {
    expect(ozonExpressConfigSchema.safeParse({ portalBaseUrl: "https://client.ozoneexpress.ma" }).success).toBe(true);
    expect(ozonExpressConfigSchema.safeParse({ portalBaseUrl: "https://phish.test" }).success).toBe(false);
    expect(ozonExpressConfigSchema.safeParse({ portalBaseUrl: "http://client.ozoneexpress.ma" }).success).toBe(false);
  });
});

describe("Aramex — CreateShipments ({ once: true })", () => {
  const create = (client = new AramexClient(aramexCreds, { timeoutMs: 1000 })) =>
    client.post("shipping", "Service_1_0.svc/json/CreateShipments", { Shipments: [] }, { once: true });

  it.each([408, 409, 418])("HTTP %i → DeliveryOutcomeUnknownError, sent exactly once", async (status) => {
    const fetchFn = stubFetch(() => new Response("", { status }));
    expect(await caught(create())).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("HTTP 403 stays a definite auth refusal", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    expect(await caught(create())).toBeInstanceOf(DeliveryAuthError);
  });

  it("default live and sandbox hosts are accepted", () => {
    expect(() => new AramexClient(aramexCreds)).not.toThrow();
    expect(() => new AramexClient(aramexCreds, { sandbox: true })).not.toThrow();
  });

  it("a *BaseUrl override off ws(.dev).aramex.net is refused (ClientInfo carries the password)", () => {
    for (const key of ["shippingBaseUrl", "trackingBaseUrl", "rateBaseUrl"] as const) {
      expect(() => new AramexClient(aramexCreds, { [key]: "https://collector.test/Shipping" })).toThrow(DeliveryConfigError);
    }
    expect(() => new AramexClient(aramexCreds, { shippingBaseUrl: "https://ws.aramex.net/ShippingAPI.V2/Shipping" })).not.toThrow();
  });
});

describe("Ameex — Add parcel (postOnce)", () => {
  const client = () => new AmeexClient(ameexCreds, { timeoutMs: 1000, rateLimiter: new AmeexRateLimiter(), sleep: async () => {} });
  const add = () => client().postOnce("Delivery/Parcels/Action/Type/Add", { type: "SIMPLE" }, "form");

  it.each([408, 409, 418])("HTTP %i → DeliveryOutcomeUnknownError (nothing proves the parcel was not created), one attempt", async (status) => {
    const fetchFn = stubFetch(() => new Response("", { status }));
    const err = await caught(add());
    expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain(ameexCreds.apiKey);
  });

  it.each([400, 422])("HTTP %i stays a definite refusal", async (status) => {
    stubFetch(() => new Response("", { status }));
    const err = await caught(add());
    expect(err).toBeInstanceOf(DeliveryConfigError);
  });

  it("a read answered 408 keeps its regular typed error", async () => {
    stubFetch(() => new Response("", { status: 408 }));
    const err = await caught(client().get("Delivery/Cities"));
    expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });
});
