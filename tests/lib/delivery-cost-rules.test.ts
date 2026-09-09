import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { resolveFinalShipmentCost, isFinalShipmentStatus } from "@/lib/delivery";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

const apiRules = { returnCost: null, failureCost: null, isApiProvider: true, currentCostSource: null as null };

describe("resolveFinalShipmentCost — the carrier is the source of truth for a successful delivery (ADR 0032)", () => {
  it("LIVRE on an API provider → the carrier's own price, source CARRIER_API", () => {
    const r = resolveFinalShipmentCost("LIVRE", 20, apiRules);
    expect(r).toEqual({ cost: new Prisma.Decimal(20), costSource: "CARRIER_API" });
  });

  it("LIVRE with NO carrier price → cost stays null (unknown) — never invented / never a fallback", () => {
    const r = resolveFinalShipmentCost("LIVRE", null, {
      // Even with return/failure rules configured, they must NOT bleed into a delivery.
      returnCost: 10,
      failureCost: 5,
      isApiProvider: true,
      currentCostSource: null,
    });
    expect(r).toEqual({ cost: null, costSource: null });
  });

  it("LIVRE on a manual provider → the operator-entered cost, source unchanged", () => {
    const r = resolveFinalShipmentCost("LIVRE", 33, { ...apiRules, isApiProvider: false, currentCostSource: null });
    expect(r).toEqual({ cost: new Prisma.Decimal(33), costSource: null });
  });

  it("RETOURNE → the merchant's return rule (independent of the delivery price)", () => {
    const r = resolveFinalShipmentCost("RETOURNE", 25.5, { ...apiRules, returnCost: 10 });
    expect(r).toEqual({ cost: new Prisma.Decimal(10), costSource: "RETURN_RULE" });
    // NOT the delivery price, NOT 50% of it:
    expect(Number(r!.cost)).not.toBe(25.5);
    expect(Number(r!.cost)).not.toBe(12.75);
  });

  it("RETOURNE with no rule configured → 0, source RETURN_RULE", () => {
    const r = resolveFinalShipmentCost("RETOURNE", 25.5, apiRules);
    expect(r).toEqual({ cost: new Prisma.Decimal(0), costSource: "RETURN_RULE" });
  });

  it("ECHEC / ANNULE → the merchant's failure rule (0 when unset)", () => {
    expect(resolveFinalShipmentCost("ECHEC", 25.5, { ...apiRules, failureCost: 5 })).toEqual({
      cost: new Prisma.Decimal(5),
      costSource: "FAILURE_RULE",
    });
    expect(resolveFinalShipmentCost("ANNULE", 25.5, apiRules)).toEqual({
      cost: new Prisma.Decimal(0),
      costSource: "FAILURE_RULE",
    });
  });

  it("a non-final status finalises nothing", () => {
    expect(resolveFinalShipmentCost("EN_TRANSIT", 25.5, apiRules)).toBeNull();
    expect(resolveFinalShipmentCost("EN_ATTENTE", 25.5, apiRules)).toBeNull();
  });

  it("isFinalShipmentStatus", () => {
    const final: ShipmentStatusValue[] = ["LIVRE", "ECHEC", "RETOURNE", "ANNULE"];
    const live: ShipmentStatusValue[] = ["EN_ATTENTE", "EN_TRANSIT"];
    expect(final.every(isFinalShipmentStatus)).toBe(true);
    expect(live.some(isFinalShipmentStatus)).toBe(false);
  });
});
