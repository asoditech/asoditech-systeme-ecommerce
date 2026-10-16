import { describe, expect, it } from "vitest";
import {
  AMEEX_STATUS_LABELS,
  AMEEX_STATUS_MAP,
  AMEEX_STATUS_MAPPING_STATUS,
  composeAmeexRawStatus,
  mapAmeexRawStatus,
  mapAmeexStatus,
} from "@/lib/integrations/delivery/providers/ameex/status";
import { canTransitionShipmentStatus, shipmentStatusSchema, type ShipmentStatusValue } from "@/lib/validation/delivery";
import { ameexFixture } from "../helpers/fake-ameex";

/** PROVISIONAL Ameex mapping (owner review pending) — built from the real
 * sandbox catalogue of 2026-10-16. */
describe("Ameex status mapping (provisional)", () => {
  const catalogue = ameexFixture.statuts.api.data.status;

  it("is flagged provisional", () => {
    expect(AMEEX_STATUS_MAPPING_STATUS).toBe("PROVISIONAL_PENDING_OWNER_REVIEW");
  });

  it("labels and the mapping table cover exactly the 36 sandbox codes", () => {
    const codes = Object.keys(catalogue).sort();
    expect(codes).toHaveLength(36);
    expect(Object.keys(AMEEX_STATUS_LABELS).sort()).toEqual(codes);
    expect(Object.keys(AMEEX_STATUS_MAP).sort()).toEqual(codes);
    for (const code of codes) expect(AMEEX_STATUS_LABELS[code]).toBe(catalogue[code].name);
  });

  it("maps the agreed table", () => {
    const expected: Record<string, ShipmentStatusValue | null> = {
      DRAFT: "EN_ATTENTE",
      NEW_PARCEL: "EN_ATTENTE",
      WAITING_PICKUP: "EN_ATTENTE",
      PICKED_UP: "EN_TRANSIT",
      RECEIVED: "EN_TRANSIT",
      IN_SHIPMENT: "EN_TRANSIT",
      SENT: "EN_TRANSIT",
      TRAVELLING: "EN_TRANSIT",
      DISTRIBUTION: "EN_TRANSIT",
      IN_PROGRESS: "EN_TRANSIT",
      CONFIRMED_BY_LIVREUR: "EN_TRANSIT",
      SCHEDULED: "EN_TRANSIT",
      DISPOSITION: "EN_TRANSIT",
      POSTPONED: "EN_TRANSIT",
      POSTPONED_TEAM: "EN_TRANSIT",
      NO_ANSWER: "EN_TRANSIT",
      NO_ANSWER_SMS: "EN_TRANSIT",
      NO_ANSWER_TEAM: "EN_TRANSIT",
      UNREACHABLE: "EN_TRANSIT",
      UNREACHABLE_TEAM: "EN_TRANSIT",
      VOICEMAIL: "EN_TRANSIT",
      VOICEMAIL_TEAM: "EN_TRANSIT",
      RELAUNCH: "EN_TRANSIT",
      RELAUNCH_NEW: "EN_TRANSIT",
      RELAUNCH_TEAM: "EN_TRANSIT",
      RESEND_NEW_CITY: "EN_TRANSIT",
      PREPAR_RETURN: "EN_TRANSIT",
      DELIVERED: "LIVRE",
      RETURNED: "RETOURNE",
      REFUSE: "ECHEC",
      CANCELED: "ECHEC",
      CANCELED_TEAM: "ECHEC",
      DOESNT_ORDER: "ECHEC",
      WRONG_NUMBER: "ECHEC",
      OUT_OF_AREA: "ECHEC",
      REFUNDED: null,
    };
    for (const [code, local] of Object.entries(expected)) expect(mapAmeexStatus(code), code).toBe(local);
  });

  it("unknown codes and REFUNDED → null (raw kept, never guessed)", () => {
    expect(mapAmeexStatus("REFUNDED")).toBeNull();
    expect(mapAmeexStatus("SOMETHING_NEW")).toBeNull();
    expect(mapAmeexStatus("")).toBeNull();
    expect(mapAmeexStatus(null)).toBeNull();
    // An unknown sub-status under IN_PROGRESS is not assumed « en cours ».
    expect(mapAmeexStatus("IN_PROGRESS", "SOMETHING_NEW")).toBeNull();
  });

  it("the sub-status decides under IN_PROGRESS only", () => {
    expect(mapAmeexStatus("IN_PROGRESS", "REFUSE")).toBe("ECHEC");
    expect(mapAmeexStatus("IN_PROGRESS", "NO_ANSWER")).toBe("EN_TRANSIT");
    expect(mapAmeexStatus("IN_PROGRESS", "")).toBe("EN_TRANSIT");
    // A stray sub-status on a final main status is ignored.
    expect(mapAmeexStatus("DELIVERED", "REFUSE")).toBe("LIVRE");
  });

  it("raw composition round-trips", () => {
    expect(composeAmeexRawStatus("IN_PROGRESS", "REFUSE")).toBe("IN_PROGRESS/REFUSE");
    expect(composeAmeexRawStatus("NEW_PARCEL", "")).toBe("NEW_PARCEL");
    expect(composeAmeexRawStatus("NEW_PARCEL", null)).toBe("NEW_PARCEL");
    expect(mapAmeexRawStatus("IN_PROGRESS/REFUSE")).toBe("ECHEC");
    expect(mapAmeexRawStatus("RETURNED")).toBe("RETOURNE");
    expect(mapAmeexRawStatus("REFUNDED")).toBeNull();
  });

  describe("only legal local transitions (canTransitionShipmentStatus)", () => {
    it("every mapped status is reachable from EN_ATTENTE (fresh parcel)", () => {
      for (const local of new Set(Object.values(AMEEX_STATUS_MAP))) {
        if (local === null || local === "EN_ATTENTE") continue;
        expect(canTransitionShipmentStatus("EN_ATTENTE", local), local).toBe(true);
      }
    });

    it("a refusal (ECHEC) can still be followed by RETURNED, a relaunch, or a late delivery", () => {
      expect(canTransitionShipmentStatus("EN_TRANSIT", "ECHEC")).toBe(true);
      expect(canTransitionShipmentStatus("ECHEC", mapAmeexStatus("RETURNED")!)).toBe(true);
      expect(canTransitionShipmentStatus("ECHEC", mapAmeexStatus("RELAUNCH")!)).toBe(true);
      expect(canTransitionShipmentStatus("ECHEC", mapAmeexStatus("PREPAR_RETURN")!)).toBe(true);
      expect(canTransitionShipmentStatus("ECHEC", mapAmeexStatus("DELIVERED")!)).toBe(true);
    });

    it("the normal journey is a chain of legal steps", () => {
      const journey = ["NEW_PARCEL", "PICKED_UP", "TRAVELLING", "DISTRIBUTION", "DELIVERED"].map((c) => mapAmeexStatus(c)!);
      for (let i = 1; i < journey.length; i++) {
        if (journey[i] === journey[i - 1]) continue;
        expect(canTransitionShipmentStatus(journey[i - 1], journey[i])).toBe(true);
      }
      const refused = ["NEW_PARCEL", "PICKED_UP", "REFUSE", "PREPAR_RETURN", "RETURNED"].map((c) => mapAmeexStatus(c)!);
      for (let i = 1; i < refused.length; i++) {
        if (refused[i] === refused[i - 1]) continue;
        expect(canTransitionShipmentStatus(refused[i - 1], refused[i])).toBe(true);
      }
    });

    it("never maps to ANNULE (cancellation is not an Ameex capability here)", () => {
      expect(Object.values(AMEEX_STATUS_MAP)).not.toContain("ANNULE");
      for (const v of Object.values(AMEEX_STATUS_MAP)) if (v) expect(shipmentStatusSchema.options).toContain(v);
    });
  });
});
