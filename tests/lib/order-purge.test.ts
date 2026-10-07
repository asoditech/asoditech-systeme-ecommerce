import { describe, expect, it } from "vitest";
import { evaluateOrderPurge, PURGEABLE_STATUSES, type PurgeOrderSnapshot } from "@/lib/orders/purge";
import { hasPermission } from "@/lib/auth/permissions";

/** Pure eligibility + preview of the test-order purge (src/lib/orders/purge.ts). */

const base: PurgeOrderSnapshot = {
  status: "NOUVELLE",
  source: "INTERNE",
  shippedAt: null,
  items: [{ productId: "p1", variationId: null, nameSnapshot: "Casquette", skuSnapshot: "CAP-1", quantity: 2 }],
  shipments: [],
  refundCount: 0,
  returnCount: 0,
  commissionEntryCount: 0,
};
const ev = (over: Partial<PurgeOrderSnapshot>) => evaluateOrderPurge({ ...base, ...over });

describe("evaluateOrderPurge — eligible states", () => {
  it("allowed statuses are exactly NOUVELLE, CONFIRMEE, EN_PREPARATION, ANNULEE", () => {
    expect(PURGEABLE_STATUSES).toEqual(["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "ANNULEE"]);
  });

  it("NOUVELLE and ANNULEE: nothing reserved, nothing to release", () => {
    for (const status of ["NOUVELLE", "ANNULEE"] as const) {
      expect(ev({ status })).toEqual({ eligible: true, preview: { releaseReservation: false, releasedLines: [], failedShipmentIds: [] } });
    }
  });

  it("CONFIRMEE and EN_PREPARATION: the reservation is released (per line)", () => {
    for (const status of ["CONFIRMEE", "EN_PREPARATION"] as const) {
      expect(ev({ status })).toEqual({
        eligible: true,
        preview: { releaseReservation: true, releasedLines: [{ name: "Casquette", sku: "CAP-1", quantity: 2 }], failedShipmentIds: [] },
      });
    }
  });

  it("failed shipment attempts (ECHEC, no carrier parcel) are removed with the order", () => {
    const r = ev({ status: "CONFIRMEE", shipments: [{ id: "s1", status: "ECHEC", externalId: null, trackingNumber: null }] });
    expect(r).toMatchObject({ eligible: true, preview: { failedShipmentIds: ["s1"] } });
  });
});

describe("evaluateOrderPurge — refused states (with the reason)", () => {
  const refused = (over: Partial<PurgeOrderSnapshot>, re: RegExp) => {
    const r = ev(over);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reasons.join(" ")).toMatch(re);
  };
  it("any status from shipping onwards", () => {
    for (const status of ["EXPEDIEE", "LIVREE", "ECHEC", "RETOUR", "REMBOURSEE"] as const) refused({ status }, /jamais expédiée/);
  });
  it("shippedAt set (even if the status went back)", () => refused({ status: "ANNULEE", shippedAt: new Date() }, /déjà été expédiée/));
  it("WooCommerce / Shopify orders", () => {
    refused({ source: "WOOCOMMERCE" }, /réimportée/);
    refused({ source: "SHOPIFY" }, /réimportée/);
  });
  it("a real carrier parcel — whatever its status, even ECHEC or ANNULE", () => {
    for (const status of ["EN_ATTENTE", "EN_TRANSIT", "ECHEC", "ANNULE"] as const) {
      refused({ status: "CONFIRMEE", shipments: [{ id: "s", status, externalId: "OZE1", trackingNumber: "OZE1" }] }, /transporteur \(OZE1\)/);
    }
  });
  it("a manual / in-progress shipment without a carrier id", () => {
    refused({ shipments: [{ id: "s", status: "EN_ATTENTE", externalId: null, trackingNumber: "MAN-1" }] }, /expédition/);
    refused({ shipments: [{ id: "s", status: "ANNULE", externalId: null, trackingNumber: null }] }, /expédition/);
  });
  it("refunds, returns, commission entries", () => {
    refused({ refundCount: 1 }, /remboursement/);
    refused({ returnCount: 1 }, /retour physique/);
    refused({ commissionEntryCount: 1 }, /commission/);
  });
});

describe("orders.purge permission", () => {
  it("OWNER and ADMIN only", () => {
    expect(hasPermission("OWNER", "orders.purge")).toBe(true);
    expect(hasPermission("ADMIN", "orders.purge")).toBe(true);
    for (const role of ["MANAGER", "CONFIRMATION", "WAREHOUSE", "DELIVERY", "SUPPORT", "ACCOUNTANT", "STORE_SELLER"] as const) {
      expect(hasPermission(role, "orders.purge"), role).toBe(false);
    }
  });
});
