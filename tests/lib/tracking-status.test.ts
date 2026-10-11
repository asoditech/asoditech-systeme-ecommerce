import { describe, expect, it } from "vitest";
import {
  normalizeTrackingStatus,
  normalizedTrackingLabel,
  NORMALIZED_TRACKING_LABELS,
  NORMALIZED_TRACKING_VARIANT,
} from "@/lib/tracking/status";
import { ORDER_STATUS_LABELS, SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";

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

  // P1: one source of truth for colours — Suivi's normalized statuses take the
  // app-wide SHIPMENT_STATUS_LABELS variant of their local bucket.
  it("DELIVERED is the semantic success variant, aligned with « Livré » / « Livrée » elsewhere", () => {
    expect(NORMALIZED_TRACKING_VARIANT.DELIVERED).toBe("success");
    expect(NORMALIZED_TRACKING_VARIANT.DELIVERED).toBe(SHIPMENT_STATUS_LABELS.LIVRE.variant);
    expect(NORMALIZED_TRACKING_VARIANT.DELIVERED).toBe(ORDER_STATUS_LABELS.LIVREE.variant);
    for (const s of ["PICKED_UP", "IN_TRANSIT", "AT_DEPOT", "OUT_FOR_DELIVERY"] as const) {
      expect(NORMALIZED_TRACKING_VARIANT[s]).toBe(SHIPMENT_STATUS_LABELS.EN_TRANSIT.variant);
    }
    for (const s of ["CREATED", "PICKUP_PENDING"] as const) {
      expect(NORMALIZED_TRACKING_VARIANT[s]).toBe(SHIPMENT_STATUS_LABELS.EN_ATTENTE.variant);
    }
    expect(NORMALIZED_TRACKING_VARIANT.RETURNED).toBe(SHIPMENT_STATUS_LABELS.RETOURNE.variant);
    expect(NORMALIZED_TRACKING_VARIANT.FAILED).toBe(SHIPMENT_STATUS_LABELS.ECHEC.variant);
    expect(NORMALIZED_TRACKING_VARIANT.CANCELLED).toBe(SHIPMENT_STATUS_LABELS.ANNULE.variant);
    expect(NORMALIZED_TRACKING_VARIANT.UNKNOWN).toBe("outline");
  });

  it("every normalized status has a French label and a badge variant", () => {
    for (const key of Object.keys(NORMALIZED_TRACKING_LABELS) as (keyof typeof NORMALIZED_TRACKING_LABELS)[]) {
      expect(normalizedTrackingLabel(key)).toBeTruthy();
      expect(NORMALIZED_TRACKING_VARIANT[key]).toBeTruthy();
    }
  });
});
