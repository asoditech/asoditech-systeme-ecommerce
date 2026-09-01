import { describe, expect, it } from "vitest";
import {
  buildAddParcelForm,
  mapOzonExpressStatus,
  normalizeMoroccanPhone,
  parseAddParcelResponse,
  parseTrackingResponse,
  resolveCityId,
} from "@/lib/integrations/delivery/providers/ozonexpress/mapper";
import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

const baseInput: CreateShipmentAdapterInput = {
  localShipmentId: "ship_local_1",
  orderNumber: "1042",
  recipientName: "Amine Tazi",
  addressLine1: "12 rue Hassan II",
  addressLine2: "Appt 4",
  city: "Casablanca",
  region: null,
  country: "MA",
  phone: "+212 612-345-678",
  codAmount: 249.5,
  currency: "MAD",
  notes: "Livrer le matin",
};

describe("ozonexpress mapper — city resolution", () => {
  it("resolves a configured city name to its id, case-insensitively", () => {
    expect(resolveCityId("casablanca", { cityIdByName: { Casablanca: 1 } })).toBe("1");
    expect(resolveCityId("  RABAT ", { cityIdByName: { rabat: "2" } })).toBe("2");
  });

  it("throws a typed config error (never guesses) for an unmapped city", () => {
    expect(() => resolveCityId("Ifrane", { cityIdByName: { Casablanca: 1 } })).toThrow(DeliveryConfigError);
    expect(() => resolveCityId("Ifrane", {})).toThrow(DeliveryConfigError);
  });
});

describe("ozonexpress mapper — phone normalization", () => {
  it.each([
    ["+212 612-345-678", "0612345678"],
    ["00212612345678", "0612345678"],
    ["0612345678", "0612345678"],
    ["612345678", "0612345678"],
    ["", ""],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeMoroccanPhone(input)).toBe(expected);
  });

  it("leaves an unrecognized shape as digits for the carrier to reject, never mangles silently", () => {
    expect(normalizeMoroccanPhone("+33 1 23 45 67 89")).toBe("33123456789");
  });
});

describe("ozonexpress mapper — buildAddParcelForm", () => {
  const config = { cityIdByName: { Casablanca: 1 }, defaultParcelNature: "Vêtements" };

  it("builds the documented multipart fields", () => {
    const form = buildAddParcelForm(baseInput, config);
    expect(form).toMatchObject({
      "tracking-number": "ship_local_1",
      "parcel-receiver": "Amine Tazi",
      "parcel-phone": "0612345678",
      "parcel-city": "1",
      "parcel-address": "12 rue Hassan II, Appt 4",
      "parcel-price": "250", // rounded COD
      "parcel-stock": "0", // ramassage by default
      "parcel-nature": "Vêtements",
      "parcel-note": "Livrer le matin",
    });
  });

  it("sends parcel-price 0 for a prepaid order (0 COD is meaningful, not 'missing')", () => {
    expect(buildAddParcelForm({ ...baseInput, codAmount: null }, config)["parcel-price"]).toBe("0");
    expect(buildAddParcelForm({ ...baseInput, codAmount: 0 }, config)["parcel-price"]).toBe("0");
  });

  it("uses stock mode when configured", () => {
    expect(buildAddParcelForm(baseInput, { ...config, stockMode: "stock" })["parcel-stock"]).toBe("1");
  });

  it("rejects a negative COD amount before any network call", () => {
    expect(() => buildAddParcelForm({ ...baseInput, codAmount: -5 }, config)).toThrow(DeliveryConfigError);
  });

  it("propagates the unmapped-city error", () => {
    expect(() => buildAddParcelForm({ ...baseInput, city: "Nowhere" }, config)).toThrow(DeliveryConfigError);
  });
});

describe("ozonexpress mapper — parseAddParcelResponse", () => {
  it("reads a flat success body", () => {
    const r = parseAddParcelResponse({
      "TRACKING-NUMBER": "OZE123",
      "DELIVERED-PRICE": "25.00",
      STATUS: "Nouveau colis",
    });
    expect(r).toEqual({ externalId: "OZE123", trackingNumber: "OZE123", cost: 25, rawStatus: "Nouveau colis" });
  });

  it("reads a nested ADD-PARCEL.NEW-PARCEL success body", () => {
    const r = parseAddParcelResponse({
      "ADD-PARCEL": { RESULT: "SUCCESS", "NEW-PARCEL": { "TRACKING-NUMBER": "OZE999", "DELIVERED-PRICE": 30 } },
    });
    expect(r.externalId).toBe("OZE999");
    expect(r.cost).toBe(30);
  });

  it("never fabricates a tracking number when the response omits one", () => {
    expect(() => parseAddParcelResponse({ RECEIVER: "Amine", "DELIVERED-PRICE": "25.00" })).toThrow(
      DeliveryMalformedResponseError
    );
  });

  it("returns null cost (never 0) when DELIVERED-PRICE is absent", () => {
    expect(parseAddParcelResponse({ "TRACKING-NUMBER": "OZE1" }).cost).toBeNull();
  });
});

describe("ozonexpress mapper — parseTrackingResponse", () => {
  it("reads a top-level STATUS", () => {
    expect(parseTrackingResponse({ STATUS: "Livré", "DELIVERED-PRICE": "25.00" })).toEqual({
      rawStatus: "Livré",
      cost: 25,
    });
  });

  it("reads a status nested under TRACKING history", () => {
    const r = parseTrackingResponse({
      TRACKING: { "TRACKING-HISTORY": [{ STATUT: "Nouveau colis" }, { STATUT: "En cours de livraison" }] },
    });
    expect(r.rawStatus).toBe("En cours de livraison");
  });

  it("throws malformed (not 'unknown') when no status field is present at all", () => {
    expect(() => parseTrackingResponse({ "TRACKING-NUMBER": "OZE1" })).toThrow(DeliveryMalformedResponseError);
  });
});

describe("ozonexpress mapper — status vocabulary (conservative, accent/format tolerant)", () => {
  it.each([
    ["Nouveau colis", "EN_ATTENTE"],
    ["  reçu  ", null], // "reçu" alone is not in the table
    ["Colis reçu", "EN_ATTENTE"],
    ["EN COURS DE LIVRAISON", "EN_TRANSIT"],
    ["mise_en_distribution", "EN_TRANSIT"],
    ["Livré", "LIVRE"],
    ["livre", "LIVRE"],
    ["Retourné", "RETOURNE"],
    ["retour", "RETOURNE"],
    ["Refusé", "ECHEC"],
    ["Annulé", "ANNULE"],
  ])("maps %j -> %j", (raw, expected) => {
    expect(mapOzonExpressStatus(raw as string)).toBe(expected);
  });

  it("returns null for any status not explicitly in the table — never guessed", () => {
    expect(mapOzonExpressStatus("colis en zone de tri regionale")).toBeNull();
    expect(mapOzonExpressStatus("some_new_carrier_state_2027")).toBeNull();
    expect(mapOzonExpressStatus("")).toBeNull();
  });
});
