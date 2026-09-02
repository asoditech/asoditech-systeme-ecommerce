import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ozonExpressAdapter,
  OZONEXPRESS_PROVIDER_KEY,
  OZONEXPRESS_VERIFICATION,
} from "@/lib/integrations/delivery/providers/ozonexpress";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
} from "@/lib/integrations/delivery/errors";
import { assertCapability } from "@/lib/integrations/delivery/registry";
import {
  installFakeOzonExpress,
  emptyFakeOzonExpressState,
  FAKE_OZ_API_KEY,
  FAKE_OZ_CUSTOMER_ID,
  FAKE_OZ_BASE_URL,
  type FakeOzonExpressState,
} from "../helpers/fake-ozonexpress";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

const credentials = { customerId: FAKE_OZ_CUSTOMER_ID, apiKey: FAKE_OZ_API_KEY };
const config = { baseUrl: FAKE_OZ_BASE_URL, requestTimeoutMs: 1000 };

const shipmentInput: CreateShipmentAdapterInput = {
  localShipmentId: "ship_1",
  orderNumber: "1042",
  recipientName: "Amine Tazi",
  addressLine1: "12 rue Hassan II",
  addressLine2: null,
  city: "Casablanca",
  region: null,
  country: "MA",
  phone: "0612345678",
  codAmount: 250,
  currency: "MAD",
  notes: null,
};

let state: FakeOzonExpressState;
const addParcelCalls = () => state.seenUrls.filter((u) => u.includes("/add-parcel"));

describe("ozonExpressAdapter (fixture)", () => {
  beforeEach(() => {
    state = emptyFakeOzonExpressState();
    installFakeOzonExpress(state);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tracking is live-verified; add-parcel / cities are not", () => {
    expect(OZONEXPRESS_VERIFICATION).toBe("TRACKING_LIVE_VERIFIED");
    expect(ozonExpressAdapter.key).toBe(OZONEXPRESS_PROVIDER_KEY);
    expect(ozonExpressAdapter.displayName).toBe("OzonExpress (Maroc)");
  });

  it("declares only the capabilities the documentation supports", () => {
    expect([...ozonExpressAdapter.capabilities].sort()).toEqual(["CREATE_SHIPMENT", "FETCH_COST", "FETCH_STATUS", "GENERATE_MANIFEST"]);
    expect(() => assertCapability(ozonExpressAdapter, "CANCEL_SHIPMENT")).toThrow();
    expect(() => assertCapability(ozonExpressAdapter, "WEBHOOKS")).toThrow();
  });

  it("exposes typed credential fields for the config UI (customerId + apiKey, no invented fields)", () => {
    expect(ozonExpressAdapter.credentialFields?.map((f) => f.name)).toEqual(["customerId", "apiKey"]);
    expect(ozonExpressAdapter.credentialFields?.find((f) => f.name === "apiKey")?.type).toBe("password");
  });

  describe("listCities (GET /cities)", () => {
    it("returns the parsed destination catalogue", async () => {
      const cities = await ozonExpressAdapter.listCities!(credentials, config);
      expect(cities.map((c) => c.name)).toContain("Casablanca");
      expect(cities.find((c) => c.name === "Rabat")?.id).toBe("2");
    });

    it("parses a bare-array envelope too", async () => {
      state.citiesEnvelope = "bare-array";
      const cities = await ozonExpressAdapter.listCities!(credentials, config);
      expect(cities.length).toBeGreaterThan(0);
    });
  });

  describe("testConnection — safe verification path (never creates a parcel)", () => {
    it("succeeds with valid credentials, reporting CHECK_API's message and the city count", async () => {
      const result = await ozonExpressAdapter.testConnection(credentials, config);
      expect(result.ok).toBe(true);
      expect(result.details?.["authentification"]).toBe("Valide API Key");
      expect(result.details?.["villes desservies"]).toBe(4);
      expect(addParcelCalls()).toHaveLength(0);
    });

    it("still succeeds (auth proven via CHECK_API) when the city catalogue is unavailable", async () => {
      state.forceCitiesHttpStatus = 500;
      const result = await ozonExpressAdapter.testConnection(credentials, config);
      expect(result.ok).toBe(true);
      expect(result.details?.["authentification"]).toBe("Valide API Key");
      expect(result.details?.["villes desservies"]).toBeUndefined();
      expect(addParcelCalls()).toHaveLength(0);
    });

    it("fails with DeliveryAuthError on bad credentials (CHECK_API RESULT:ERROR)", async () => {
      await expect(
        ozonExpressAdapter.testConnection({ customerId: "x", apiKey: "y" }, config)
      ).rejects.toBeInstanceOf(DeliveryAuthError);
    });

    it("fails with DeliveryAuthError when CHECK_API reports an account problem", async () => {
      state.forceCheckApiErrorMessage = "API Key désactivée";
      await expect(ozonExpressAdapter.testConnection(credentials, config)).rejects.toBeInstanceOf(DeliveryAuthError);
    });

    it("fails with DeliveryConfigError on incomplete credentials, before any network call", async () => {
      vi.unstubAllGlobals();
      await expect(
        ozonExpressAdapter.testConnection({ customerId: "only-this" }, config)
      ).rejects.toBeInstanceOf(DeliveryConfigError);
    });

    it("surfaces an unclassified OzonExpress account error verbatim (the operator's diagnostic)", async () => {
      state.forcePathErrorMessage = "Compte marchand suspendu — contactez OzonExpress";
      await expect(
        ozonExpressAdapter.testConnection(credentials, config)
      ).rejects.toThrow(/Compte marchand suspendu/);
    });
  });

  describe("createShipment", () => {
    it("resolves the city from GET /cities, then persists exactly what OzonExpress returned", async () => {
      const result = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      expect(result.externalId).toBeTruthy();
      expect(result.trackingNumber).toBe(result.externalId);
      expect(result.trackingUrl).toBeNull();
      expect(result.cost).toBe(25);
      expect(result.rawStatus).toBe("Nouveau colis");
    });

    it("accepts a config cityIdByName override when the catalogue spells the city differently", async () => {
      const result = await ozonExpressAdapter.createShipment!(
        { ...shipmentInput, city: "Casa" },
        credentials,
        { ...config, cityIdByName: { Casa: 1 } }
      );
      expect(result.externalId).toBeTruthy();
    });

    it("reads the nested ADD-PARCEL.NEW-PARCEL envelope variant too", async () => {
      state.nestSuccessEnvelope = true;
      const result = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      expect(result.cost).toBe(25);
    });

    it("falls back to the city's authoritative DELIVERED-PRICE when add-parcel returns no cost", async () => {
      state.omitAddParcelPrice = true;
      // shipmentInput.city === "Casablanca" -> fake catalogue DELIVERED-PRICE 20
      const result = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      expect(result.cost).toBe(20);
    });

    it("refuses (typed config error, NO add-parcel call) a city not in the catalogue or the override", async () => {
      await expect(
        ozonExpressAdapter.createShipment!({ ...shipmentInput, city: "Ville Inexistante" }, credentials, config)
      ).rejects.toBeInstanceOf(DeliveryConfigError);
      expect(addParcelCalls()).toHaveLength(0);
    });

    it("surfaces an OzonExpress 'City Not Found' application error as a typed config error", async () => {
      state.forceAddParcelErrorMessage = "City Not Found";
      await expect(
        ozonExpressAdapter.createShipment!(shipmentInput, credentials, config)
      ).rejects.toBeInstanceOf(DeliveryConfigError);
    });

    it("throws (never returns a fake success) when OzonExpress omits the tracking number", async () => {
      state.omitTrackingNumber = true;
      await expect(
        ozonExpressAdapter.createShipment!(shipmentInput, credentials, config)
      ).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
    });

    it("uses the local shipment id as the custom tracking number (idempotent retry)", async () => {
      await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      await expect(
        ozonExpressAdapter.createShipment!(shipmentInput, credentials, config)
      ).rejects.toThrow();
      expect(state.parcels.size).toBe(1);
    });
  });

  describe("fetchStatus + mapStatus", () => {
    it("fetches the raw status and maps it via the adapter's own table", async () => {
      const created = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      state.parcels.get(created.externalId)!.status = "Livré";

      const fetched = await ozonExpressAdapter.fetchStatus!({ externalId: created.externalId }, credentials, config);
      expect(fetched.rawStatus).toBe("Livré");
      expect(ozonExpressAdapter.mapStatus!(fetched.rawStatus)).toBe("LIVRE");
    });

    it("returns null from mapStatus for an unrecognized raw status (caller preserves it)", async () => {
      const created = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      state.parcels.get(created.externalId)!.status = "Colis en zone de tri";
      const fetched = await ozonExpressAdapter.fetchStatus!({ externalId: created.externalId }, credentials, config);
      expect(ozonExpressAdapter.mapStatus!(fetched.rawStatus)).toBeNull();
    });
  });
});
