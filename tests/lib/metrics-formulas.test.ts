import { describe, expect, it } from "vitest";
import {
  averageBasket,
  confirmationRatePct,
  countOutcomes,
  deliveryOutcomeRate,
  netRevenue,
  orderDeliveryOutcome,
} from "@/lib/metrics/formulas";
import { METRIC_GLOSSARY } from "@/lib/metrics/glossary";

/** S6 — the one formula per label, and explanations that agree with it. */
describe("metric formulas", () => {
  it("net revenue = gross − completed refunds; average basket stays gross ÷ valid orders", () => {
    expect(netRevenue(650, 50)).toBe(600);
    expect(netRevenue(0, 0)).toBe(0);
    expect(averageBasket(650, 3)).toBe(216.67);
    expect(averageBasket(0, 0)).toBeNull();
  });

  it("an order's final delivery outcome: its current parcel, else its own status; a recorded return wins", () => {
    expect(orderDeliveryOutcome("LIVREE", "LIVRE")).toBe("delivered");
    expect(orderDeliveryOutcome("EXPEDIEE", "LIVRE")).toBe("delivered"); // order status lagging behind the parcel
    expect(orderDeliveryOutcome("EXPEDIEE", "ECHEC")).toBe("failed");
    expect(orderDeliveryOutcome("EXPEDIEE", "RETOURNE")).toBe("returned");
    expect(orderDeliveryOutcome("RETOUR", "LIVRE")).toBe("returned"); // delivered, then sent back
    expect(orderDeliveryOutcome("EXPEDIEE", "EN_TRANSIT")).toBeNull();
    expect(orderDeliveryOutcome("CONFIRMEE", "ANNULE")).toBeNull();
    expect(orderDeliveryOutcome("LIVREE", null)).toBe("delivered"); // handled without a shipment record
    expect(orderDeliveryOutcome("ECHEC", null)).toBe("failed");
    expect(orderDeliveryOutcome("ANNULEE", null)).toBeNull();
  });

  it("edge cases of the final delivery outcome (current documented behaviour)", () => {
    // A recorded Retour / Remboursée wins over ANY parcel status — and needs no parcel at all.
    expect(orderDeliveryOutcome("REMBOURSEE", null)).toBe("returned");
    expect(orderDeliveryOutcome("RETOUR", null)).toBe("returned");
    expect(orderDeliveryOutcome("REMBOURSEE", "LIVRE")).toBe("returned");
    expect(orderDeliveryOutcome("RETOUR", "EN_TRANSIT")).toBe("returned");
    expect(orderDeliveryOutcome("REMBOURSEE", "ECHEC")).toBe("returned");
    // Otherwise a parcel exists → the PARCEL decides, whatever the order says.
    expect(orderDeliveryOutcome("ANNULEE", "ECHEC")).toBe("failed"); // cancelled after a failed delivery
    expect(orderDeliveryOutcome("ANNULEE", "ANNULE")).toBeNull();
    expect(orderDeliveryOutcome("ECHEC", "EN_TRANSIT")).toBeNull(); // parcel still moving: no outcome yet
    expect(orderDeliveryOutcome("ECHEC", "LIVRE")).toBe("delivered");
    expect(orderDeliveryOutcome("LIVREE", "EN_ATTENTE")).toBeNull(); // the parcel wins over the order's own LIVREE
    expect(orderDeliveryOutcome("LIVREE", "ECHEC")).toBe("failed");
    expect(orderDeliveryOutcome("EXPEDIEE", "EN_ATTENTE")).toBeNull();
    // No parcel: only LIVREE / ECHEC (and the return statuses above) give an outcome.
    for (const s of ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "EXPEDIEE"] as const) {
      expect(orderDeliveryOutcome(s, null)).toBeNull();
    }
  });

  it("countOutcomes ignores no-outcome entries; an empty list counts nothing", () => {
    expect(countOutcomes([])).toEqual({ delivered: 0, failed: 0, returned: 0 });
    expect(countOutcomes([null, "returned", null])).toEqual({ delivered: 0, failed: 0, returned: 1 });
    expect(deliveryOutcomeRate({ delivered: 0, failed: 0, returned: 2 })).toBe(0);
    expect(deliveryOutcomeRate({ delivered: 3, failed: 0, returned: 0 })).toBe(1);
  });

  it("delivery rate = delivered ÷ (delivered + failed + returned), null when nothing finished", () => {
    const c = countOutcomes(["delivered", "delivered", "failed", "returned", null]);
    expect(c).toEqual({ delivered: 2, failed: 1, returned: 1 });
    expect(deliveryOutcomeRate(c)).toBe(0.5);
    expect(deliveryOutcomeRate(countOutcomes([null, null]))).toBeNull();
  });

  it("confirmation rate = confirmed ÷ went through confirmation", () => {
    expect(confirmationRatePct(7, 10)).toBe(70);
    expect(confirmationRatePct(2, 3)).toBe(66.7);
    expect(confirmationRatePct(0, 0)).toBeNull();
  });
});

describe("metric glossary — every explanation is complete and its example matches the formula", () => {
  it("each entry has what / how / example in French, no placeholder", () => {
    for (const [key, m] of Object.entries(METRIC_GLOSSARY)) {
      for (const field of [m.label, m.what, m.how, m.example]) {
        expect(field.length, key).toBeGreaterThan(5);
        expect(field, key).not.toMatch(/undefined|NaN|TODO/);
      }
    }
  });

  it("the worked examples carry the formula's own results", () => {
    const nbsp = (s: string) => s.replace(/[  ]/g, " ");
    expect(nbsp(METRIC_GLOSSARY.revenue.example)).toContain("600 MAD");
    expect(nbsp(METRIC_GLOSSARY.averageBasket.example)).toContain("216,67 MAD");
    expect(METRIC_GLOSSARY.confirmationRate.example).toContain("70 %");
    expect(nbsp(METRIC_GLOSSARY.deliveryRate.example)).toContain("75 %");
  });
});
