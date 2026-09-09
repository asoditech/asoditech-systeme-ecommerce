import { describe, expect, it } from "vitest";
import {
  normalizeTrackingStatus,
  normalizedTrackingLabel,
  NORMALIZED_TRACKING_LABELS,
  NORMALIZED_TRACKING_VARIANT,
} from "@/lib/tracking/status";

describe("normalizeTrackingStatus (« Suivi » module, docs/adr/0033)", () => {
  it("maps terminal local statuses 1:1 and never lets raw text override them", () => {
    expect(normalizeTrackingStatus("LIVRE", "still in transit somehow")).toBe("DELIVERED");
    expect(normalizeTrackingStatus("RETOURNE", "out for delivery")).toBe("RETURNED");
    expect(normalizeTrackingStatus("ECHEC", "picked up")).toBe("FAILED");
    expect(normalizeTrackingStatus("ANNULE", "in transit")).toBe("CANCELLED");
  });

  it("refines a non-terminal local status using the carrier's raw string", () => {
    expect(normalizeTrackingStatus("EN_TRANSIT", "Out for delivery")).toBe("OUT_FOR_DELIVERY");
    expect(normalizeTrackingStatus("EN_TRANSIT", "Colis au dépôt de Casablanca")).toBe("AT_DEPOT");
    expect(normalizeTrackingStatus("EN_TRANSIT", "Ramassé par le livreur")).toBe("PICKED_UP");
    expect(normalizeTrackingStatus("EN_TRANSIT", "In transit to destination")).toBe("IN_TRANSIT");
    expect(normalizeTrackingStatus("EN_ATTENTE", "En attente de ramassage")).toBe("PICKUP_PENDING");
  });

  it("is accent- and case-insensitive on the raw string", () => {
    expect(normalizeTrackingStatus("EN_TRANSIT", "AU DEPOT")).toBe("AT_DEPOT");
    expect(normalizeTrackingStatus("EN_TRANSIT", "en cours de livraison")).toBe("OUT_FOR_DELIVERY");
  });

  it("falls back to a coarse bucket when the raw string is empty or unrecognised", () => {
    expect(normalizeTrackingStatus("EN_TRANSIT", null)).toBe("IN_TRANSIT");
    expect(normalizeTrackingStatus("EN_ATTENTE", "")).toBe("CREATED");
    expect(normalizeTrackingStatus("EN_TRANSIT", "asdfghjkl gibberish")).toBe("IN_TRANSIT");
  });

  it("never returns UNKNOWN for a known local status", () => {
    for (const raw of [null, "", "weird", "livré", "out for delivery"]) {
      for (const local of ["EN_ATTENTE", "EN_TRANSIT", "LIVRE", "ECHEC", "RETOURNE", "ANNULE"] as const) {
        expect(normalizeTrackingStatus(local, raw)).not.toBe("UNKNOWN");
      }
    }
  });

  it("every normalized status has a French label and a badge variant", () => {
    for (const key of Object.keys(NORMALIZED_TRACKING_LABELS) as (keyof typeof NORMALIZED_TRACKING_LABELS)[]) {
      expect(normalizedTrackingLabel(key)).toBeTruthy();
      expect(NORMALIZED_TRACKING_VARIANT[key]).toBeTruthy();
    }
  });
});
