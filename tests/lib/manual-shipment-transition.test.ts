import { describe, expect, it } from "vitest";
import {
  manualShipmentTransitionProblem,
  MANUAL_OUTCOME_UNKNOWN_MESSAGE,
  MANUAL_RETURN_FROM_PENDING_MESSAGE,
  MANUAL_RETURN_NEVER_SHIPPED_MESSAGE,
  SHIPMENT_STATUS_TRANSITIONS,
} from "@/lib/validation/delivery";

/**
 * Status rules for a parcel changed BY HAND (owner decisions 2026-10-16).
 * Carrier sync / webhooks don't go through this rule (the carrier is
 * authoritative). Pure — no database.
 */

describe("manualShipmentTransitionProblem", () => {
  it("« En attente » → « Retourné » is refused: the parcel never left", () => {
    expect(manualShipmentTransitionProblem("EN_ATTENTE", "RETOURNE", { orderShipped: true })).toBe(MANUAL_RETURN_FROM_PENDING_MESSAGE);
  });

  it("« Retourné » is refused from ANY status while the order was never shipped (« Échec » included)", () => {
    for (const from of ["EN_TRANSIT", "ECHEC"] as const) {
      expect(manualShipmentTransitionProblem(from, "RETOURNE", { orderShipped: false })).toBe(MANUAL_RETURN_NEVER_SHIPPED_MESSAGE);
    }
  });

  it("the normal path stays allowed: « En transit » / « Échec » → « Retourné » on a shipped order", () => {
    expect(manualShipmentTransitionProblem("EN_TRANSIT", "RETOURNE", { orderShipped: true })).toBeNull();
    expect(manualShipmentTransitionProblem("ECHEC", "RETOURNE", { orderShipped: true })).toBeNull();
  });

  it("a creation « à vérifier » can only be settled « Échec » or « Annulé » by hand", () => {
    const ctx = { orderShipped: false, outcomeUnknown: true };
    expect(manualShipmentTransitionProblem("EN_ATTENTE", "ECHEC", ctx)).toBeNull();
    expect(manualShipmentTransitionProblem("EN_ATTENTE", "ANNULE", ctx)).toBeNull();
    for (const to of ["EN_TRANSIT", "LIVRE", "RETOURNE"] as const) {
      expect(manualShipmentTransitionProblem("EN_ATTENTE", to, ctx)).toBe(MANUAL_OUTCOME_UNKNOWN_MESSAGE);
    }
  });

  it("other manual changes are untouched (the general transition table still decides)", () => {
    expect(manualShipmentTransitionProblem("EN_ATTENTE", "EN_TRANSIT", { orderShipped: false })).toBeNull();
    expect(manualShipmentTransitionProblem("EN_TRANSIT", "LIVRE", { orderShipped: true })).toBeNull();
    // The carrier-facing table itself still allows EN_ATTENTE → RETOURNE (carrier reports).
    expect(SHIPMENT_STATUS_TRANSITIONS.EN_ATTENTE).toContain("RETOURNE");
  });
});
