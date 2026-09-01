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
const config = { baseUrl: FAKE_OZ_BASE_URL, cityIdByName: { Casablanca: 1, Rabat: 2 }, requestTimeoutMs: 1000 };

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

describe("ozonExpressAdapter (fixture)", () => {
  beforeEach(() => {
    state = emptyFakeOzonExpressState();
    installFakeOzonExpress(state);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is not verified and not production-registered", () => {
    expect(OZONEXPRESS_VERIFICATION).toBe("UNVERIFIED");
    expect(ozonExpressAdapter.key).toBe(OZONEXPRESS_PROVIDER_KEY);
    expect(ozonExpressAdapter.displayName).toMatch(/non vérifié/i);
  });

  it("declares only the capabilities OzonExpress actually supports", () => {
    expect([...ozonExpressAdapter.capabilities].sort()).toEqual(["CREATE_SHIPMENT", "FETCH_COST", "FETCH_STATUS"]);
    expect(() => assertCapability(ozonExpressAdapter, "CANCEL_SHIPMENT")).toThrow();
    expect(() => assertCapability(ozonExpressAdapter, "WEBHOOKS")).toThrow();
  });

  it("exposes typed credential fields for the config UI (customerId + apiKey, no invented fields)", () => {
    expect(ozonExpressAdapter.credentialFields?.map((f) => f.name)).toEqual(["customerId", "apiKey"]);
    expect(ozonExpressAdapter.credentialFields?.find((f) => f.name === "apiKey")?.type).toBe("password");
  });

  describe("testConnection", () => {
    it("succeeds against valid credentials (sentinel lookup authenticates)", async () => {
      await expect(ozonExpressAdapter.testConnection(credentials, config)).resolves.toEqual({ ok: true });
    });

    it("fails with DeliveryAuthError on bad credentials", async () => {
      await expect(
        ozonExpressAdapter.testConnection({ customerId: "x", apiKey: "y" }, config)
      ).rejects.toBeInstanceOf(DeliveryAuthError);
    });

    it("fails with DeliveryConfigError on incomplete credentials, before any network call", async () => {
      vi.unstubAllGlobals(); // prove no fetch happens
      await expect(
        ozonExpressAdapter.testConnection({ customerId: "only-this" }, config)
      ).rejects.toBeInstanceOf(DeliveryConfigError);
    });
  });

  describe("createShipment", () => {
    it("returns exactly what OzonExpress returned — real tracking number, real cost, never fabricated", async () => {
      const result = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      expect(result.externalId).toBeTruthy();
      expect(result.trackingNumber).toBe(result.externalId);
      expect(result.trackingUrl).toBeNull(); // no documented URL pattern
      expect(result.cost).toBe(25);
      expect(result.rawStatus).toBe("Nouveau colis");
    });

    it("reads the nested ADD-PARCEL.NEW-PARCEL envelope variant too", async () => {
      state.nestSuccessEnvelope = true;
      const result = await ozonExpressAdapter.createShipment!(shipmentInput, credentials, config);
      expect(result.externalId).toBeTruthy();
      expect(result.cost).toBe(25);
    });

    it("refuses (typed config error, no network call) an order whose city has no configured OzonExpress id", async () => {
      await expect(
        ozonExpressAdapter.createShipment!({ ...shipmentInput, city: "Ifrane" }, credentials, config)
      ).rejects.toBeInstanceOf(DeliveryConfigError);
      expect(state.seenUrls).toHaveLength(0);
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
      // OzonExpress rejects a duplicate custom tracking number -> typed error, not a 2nd parcel.
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
