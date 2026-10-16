import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import {
  __setSenditClientOptionsForTests,
  senditAdapter,
  SENDIT_NOT_VALIDATED_NOTICE,
} from "@/lib/integrations/delivery/providers/sendit/adapter";
import { __clearSenditTokenCacheForTests } from "@/lib/integrations/delivery/providers/sendit/client";
import {
  __resetDeliveryProviderRegistryForTests,
  getDeliveryProvider,
} from "@/lib/integrations/delivery/registry";
import { registerSenditProvider } from "@/lib/integrations/delivery/providers/sendit";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
} from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";
import {
  abortError,
  deliveryDetail,
  emptyFakeSenditState,
  FAKE_SENDIT_PUBLIC_KEY,
  FAKE_SENDIT_SECRET_KEY,
  FAKE_SENDIT_TOKEN,
  installFakeSendit,
  json,
  ok,
  path,
  type FakeSenditState,
} from "../helpers/fake-sendit";

const creds = { publicKey: FAKE_SENDIT_PUBLIC_KEY, secretKey: FAKE_SENDIT_SECRET_KEY };
let state: FakeSenditState;

const input: CreateShipmentAdapterInput = {
  localShipmentId: "ship_1",
  orderNumber: "CMD-1",
  recipientName: "Client Test",
  addressLine1: "12 rue X",
  addressLine2: null,
  city: "Casablanca",
  resolvedProviderCityId: "7",
  region: null,
  country: "MA",
  phone: "0600000000",
  codAmount: 199,
  currency: "MAD",
  notes: null,
  parcelContents: "1× Tablier",
};

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

const creates = () => state.requests.filter((r) => path(r) === "deliveries" && r.method === "POST");
const nonLogin = () => state.requests.filter((r) => path(r) !== "login");

describe("senditAdapter", () => {
  beforeEach(() => {
    state = emptyFakeSenditState();
    installFakeSendit(state);
    __clearSenditTokenCacheForTests();
    __setSenditClientOptionsForTests({ sleep: async () => {}, timeoutMs: 1000 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setSenditClientOptionsForTests(null);
  });

  describe("declaration", () => {
    it("declares only implemented capabilities — no cancel, no webhooks, no manifest", () => {
      expect([...senditAdapter.capabilities].sort()).toEqual([
        "CREATE_SHIPMENT",
        "FETCH_CITIES",
        "FETCH_COST",
        "FETCH_LABEL",
        "FETCH_STATUS",
        "FETCH_TRACKING",
      ]);
      expect(senditAdapter.cancelShipment).toBeUndefined();
      expect(senditAdapter.verifyWebhookSignature).toBeUndefined();
      expect(senditAdapter.mapWebhookPayload).toBeUndefined();
      expect(senditAdapter.generateManifest).toBeUndefined();
      for (const m of ["createShipment", "fetchStatus", "fetchTracking", "listCities", "fetchLabel", "mapStatus"] as const) {
        expect(typeof senditAdapter[m]).toBe("function");
      }
    });

    it("credential fields: public key (text) + secret key (password), both required", () => {
      expect(senditAdapter.credentialFields?.map((f) => [f.name, f.type, f.required])).toEqual([
        ["publicKey", "text", true],
        ["secretKey", "password", true],
      ]);
    });

    it("is offered to new connections with the not-validated notice", () => {
      expect(senditAdapter.acceptsNewConnections).toBe(true);
      expect(senditAdapter.notice).toBe(SENDIT_NOT_VALIDATED_NOTICE);
      expect(SENDIT_NOT_VALIDATED_NOTICE).toContain("pas encore validé sur un compte réel");
    });

    it("registerSenditProvider is idempotent", () => {
      __resetDeliveryProviderRegistryForTests();
      registerSenditProvider();
      registerSenditProvider();
      expect(getDeliveryProvider("sendit")).toBe(senditAdapter);
      __resetDeliveryProviderRegistryForTests();
    });
  });

  describe("testConnection", () => {
    it("is a login only — no other request, nothing created", async () => {
      const r = await senditAdapter.testConnection(creds, {});
      expect(r.ok).toBe(true);
      expect(state.requests.map((q) => path(q))).toEqual(["login"]);
      expect(JSON.stringify(r)).not.toContain(FAKE_SENDIT_TOKEN);
    });

    it("forces a fresh login even when a token is cached", async () => {
      await senditAdapter.testConnection(creds, {});
      await senditAdapter.testConnection(creds, {});
      expect(state.requests.filter((q) => path(q) === "login")).toHaveLength(2);
    });

    it("bad keys → DeliveryAuthError", async () => {
      state.routes.push((r) => (path(r) === "login" ? json(401, {}) : undefined));
      expect(await caught(senditAdapter.testConnection(creds, {}))).toBeInstanceOf(DeliveryAuthError);
    });

    it("missing keys → config error before any request", async () => {
      expect(await caught(senditAdapter.testConnection({ publicKey: "x" }, {}))).toBeInstanceOf(DeliveryConfigError);
      expect(state.requests).toHaveLength(0);
    });
  });

  describe("createShipment", () => {
    it("POSTs the mapper body once and maps code → externalId, fee → cost, raw status kept", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries" && r.method === "POST"
          ? ok(deliveryDetail({ code: "DXY99", fee: 35, status: "PENDING", status_return: "RETOUR_PENDING" }))
          : undefined
      );
      const res = await senditAdapter.createShipment!(input, creds, { pickupDistrictId: 46 });
      expect(res).toEqual({
        externalId: "DXY99",
        trackingNumber: "DXY99",
        trackingUrl: null,
        cost: 35,
        rawStatus: "PENDING/RETOUR_PENDING",
      });
      expect(creates()).toHaveLength(1);
      expect(creates()[0].body).toMatchObject({
        district_id: 7,
        pickup_district_id: 46,
        name: "Client Test",
        amount: 199,
        phone: "0600000000",
        reference: "CMD-1",
        products_from_stock: 0,
        products: "1× Tablier",
      });
    });

    it("no resolved district → config error, nothing sent", async () => {
      const err = await caught(senditAdapter.createShipment!({ ...input, resolvedProviderCityId: null }, creds, {}));
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(state.requests).toHaveLength(0);
    });

    it("prepaid order (no COD amount) → config error, nothing sent", async () => {
      const err = await caught(senditAdapter.createShipment!({ ...input, codAmount: null }, creds, {}));
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(state.requests).toHaveLength(0);
    });

    it.each([
      ["timeout", () => abortError()],
      ["500", () => json(500, {})],
      ["2xx without parcel code", () => ok({ status: "PENDING" })],
      ["2xx unreadable envelope", () => json(200, { nope: true })],
    ] as const)("%s → DeliveryOutcomeUnknownError, exactly one create", async (_l, make) => {
      state.routes.push((r) => (path(r) === "deliveries" && r.method === "POST" ? make() : undefined));
      const err = await caught(senditAdapter.createShipment!(input, creds, {}));
      expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(creates()).toHaveLength(1);
    });

    it("2xx success:false → « à vérifier » (undocumented for creation in the official spec), sanitized, one create", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries" && r.method === "POST"
          ? json(200, { success: false, message: `refusé ${FAKE_SENDIT_SECRET_KEY}` })
          : undefined
      );
      const err = await caught(senditAdapter.createShipment!(input, creds, {}));
      expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(err.message).toContain("refusé");
      expect(err.message).toContain("portail Sendit");
      expect(err.message).not.toContain(FAKE_SENDIT_SECRET_KEY);
      expect(creates()).toHaveLength(1);
    });

    it.each([
      ["408", () => json(408, {})],
      ["409", () => json(409, {})],
      ["418 (unexpected)", () => json(418, {})],
    ] as const)("HTTP %s on create → « à vérifier », never a definite failure", async (_l, make) => {
      state.routes.push((r) => (path(r) === "deliveries" && r.method === "POST" ? make() : undefined));
      const err = await caught(senditAdapter.createShipment!(input, creds, {}));
      expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(creates()).toHaveLength(1);
    });

    it("422 with field errors stays a definite refusal (documented « données invalides »)", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries" && r.method === "POST"
          ? json(422, { success: false, message: "Les données fournies sont invalides", errors: { phone: ["requis"] } })
          : undefined
      );
      const err = await caught(senditAdapter.createShipment!(input, creds, {}));
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
    });
  });

  describe("fetchStatus / fetchTracking — PROVISIONAL mapping, raw status kept", () => {
    it("GET /deliveries/{code} → raw status verbatim + provisional local status", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries/DABC1234" && r.method === "GET" ? ok(deliveryDetail({ status: "DELIVERED", fee: 30 })) : undefined
      );
      const res = await senditAdapter.fetchStatus!({ externalId: "DABC1234" }, creds, {});
      expect(res).toEqual({ rawStatus: "DELIVERED", trackingUrl: null, cost: 30 });
      expect(senditAdapter.mapStatus!(res.rawStatus)).toBe("LIVRE");
    });

    it("status_return is kept in the raw string and RETURN_STOCK takes precedence", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries/D2" ? ok(deliveryDetail({ code: "D2", status: "REJECTED", status_return: "RETURN_STOCK" })) : undefined
      );
      const res = await senditAdapter.fetchStatus!({ externalId: "D2" }, creds, {});
      expect(res.rawStatus).toBe("REJECTED/RETURN_STOCK");
      expect(senditAdapter.mapStatus!(res.rawStatus)).toBe("RETOURNE");
    });

    it("unknown status → null (caller keeps the raw string)", () => {
      expect(senditAdapter.mapStatus!("SOMETHING_NEW")).toBeNull();
      expect(senditAdapter.mapStatus!("PICKEDUP")).toBe("EN_TRANSIT");
    });

    it("missing status → malformed (never guessed)", async () => {
      state.routes.push((r) => (path(r) === "deliveries/D3" ? ok(deliveryDetail({ code: "D3", status: null })) : undefined));
      expect(await caught(senditAdapter.fetchStatus!({ externalId: "D3" }, creds, {}))).toBeInstanceOf(
        DeliveryMalformedResponseError
      );
    });

    it("encodes the parcel code in the path", async () => {
      state.routes.push((r) => (path(r) !== "login" ? ok(deliveryDetail({ code: "a/b" })) : undefined));
      await senditAdapter.fetchStatus!({ externalId: "a/b" }, creds, {});
      expect(nonLogin()[0].url).toContain("/deliveries/a%2Fb");
    });

    it("tracking: audits → events (consecutive duplicates dropped), no fabricated timestamp", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries/D4"
          ? ok(
              deliveryDetail({
                code: "D4",
                status: "TRANSIT",
                audits: [
                  { data: { status: "PENDING" }, event: "created", created_at: "lundi 1 octobre 2026, à 10:00" },
                  { data: { status: "PENDING" }, event: "updated" },
                  { data: { status: "PICKEDUP" }, event: "updated" },
                  { data: { status: "TRANSIT", status_return: "RETOUR_PENDING" }, event: "updated" },
                  { event: "updated" },
                ],
              })
            )
          : undefined
      );
      const t = await senditAdapter.fetchTracking!({ externalId: "D4" }, creds, {});
      expect(t.rawStatus).toBe("TRANSIT");
      expect(t.events.map((e) => e.rawStatus)).toEqual(["PENDING", "PICKEDUP", "TRANSIT/RETOUR_PENDING"]);
      expect(t.events[0]).toEqual({
        rawStatus: "PENDING",
        label: "En attente",
        description: "lundi 1 octobre 2026, à 10:00",
        location: null,
        timestamp: null,
      });
      expect(t.courier).toBeNull();
      expect(t.lastUpdateAt).toBeNull();
    });
  });

  describe("listCities — GET /districts, paginated", () => {
    it("follows pages up to last_page and passes pickup-district when configured", async () => {
      state.routes.push((r) => {
        if (path(r) !== "districts") return undefined;
        const page = Number(new URL(r.url).searchParams.get("page"));
        const rows = [{ id: String(page * 10), ville: "Ville", name: `Quartier ${page}`, price: "19" }];
        return ok(rows, { current_page: page, last_page: 3, per_page: 1, total: 3, next_page_url: page < 3 ? "http://x?page=2" : null });
      });
      const cities = await senditAdapter.listCities!(creds, { pickupDistrictId: 46 });
      expect(cities.map((c) => c.id)).toEqual(["10", "20", "30"]);
      expect(cities[0]).toEqual({ id: "10", name: "Quartier 1", region: "Ville" });
      const reads = nonLogin();
      expect(reads).toHaveLength(3);
      for (const r of reads) expect(new URL(r.url).searchParams.get("pickup-district")).toBe("46");
    });

    it("without last_page, stops when there is no next page", async () => {
      state.routes.push((r) => (path(r) === "districts" ? ok([{ id: 1, name: "A" }]) : undefined));
      const cities = await senditAdapter.listCities!(creds, {});
      expect(cities).toHaveLength(1);
      expect(nonLogin()).toHaveLength(1);
      expect(new URL(nonLogin()[0].url).searchParams.has("pickup-district")).toBe(false);
    });
  });

  describe("fetchLabel — https only, on demand", () => {
    it("POST /deliveries/getlabels → https fileUrl", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries/getlabels" ? ok({ filePrint: true, fileUrl: "https://app.sendit.ma/f.pdf?signature=s" }) : undefined
      );
      const { url } = await senditAdapter.fetchLabel!({ externalId: "D1" }, creds, {});
      expect(url).toBe("https://app.sendit.ma/f.pdf?signature=s");
      const req = nonLogin()[0];
      expect(req.method).toBe("POST");
      expect(req.body).toEqual({ codesToPrint: "D1", printFormat: 1 });
      expect(req.headers["authorization"]).toBe(`Bearer ${FAKE_SENDIT_TOKEN}`);
    });

    it("uses the configured printFormat", async () => {
      state.routes.push((r) => (path(r) === "deliveries/getlabels" ? ok({ fileUrl: "https://app.sendit.ma/signed-files/a?signature=s" }) : undefined));
      await senditAdapter.fetchLabel!({ externalId: "D1" }, creds, { labelPrintFormat: 2 });
      expect(nonLogin()[0].body).toEqual({ codesToPrint: "D1", printFormat: 2 });
    });

    it("an http fileUrl is refused; falls back to the parcel's https labelUrl", async () => {
      state.routes.push((r) => (path(r) === "deliveries/getlabels" ? ok({ fileUrl: "http://insecure.test/a.pdf" }) : undefined));
      state.routes.push((r) => (path(r) === "deliveries/D1" ? ok(deliveryDetail({ code: "D1" })) : undefined));
      const { url } = await senditAdapter.fetchLabel!({ externalId: "D1" }, creds, {});
      expect(url.startsWith("https://")).toBe(true);
    });

    it("an https link on a host other than app.sendit.ma is refused (getlabels and labelUrl alike)", async () => {
      state.routes.push((r) =>
        path(r) === "deliveries/getlabels" ? ok({ fileUrl: "https://evil.example/a.pdf?signature=s" }) : undefined
      );
      state.routes.push((r) =>
        path(r) === "deliveries/D1"
          ? ok(deliveryDetail({ code: "D1", labelUrl: "https://app.sendit.ma.evil.example/l.pdf" }))
          : undefined
      );
      expect(await caught(senditAdapter.fetchLabel!({ externalId: "D1" }, creds, {}))).toBeInstanceOf(
        DeliveryMalformedResponseError
      );
    });

    it("an off-host fileUrl falls back to the parcel's app.sendit.ma labelUrl", async () => {
      state.routes.push((r) => (path(r) === "deliveries/getlabels" ? ok({ fileUrl: "https://cdn.other.example/a.pdf" }) : undefined));
      state.routes.push((r) => (path(r) === "deliveries/D1" ? ok(deliveryDetail({ code: "D1" })) : undefined));
      const { url } = await senditAdapter.fetchLabel!({ externalId: "D1" }, creds, {});
      expect(new URL(url).hostname).toBe("app.sendit.ma");
    });

    it("no https link anywhere → malformed error", async () => {
      state.routes.push((r) => (path(r) === "deliveries/getlabels" ? ok({ fileUrl: "http://insecure.test/a.pdf" }) : undefined));
      state.routes.push((r) =>
        path(r) === "deliveries/D1" ? ok(deliveryDetail({ code: "D1", labelUrl: "http://insecure.test/l.pdf" })) : undefined
      );
      expect(await caught(senditAdapter.fetchLabel!({ externalId: "D1" }, creds, {}))).toBeInstanceOf(
        DeliveryMalformedResponseError
      );
    });
  });
});
