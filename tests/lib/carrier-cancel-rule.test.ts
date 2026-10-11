import { describe, expect, it } from "vitest";
import { canCancelCarrierShipment, type ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * « Annuler » (cancel at the carrier) is offered only where the local
 * transition to ANNULE is allowed — the carrier is called first, so offering
 * it from EN_TRANSIT would kill the parcel at the carrier while the local row
 * stays live.
 */
describe("canCancelCarrierShipment", () => {
  const cases: [ShipmentStatusValue, boolean][] = [
    ["EN_ATTENTE", true],
    ["ECHEC", true],
    ["EN_TRANSIT", false],
    ["LIVRE", false],
    ["RETOURNE", false],
    ["ANNULE", false],
  ];

  it.each(cases)("%s with a cancel-capable connector → %s", (status, expected) => {
    expect(canCancelCarrierShipment(status, true)).toBe(expected);
  });

  it("never offered when the connector can't cancel", () => {
    for (const [status] of cases) expect(canCancelCarrierShipment(status, false)).toBe(false);
  });
});
