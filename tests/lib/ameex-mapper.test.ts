import { describe, expect, it } from "vitest";
import {
  ameexEventRawStatus,
  assertAmeexEnvelope,
  buildAmeexAddParcelForm,
  countAmeexStatuses,
  latestAmeexEvent,
  parseAmeexAddParcelCode,
  parseAmeexCities,
  parseAmeexTracking,
  toAdapterTrackingEvent,
} from "@/lib/integrations/delivery/providers/ameex/mapper";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
} from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";
import { ameexFixture } from "../helpers/fake-ameex";

/** Pure Ameex parsing, driven by the REAL sandbox bodies of 2026-10-16. */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("assertAmeexEnvelope", () => {
  it("returns `api` for every sandbox success body", () => {
    for (const key of ["statuts", "cities", "add_form_success", "tracking", "massTracking", "massInfo"]) {
      const api = assertAmeexEnvelope(ameexFixture[key]);
      expect(api.type, key).toBe("success");
    }
  });

  it("api.type error (HTTP 200) → DeliveryConfigError with a fixed, mapped message", () => {
    const unknownCity = (() => {
      try {
        assertAmeexEnvelope(ameexFixture.add_form_unknown_city);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(unknownCity).toBeInstanceOf(DeliveryConfigError);
    expect(unknownCity!.message).toMatch(/ville inconnue/);
    expect(unknownCity!.message).not.toContain("Delivery/Cities");

    expect(() => assertAmeexEnvelope(ameexFixture.add_json_rejected)).toThrow(/champ obligatoire manquant \(« receiver »\)/);
  });

  it("never echoes a free-text Ameex msg", () => {
    const body = { login: "success", api: { type: "error", msg: "Client Mohamed 0612345678 blocked" } };
    const err = (() => {
      try {
        assertAmeexEnvelope(body);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(DeliveryConfigError);
    expect(err!.message).not.toContain("0612345678");
    expect(err!.message).not.toContain("Mohamed");
  });

  it("login ≠ success → DeliveryAuthError", () => {
    expect(() => assertAmeexEnvelope({ login: "error", api: { type: "error", msg: "x" } })).toThrow(DeliveryAuthError);
    expect(() => assertAmeexEnvelope({ login: false })).toThrow(DeliveryAuthError);
  });

  it("an unrecognizable body is malformed", () => {
    for (const body of [null, [], "x", 0, {}, { login: "success" }, { login: "success", api: { type: "weird" } }]) {
      expect(() => assertAmeexEnvelope(body)).toThrow(DeliveryMalformedResponseError);
    }
  });
});

describe("statuses / cities", () => {
  it("counts the 36 sandbox status codes", () => {
    expect(countAmeexStatuses(assertAmeexEnvelope(ameexFixture.statuts))).toBe(36);
  });

  it("parses the cities object keyed by id (Casablanca = 129 on the sandbox)", () => {
    const cities = parseAmeexCities(assertAmeexEnvelope(ameexFixture.cities));
    expect(cities).toHaveLength(Object.keys(ameexFixture.cities.api.cities).length);
    expect(cities.find((c) => c.id === "129")).toEqual({ id: "129", name: "Casablanca", region: null });
    expect(cities[0]).toEqual({ id: "1", name: "Marrakech", region: null });
  });

  it("skips malformed city entries and refuses a non-object list", () => {
    const api = { type: "success", cities: { "1": { id: 1, name: "A" }, "2": { id: 2 }, x: "bad", "3": { name: "C" } } };
    expect(parseAmeexCities(api)).toEqual([
      { id: "1", name: "A", region: null },
      { id: "3", name: "C", region: null },
    ]);
    expect(() => parseAmeexCities({ type: "success", cities: [] })).toThrow(DeliveryMalformedResponseError);
  });
});

describe("Add parcel (form)", () => {
  const input: CreateShipmentAdapterInput = {
    localShipmentId: "shp_1",
    orderNumber: "ASD-1001",
    recipientName: " Test ASODITECH ",
    addressLine1: "Adresse de test",
    addressLine2: "Appartement 3",
    city: "Casablanca",
    resolvedProviderCityId: "129",
    region: null,
    country: "MA",
    phone: " 0600000000 ",
    codAmount: 100,
    currency: "MAD",
    notes: "Appeler avant",
    parcelContents: "1× Produit test",
  };

  it("builds exactly the sandbox-accepted fields", () => {
    expect(buildAmeexAddParcelForm(input, "129")).toEqual({
      type: "SIMPLE",
      receiver: "Test ASODITECH",
      phone: "0600000000",
      city: "129",
      cod: "100",
      address: "Adresse de test, Appartement 3",
      product: "1× Produit test",
      comment: "Appeler avant",
      order_num: "ASD-1001",
    });
  });

  it("non-COD → cod 0; no contents → « Commande <n°> »; no note → no comment", () => {
    const form = buildAmeexAddParcelForm({ ...input, codAmount: null, parcelContents: null, notes: null }, "129");
    expect(form.cod).toBe("0");
    expect(form.product).toBe("Commande ASD-1001");
    expect(form).not.toHaveProperty("comment");
    expect(buildAmeexAddParcelForm({ ...input, codAmount: 149.999 }, "129").cod).toBe("150");
    expect(buildAmeexAddParcelForm({ ...input, codAmount: 99.5 }, "129").cod).toBe("99.5");
  });

  it("refuses a missing / non-numeric city id and a negative COD", () => {
    for (const city of [null, "", "abc", "0", "-3"]) {
      expect(() => buildAmeexAddParcelForm(input, city)).toThrow(DeliveryConfigError);
    }
    expect(() => buildAmeexAddParcelForm({ ...input, codAmount: -1 }, "129")).toThrow(DeliveryConfigError);
  });

  it("reads data.code from the sandbox success; a code-less success is malformed", () => {
    expect(parseAmeexAddParcelCode(assertAmeexEnvelope(ameexFixture.add_form_success))).toBe("SBX-51464E10");
    expect(() => parseAmeexAddParcelCode({ type: "success", data: {} })).toThrow(DeliveryMalformedResponseError);
    expect(() => parseAmeexAddParcelCode({ type: "success" })).toThrow(DeliveryMalformedResponseError);
  });
});

describe("tracking", () => {
  it("parses the sandbox event (NEW_PARCEL, seconds timestamp)", () => {
    const events = parseAmeexTracking(assertAmeexEnvelope(ameexFixture.tracking));
    expect(events).toHaveLength(1);
    const latest = latestAmeexEvent(events);
    expect(ameexEventRawStatus(latest)).toBe("NEW_PARCEL");
    expect(toAdapterTrackingEvent(latest)).toEqual({
      rawStatus: "NEW_PARCEL",
      label: "Nouveau Colis",
      description: null,
      location: null,
      timestamp: new Date(1792110662 * 1000).toISOString(),
    });
  });

  it("selects the latest event by sorting_time, whatever the array order", () => {
    const body = clone(ameexFixture.tracking);
    const base = body.api.tracking[0];
    body.api.tracking = [
      { ...base, statut: "IN_PROGRESS", statut_s: "NO_ANSWER", statut_s_name: "Pas de réponse", sorting_time: 1792200000 },
      { ...base, statut: "DELIVERED", statut_name: "Livré", sorting_time: 1792300000, comment: "OK" },
      base,
      { ...base, statut: "PICKED_UP", statut_name: "Ramassé", sorting_time: 1792150000 },
    ];
    const events = parseAmeexTracking(assertAmeexEnvelope(body));
    expect(events.map(ameexEventRawStatus)).toEqual(["NEW_PARCEL", "PICKED_UP", "IN_PROGRESS/NO_ANSWER", "DELIVERED"]);
    expect(ameexEventRawStatus(latestAmeexEvent(events))).toBe("DELIVERED");
    expect(toAdapterTrackingEvent(events[2]).label).toBe("Pas de réponse");
  });

  it("an empty history has no current status; a non-array is malformed", () => {
    expect(() => latestAmeexEvent(parseAmeexTracking({ type: "success", tracking: [] }))).toThrow(DeliveryMalformedResponseError);
    expect(() => parseAmeexTracking({ type: "success", tracking: {} })).toThrow(DeliveryMalformedResponseError);
  });
});
