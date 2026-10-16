import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import {
  __setAmeexClientOptionsForTests,
  ameexAdapter,
  AMEEX_BLOCKED_CAPABILITIES,
  AMEEX_VERIFICATION,
  AMEEX_WEBHOOK_SANDBOX_TOPIC,
  AMEEX_WEBHOOK_TOPIC,
} from "@/lib/integrations/delivery/providers/ameex/adapter";
import { registerAmeexProvider } from "@/lib/integrations/delivery/providers/ameex";
import { AmeexRateLimiter } from "@/lib/integrations/delivery/providers/ameex/client";
import { webhookEventId } from "@/lib/integrations/delivery/providers/ameex/webhook";
import {
  __resetDeliveryProviderRegistryForTests,
  assertCapability,
  getDeliveryProvider,
  listDeliveryProviders,
} from "@/lib/integrations/delivery/registry";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
  DeliveryUnsupportedCapabilityError,
} from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";
import {
  ameexFixture,
  ameexWebhookBody,
  emptyFakeAmeexState,
  FAKE_AMEEX_API_ID,
  FAKE_AMEEX_LIVE_KEY,
  FAKE_AMEEX_SANDBOX_KEY,
  FAKE_AMEEX_WEBHOOK_SECRET,
  installFakeAmeex,
  signAmeex,
  type FakeAmeexState,
} from "../helpers/fake-ameex";

let state: FakeAmeexState;
let fetchMock: ReturnType<typeof installFakeAmeex>;

describe("ameexAdapter", () => {
  beforeEach(() => {
    state = emptyFakeAmeexState();
    fetchMock = installFakeAmeex(state);
    __setAmeexClientOptionsForTests({ rateLimiter: new AmeexRateLimiter(), sleep: async () => {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __setAmeexClientOptionsForTests(null);
  });

  // Until 2026-10-16 these tests pinned the SCAFFOLD state (WEBHOOKS only,
  // no create/status/cities method, mapStatus always null, testConnection
  // reading no field). The owner-authorized sandbox calls of 2026-10-16
  // documented those shapes, so they now pin the sandbox-verified contract
  // instead (tests/fixtures/ameex/sandbox-responses-2026-10-16.json).
  describe("identity and capabilities", () => {
    it("has the expected key / name / verification marker (sandbox only)", () => {
      expect(ameexAdapter.key).toBe("ameex");
      expect(ameexAdapter.displayName).toBe("Ameex (Maroc)");
      expect(AMEEX_VERIFICATION).toBe("SANDBOX_VERIFIED_2026_10_16");
      expect(ameexAdapter.acceptsNewConnections).toBe(true);
      expect(ameexAdapter.notice).toMatch(/bac à sable/);
    });

    it("declares the sandbox-verified capabilities, keeps WEBHOOKS", () => {
      expect([...ameexAdapter.capabilities].sort()).toEqual([
        "CREATE_SHIPMENT",
        "FETCH_CITIES",
        "FETCH_STATUS",
        "FETCH_TRACKING",
        "WEBHOOKS",
      ]);
      expect(ameexAdapter.createShipment).toBeTypeOf("function");
      expect(ameexAdapter.fetchStatus).toBeTypeOf("function");
      expect(ameexAdapter.fetchTracking).toBeTypeOf("function");
      expect(ameexAdapter.listCities).toBeTypeOf("function");
    });

    it("cancellation / labels / manifest / prices stay blocked (undocumented)", () => {
      for (const blocked of ["CANCEL_SHIPMENT", "GENERATE_MANIFEST", "FETCH_COST", "FETCH_LABEL"] as const) {
        expect(ameexAdapter.capabilities).not.toContain(blocked);
        expect(() => assertCapability(ameexAdapter, blocked)).toThrow(DeliveryUnsupportedCapabilityError);
      }
      expect(ameexAdapter.cancelShipment).toBeUndefined();
      expect(ameexAdapter.generateManifest).toBeUndefined();
      expect(ameexAdapter.fetchLabel).toBeUndefined();
    });

    it("lists every remaining blocked capability with a reason, none of them declared", () => {
      const names = AMEEX_BLOCKED_CAPABILITIES.map((b) => b.capability);
      expect([...names].sort()).toEqual(["CANCEL_SHIPMENT", "FETCH_COST", "FETCH_LABEL", "GENERATE_MANIFEST", "MASS_TRACKING"]);
      for (const b of AMEEX_BLOCKED_CAPABILITIES) {
        expect(b.reason.length).toBeGreaterThan(10);
        expect(ameexAdapter.capabilities).not.toContain(b.capability);
      }
    });

    it("maps statuses through the provisional table (see ameex-status.test.ts)", () => {
      expect(ameexAdapter.mapStatus!("DELIVERED")).toBe("LIVRE");
      expect(ameexAdapter.mapStatus!("IN_PROGRESS/REFUSE")).toBe("ECHEC");
      expect(ameexAdapter.mapStatus!("REFUNDED")).toBeNull();
      expect(ameexAdapter.mapStatus!("UNKNOWN_CODE")).toBeNull();
    });

    it("declares the three credential fields (API Id, API key secret, webhook secret secret)", () => {
      const fields = ameexAdapter.credentialFields!;
      expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
        ["apiId", "text", true],
        ["apiKey", "password", true],
        ["webhookSecret", "password", false],
      ]);
      expect(fields[2].help).toMatch(/refusés/);
    });
  });

  describe("testConnection", () => {
    const live = { apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_LIVE_KEY };
    beforeEach(() => {
      state.successBody = ameexFixture.statuts;
    });

    it("GETs the status catalogue with header auth and reports mode + catalogue size", async () => {
      await expect(ameexAdapter.testConnection(live, {})).resolves.toEqual({
        ok: true,
        details: { mode: "production", statuts: 36 },
      });
      expect(state.requests).toHaveLength(1);
      expect(state.requests[0].method).toBe("GET");
      expect(state.requests[0].url).toBe("https://api.ameex.app/customer/Delivery/Parcels/Statuts");
      expect(state.requests[0].headers["c-api-id"]).toBe(FAKE_AMEEX_API_ID);
      expect(state.requests[0].headers["c-api-key"]).toBe(FAKE_AMEEX_LIVE_KEY);
    });

    it("detects a sandbox key (test_ prefix)", async () => {
      const r = await ameexAdapter.testConnection({ apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_SANDBOX_KEY }, {});
      expect(r.details).toEqual({ mode: "sandbox", statuts: 36 });
    });

    it("validates the envelope now that it is known: an opaque body is NOT a success", async () => {
      // Scaffold behaviour was « any JSON = success »; the sandbox showed the
      // real envelope, so an unrecognizable body is now malformed.
      for (const successBody of [[], {}, null, "text", 0, { data: { secret: "x" } }]) {
        state.successBody = successBody;
        await expect(ameexAdapter.testConnection(live, {})).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
      }
    });

    it("login ≠ success (HTTP 200) → DeliveryAuthError", async () => {
      state.successBody = { login: "error", api: { type: "error", msg: "bad key" } };
      await expect(ameexAdapter.testConnection(live, {})).rejects.toBeInstanceOf(DeliveryAuthError);
    });

    it("401/403 → DeliveryAuthError without the key in the message", async () => {
      for (const status of [401, 403]) {
        state.fault = { kind: "status", status };
        const err = await ameexAdapter.testConnection(live, {}).catch((e: Error) => e);
        expect(err).toBeInstanceOf(DeliveryAuthError);
        expect((err as Error).message).not.toContain(FAKE_AMEEX_LIVE_KEY);
      }
    });

    it("a non-JSON 2xx is not a success", async () => {
      state.fault = { kind: "malformed" };
      await expect(ameexAdapter.testConnection(live, {})).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
    });

    it("refuses incomplete credentials / bad config before any request", async () => {
      await expect(ameexAdapter.testConnection({ apiId: FAKE_AMEEX_API_ID }, {})).rejects.toBeInstanceOf(DeliveryConfigError);
      await expect(ameexAdapter.testConnection({ apiId: "", apiKey: FAKE_AMEEX_LIVE_KEY }, {})).rejects.toBeInstanceOf(DeliveryConfigError);
      await expect(ameexAdapter.testConnection(live, { requestTimeoutMs: "x" })).rejects.toBeInstanceOf(DeliveryConfigError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("listCities", () => {
    it("GET /Delivery/Cities → every sandbox city with its numeric id", async () => {
      state.successBody = ameexFixture.cities;
      const cities = await ameexAdapter.listCities!({ apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_SANDBOX_KEY }, {});
      expect(state.requests[0].url).toBe("https://api.ameex.app/customer/Delivery/Cities");
      expect(cities.length).toBe(Object.keys(ameexFixture.cities.api.cities).length);
      expect(cities).toContainEqual({ id: "129", name: "Casablanca", region: null });
    });
  });

  describe("createShipment", () => {
    const creds = { apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_SANDBOX_KEY };
    const input: CreateShipmentAdapterInput = {
      localShipmentId: "shp_1",
      orderNumber: "ASD-SBX-1",
      recipientName: "Test ASODITECH",
      addressLine1: "Adresse de test",
      addressLine2: null,
      city: "Casablanca",
      resolvedProviderCityId: "129",
      region: null,
      country: "MA",
      phone: "0600000000",
      codAmount: 100,
      currency: "MAD",
      notes: null,
      parcelContents: "Produit test",
    };

    it("POSTs form-encoded (never JSON) once and returns data.code", async () => {
      state.successBody = ameexFixture.add_form_success;
      const r = await ameexAdapter.createShipment!(input, creds, {});
      expect(r).toEqual({ externalId: "SBX-51464E10", trackingNumber: "SBX-51464E10", trackingUrl: null, cost: null, rawStatus: null });
      expect(state.requests).toHaveLength(1);
      const req = state.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("https://api.ameex.app/customer/Delivery/Parcels/Action/Type/Add");
      expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(() => JSON.parse(req.body!)).toThrow();
      expect(Object.fromEntries(new URLSearchParams(req.body!))).toEqual({
        type: "SIMPLE",
        receiver: "Test ASODITECH",
        phone: "0600000000",
        city: "129",
        cod: "100",
        address: "Adresse de test",
        product: "Produit test",
        order_num: "ASD-SBX-1",
      });
    });

    it("api.type error (HTTP 200, e.g. unknown city) → definite DeliveryConfigError, no retry", async () => {
      state.successBody = ameexFixture.add_form_unknown_city;
      const err = await ameexAdapter.createShipment!(input, creds, {}).catch((e: Error) => e);
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect((err as Error).message).toMatch(/ville inconnue/);
      expect(state.requests).toHaveLength(1);
    });

    it("uncertain outcomes → DeliveryOutcomeUnknownError after ONE attempt", async () => {
      const faults: FakeAmeexState["fault"][] = [
        { kind: "status", status: 500 },
        { kind: "status", status: 429 },
        { kind: "network", code: "ECONNRESET" },
        { kind: "malformed" },
      ];
      for (const fault of faults) {
        state.requests = [];
        state.fault = fault;
        await expect(ameexAdapter.createShipment!(input, creds, {})).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
        expect(state.requests).toHaveLength(1);
      }
      // A success envelope without a parcel code: the parcel may exist.
      state.fault = undefined;
      state.requests = [];
      state.successBody = { login: "success", api: { type: "success", msg: "", data: {} } };
      await expect(ameexAdapter.createShipment!(input, creds, {})).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(state.requests).toHaveLength(1);
    });

    it("a hanging Add times out as an UNKNOWN outcome (never retried)", async () => {
      state.fault = { kind: "hang" };
      await expect(ameexAdapter.createShipment!(input, creds, { requestTimeoutMs: 1_000 })).rejects.toBeInstanceOf(
        DeliveryOutcomeUnknownError
      );
      expect(state.requests).toHaveLength(1);
    }, 5_000);

    it("refuses an unmapped city before sending anything", async () => {
      await expect(ameexAdapter.createShipment!({ ...input, resolvedProviderCityId: null }, creds, {})).rejects.toBeInstanceOf(
        DeliveryConfigError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("fetchStatus / fetchTracking", () => {
    const creds = { apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_SANDBOX_KEY };

    it("GET tracking/{code} → raw status of the latest event", async () => {
      state.successBody = ameexFixture.tracking;
      await expect(ameexAdapter.fetchStatus!({ externalId: "SBX-51464E10" }, creds, {})).resolves.toEqual({
        rawStatus: "NEW_PARCEL",
        trackingUrl: null,
        cost: null,
      });
      expect(state.requests[0].method).toBe("GET");
      expect(state.requests[0].url).toBe("https://api.ameex.app/customer/Delivery/Parcels/Tracking/ParcelCode/SBX-51464E10");
    });

    it("latest by sorting_time, sub-status kept in the raw string", async () => {
      const body = JSON.parse(JSON.stringify(ameexFixture.tracking)) as typeof ameexFixture.tracking;
      const base = body.api.tracking[0];
      body.api.tracking = [
        { ...base, statut: "IN_PROGRESS", statut_s: "REFUSE", statut_s_name: "Refusé", sorting_time: 1792300000 },
        base,
      ];
      state.successBody = body;
      const r = await ameexAdapter.fetchTracking!({ externalId: "SBX-51464E10" }, creds, {});
      expect(r.rawStatus).toBe("IN_PROGRESS/REFUSE");
      expect(r.events.map((e) => e.rawStatus)).toEqual(["NEW_PARCEL", "IN_PROGRESS/REFUSE"]);
      expect(r.lastUpdateAt).toBe(new Date(1792300000 * 1000).toISOString());
      expect(r.courier).toBeNull();
      expect(ameexAdapter.mapStatus!(r.rawStatus)).toBe("ECHEC");
    });

    it("an Ameex error envelope on tracking → typed error (not a status)", async () => {
      state.successBody = { login: "success", api: { type: "error", msg: "Parcel not found" } };
      await expect(ameexAdapter.fetchStatus!({ externalId: "SBX-NOPE" }, creds, {})).rejects.toBeInstanceOf(DeliveryConfigError);
    });
  });

  describe("webhooks", () => {
    const t = Math.floor(Date.now() / 1000);
    const body = ameexWebhookBody({ CODE: "AMX-FAKE42", STATUT: "DELIVERED", STATUT_NAME: "Livré", COMMENT: "" });

    it("verifyWebhookSignature uses the documented scheme with the current clock", () => {
      const headers = { "x-ameex-signature": signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t) };
      expect(ameexAdapter.verifyWebhookSignature!(body, headers, FAKE_AMEEX_WEBHOOK_SECRET)).toBe(true);
      expect(ameexAdapter.verifyWebhookSignature!(body, headers, "wrong-fake-secret")).toBe(false);
      expect(ameexAdapter.verifyWebhookSignature!(body, headers, "")).toBe(false);
      expect(ameexAdapter.verifyWebhookSignature!(body, {}, FAKE_AMEEX_WEBHOOK_SECRET)).toBe(false);
    });

    it("mapWebhookPayload: CODE → externalId, STATUT → rawStatus, deliveryId from t + raw body", () => {
      const headers = { "X-Ameex-Signature": signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t) };
      expect(ameexAdapter.mapWebhookPayload!(body, headers)).toEqual({
        deliveryId: webhookEventId(body, String(t)),
        topic: AMEEX_WEBHOOK_TOPIC,
        externalId: "AMX-FAKE42",
        rawStatus: "DELIVERED",
      });
    });

    it("tags a sandbox event with its own topic", () => {
      const sbx = ameexWebhookBody({ CODE: "SBX-FAKE1", STATUT: "DELIVERED", SANDBOX: "1" });
      const headers = { "x-ameex-signature": signAmeex(sbx, FAKE_AMEEX_WEBHOOK_SECRET, t) };
      expect(ameexAdapter.mapWebhookPayload!(sbx, headers)?.topic).toBe(AMEEX_WEBHOOK_SANDBOX_TOPIC);
    });

    it("returns null without CODE / STATUT or without a signature header", () => {
      const noCode = ameexWebhookBody({ STATUT: "DELIVERED" });
      expect(ameexAdapter.mapWebhookPayload!(noCode, { "x-ameex-signature": signAmeex(noCode, FAKE_AMEEX_WEBHOOK_SECRET, t) })).toBeNull();
      expect(ameexAdapter.mapWebhookPayload!(body, {})).toBeNull();
    });
  });

  describe("webhook → authoritative re-fetch (adapter level)", () => {
    // handleDeliveryWebhook re-fetches through syncShipmentStatus, which
    // requires FETCH_STATUS. In the scaffold Ameex lacked it, so a verified
    // webhook ended in an « error » sync; it now ends in a real fetch.
    it("verified event → FETCH_STATUS allowed → fetchStatus(CODE) → mapped status", async () => {
      const t = Math.floor(Date.now() / 1000);
      const body = ameexWebhookBody({ CODE: "SBX-51464E10", STATUT: "NEW_PARCEL", STATUT_NAME: "Nouveau Colis", SANDBOX: "1" });
      const headers = { "x-ameex-signature": signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t) };
      const creds = { apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_SANDBOX_KEY, webhookSecret: FAKE_AMEEX_WEBHOOK_SECRET };

      expect(ameexAdapter.verifyWebhookSignature!(body, headers, FAKE_AMEEX_WEBHOOK_SECRET)).toBe(true);
      const event = ameexAdapter.mapWebhookPayload!(body, headers)!;
      expect(ameexAdapter.shouldIgnoreWebhookEvent!(event, creds)).toBeNull();
      expect(() => assertCapability(ameexAdapter, "FETCH_STATUS")).not.toThrow();

      state.successBody = ameexFixture.tracking;
      const fetched = await ameexAdapter.fetchStatus!({ externalId: event.externalId! }, creds, {});
      expect(state.requests.map((r) => r.url)).toEqual([
        "https://api.ameex.app/customer/Delivery/Parcels/Tracking/ParcelCode/SBX-51464E10",
      ]);
      expect(ameexAdapter.mapStatus!(fetched.rawStatus)).toBe("EN_ATTENTE");
    });

    it("composes STATUT/STATUT_S like the tracking read", () => {
      const t = Math.floor(Date.now() / 1000);
      const body = ameexWebhookBody({ CODE: "AMX-1", STATUT: "IN_PROGRESS", STATUT_S: "NO_ANSWER" });
      const headers = { "x-ameex-signature": signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t) };
      expect(ameexAdapter.mapWebhookPayload!(body, headers)?.rawStatus).toBe("IN_PROGRESS/NO_ANSWER");
    });
  });

  describe("registration", () => {
    afterEach(() => __resetDeliveryProviderRegistryForTests());

    it("registerAmeexProvider is idempotent", () => {
      __resetDeliveryProviderRegistryForTests();
      registerAmeexProvider();
      registerAmeexProvider();
      expect(getDeliveryProvider("ameex")).toBe(ameexAdapter);
      expect(listDeliveryProviders().filter((a) => a.key === "ameex")).toHaveLength(1);
    });

    // Was « is NOT wired into the production bootstrap » (scaffold). Ameex
    // is now registered there (sandbox-verified 2026-10-16).
    it("is wired into the production bootstrap", () => {
      const bootstrap = readFileSync(
        path.resolve(import.meta.dirname, "../../src/lib/integrations/delivery/providers/index.ts"),
        "utf8"
      );
      expect(bootstrap).toMatch(/^registerAmeexProvider\(\);$/m);
    });
  });
});
