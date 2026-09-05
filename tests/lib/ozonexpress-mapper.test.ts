import { describe, expect, it } from "vitest";
import {
  buildAddParcelForm,
  mapOzonExpressStatus,
  normalizeMoroccanPhone,
  parseAddParcelResponse,
  parseCitiesResponse,
  parseOzonExpressCities,
  parseTrackingResponse,
  resolveCity,
  resolveCityId,
  type OzonExpressCity,
} from "@/lib/integrations/delivery/providers/ozonexpress/mapper";
import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

const CATALOGUE: OzonExpressCity[] = [
  { id: "1", name: "Casablanca", ref: "CAS", deliveredPrice: 20, returnedPrice: 0, refusedPrice: 10 },
  { id: "2", name: "Rabat", ref: "RAB", deliveredPrice: 25, returnedPrice: 0, refusedPrice: 10 },
];

const baseInput: CreateShipmentAdapterInput = {
  localShipmentId: "ship_local_1",
  orderNumber: "1042",
  recipientName: "Amine Tazi",
  addressLine1: "12 rue Hassan II",
  addressLine2: "Appt 4",
  city: "Casablanca",
  resolvedProviderCityId: null,
  region: null,
  country: "MA",
  phone: "+212 612-345-678",
  codAmount: 249.5,
  currency: "MAD",
  notes: "Livrer le matin",
};

describe("ozonexpress mapper — parseOzonExpressCities (GET /cities)", () => {
  it("parses the real live shape: CITIES as an object keyed by id, with per-city prices", () => {
    const cities = parseOzonExpressCities({
      CITIES: {
        "37": { ID: 37, REF: "AGA", NAME: "Agadir", "DELIVERED-PRICE": 35, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
        "2": { ID: 2, REF: "RAB", NAME: "Rabat", "DELIVERED-PRICE": 25, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
      },
    });
    expect(cities).toContainEqual({
      id: "37",
      name: "Agadir",
      ref: "AGA",
      deliveredPrice: 35,
      returnedPrice: 0,
      refusedPrice: 10,
    });
    expect(cities.find((c) => c.id === "2")?.deliveredPrice).toBe(25);
  });

  it("also parses a bare array and the alternate wrapper keys", () => {
    for (const body of [
      [{ ID: 7, NAME: "Agadir" }],
      { cities: [{ id: 7, name: "Agadir" }] },
      { data: { "7": { ID: 7, NAME: "Agadir" } } },
    ]) {
      const cities = parseOzonExpressCities(body);
      expect(cities[0]).toMatchObject({ id: "7", name: "Agadir", deliveredPrice: null });
    }
  });

  it("drops an entry missing an id or a name — never guesses", () => {
    const cities = parseOzonExpressCities([{ NAME: "SansID" }, { ID: 9 }, { ID: 3, NAME: "Fès" }]);
    expect(cities.map((c) => c.name)).toEqual(["Fès"]);
  });

  it("parseCitiesResponse returns the generic DeliveryCity view", () => {
    expect(parseCitiesResponse({ CITIES: { "1": { ID: 1, NAME: "Casa", "DELIVERED-PRICE": 20 } } })).toEqual([
      { id: "1", name: "Casa", region: null },
    ]);
  });

  it("returns [] for an unrecognisable body rather than throwing", () => {
    expect(parseOzonExpressCities({ totally: "unexpected" })).toEqual([]);
    expect(parseOzonExpressCities("nonsense")).toEqual([]);
    expect(parseOzonExpressCities(null)).toEqual([]);
  });
});

describe("ozonexpress mapper — city resolution", () => {
  it("resolves via the config override map, case-insensitively", () => {
    expect(resolveCityId("casablanca", { cityIdByName: { Casablanca: 1 } })).toBe("1");
    expect(resolveCityId("  RABAT ", { cityIdByName: { rabat: "2" } })).toBe("2");
  });

  it("resolves via the GET /cities catalogue when no override matches", () => {
    expect(resolveCityId("rabat", {}, CATALOGUE)).toBe("2");
    expect(resolveCityId("CASABLANCA", { cityIdByName: {} }, CATALOGUE)).toBe("1");
  });

  it("prefers the config override over the catalogue (operator correction wins)", () => {
    expect(resolveCityId("Casablanca", { cityIdByName: { Casablanca: 99 } }, CATALOGUE)).toBe("99");
  });

  it("throws a typed config error (never guesses) when neither source resolves the city", () => {
    expect(() => resolveCityId("Ifrane", { cityIdByName: { Casablanca: 1 } }, CATALOGUE)).toThrow(DeliveryConfigError);
    expect(() => resolveCityId("Ifrane", {}, [])).toThrow(DeliveryConfigError);
    expect(() => resolveCityId("Ifrane", {})).toThrow(DeliveryConfigError);
  });

  it("resolveCity also returns the city's authoritative delivery price", () => {
    expect(resolveCity("Rabat", {}, CATALOGUE)).toEqual({ id: "2", deliveredPrice: 25 });
    // override to an id that's also in the catalogue -> price still resolved
    expect(resolveCity("Casa", { cityIdByName: { Casa: 1 } }, CATALOGUE)).toEqual({ id: "1", deliveredPrice: 20 });
    // override to an id not in the catalogue -> null price, still resolves the id
    expect(resolveCity("Zagora", { cityIdByName: { Zagora: 500 } }, CATALOGUE)).toEqual({ id: "500", deliveredPrice: null });
  });

  // Phase 27B — city resolution hardening (docs/adr/0013-ozonexpress-integration.md).
  it("resolves through an accent difference (e.g. Fès vs Fes)", () => {
    const catalogueWithAccent = [...CATALOGUE, { id: "3", name: "Fès", ref: "FES", deliveredPrice: 30, returnedPrice: 0, refusedPrice: 10 }];
    expect(resolveCityId("Fes", {}, catalogueWithAccent)).toBe("3");
  });

  it("resolves through repeated internal whitespace on either side", () => {
    const catalogueWithSpacing = [
      { id: "5", name: "Sidi   Maarouf", ref: "SM", deliveredPrice: 18, returnedPrice: 0, refusedPrice: 8 },
    ];
    expect(resolveCityId("Sidi Maarouf", {}, catalogueWithSpacing)).toBe("5");
    expect(resolveCityId("  Sidi  Maarouf  ", {}, catalogueWithSpacing)).toBe("5");
  });

  it("an override is matched with the same accent/whitespace-tolerant normalization as the catalogue", () => {
    expect(resolveCityId("fes", { cityIdByName: { Fès: 3 } })).toBe("3");
  });

  it("throws — never silently picks the first — when two catalogue entries normalize to the same name", () => {
    const dup = [
      { id: "1", name: "Casablanca", ref: "CAS1", deliveredPrice: 20, returnedPrice: 0, refusedPrice: 10 },
      { id: "77", name: "casablanca", ref: "CAS2", deliveredPrice: 22, returnedPrice: 0, refusedPrice: 10 },
    ];
    expect(() => resolveCityId("Casablanca", {}, dup)).toThrow(DeliveryConfigError);
    try {
      resolveCityId("Casablanca", {}, dup);
    } catch (error) {
      expect((error as Error).message).toContain("plusieurs villes");
      expect((error as Error).message).toContain("id 1");
      expect((error as Error).message).toContain("id 77");
    }
  });

  it("a no-match error names substring-based near misses as a hint, without ever using one to resolve", () => {
    try {
      resolveCityId("Casa", {}, CATALOGUE);
      throw new Error("expected resolveCityId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryConfigError);
      expect((error as Error).message).toContain("Casablanca");
    }
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

  it("does not send a custom tracking-number — OzonExpress assigns its own", () => {
    expect(buildAddParcelForm(baseInput, config)["tracking-number"]).toBeUndefined();
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

  it("resolves parcel-city from the GET /cities catalogue when passed", () => {
    const form = buildAddParcelForm({ ...baseInput, city: "Rabat" }, {}, CATALOGUE);
    expect(form["parcel-city"]).toBe("2");
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

describe("ozonexpress mapper — parseTrackingResponse (real CHECK_API / TRACKING envelope)", () => {
  it("reads the current status from TRACKING.LAST_TRACKING.STATUT", () => {
    const r = parseTrackingResponse({
      CHECK_API: { RESULT: "SUCCESS", MESSAGE: "Valide API Key" },
      TRACKING: {
        "TRACKING-NUMBER": "OZE1",
        RESULT: "SUCCESS",
        HISTORY: [
          { STATUT: "Nouveau Colis", TIME_STR: "2023-12-15 16:34" },
          { STATUT: "Mise en distribution", TIME_STR: "2023-12-16 09:19" },
        ],
        LAST_TRACKING: { STATUT: "Mise en distribution", TIME_STR: "2023-12-16 09:19" },
        "DELIVERED-PRICE": "25.00",
      },
    });
    expect(r).toEqual({ rawStatus: "Mise en distribution", cost: 25 });
  });

  it("falls back to the last HISTORY entry when LAST_TRACKING is absent", () => {
    const r = parseTrackingResponse({
      TRACKING: { HISTORY: [{ STATUT: "Nouveau Colis" }, { STATUT: "Ramassé" }] },
    });
    expect(r.rawStatus).toBe("Ramassé");
  });

  it("accepts HISTORY as a PHP-style object keyed '1','2',…", () => {
    const r = parseTrackingResponse({
      TRACKING: { HISTORY: { "1": { STATUT: "Nouveau Colis" }, "2": { STATUT: "Reçu" } } },
    });
    expect(r.rawStatus).toBe("Reçu");
  });

  it("still reads a legacy top-level STATUS", () => {
    expect(parseTrackingResponse({ STATUS: "Livré", "DELIVERED-PRICE": "25.00" })).toEqual({
      rawStatus: "Livré",
      cost: 25,
    });
  });

  it("throws malformed (not 'unknown') when no status field is present at all", () => {
    expect(() => parseTrackingResponse({ TRACKING: { "TRACKING-NUMBER": "OZE1" } })).toThrow(
      DeliveryMalformedResponseError
    );
  });
});

describe("ozonexpress mapper — status vocabulary (confirmed live statuses + tolerant matching)", () => {
  it.each([
    // confirmed against the live API
    ["Nouveau Colis", "EN_ATTENTE"],
    ["Attente De Ramassage", "EN_ATTENTE"],
    ["Ramassé", "EN_TRANSIT"],
    ["Reçu", "EN_TRANSIT"],
    ["Mise en distribution", "EN_TRANSIT"],
    // format/accent tolerance + likely wording
    ["  reçu  ", "EN_TRANSIT"],
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
