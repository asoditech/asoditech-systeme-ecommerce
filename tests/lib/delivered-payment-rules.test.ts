import { describe, expect, it } from "vitest";
import { shouldMarkPaidOnDelivery } from "@/lib/orders/delivered-payment";
import { wooReportsPaid } from "@/lib/orders/store-payment";

/**
 * Pure rules of « payées à la livraison » (owner decision 2026-10-16) and of
 * the WooCommerce COD exception. No database.
 */

describe("shouldMarkPaidOnDelivery", () => {
  it("only when the company opted in, the order is LIVREE and the payment is still EN_ATTENTE", () => {
    expect(shouldMarkPaidOnDelivery({ enabled: true, orderStatus: "LIVREE", paymentStatus: "EN_ATTENTE" })).toBe(true);
    expect(shouldMarkPaidOnDelivery({ enabled: false, orderStatus: "LIVREE", paymentStatus: "EN_ATTENTE" })).toBe(false);
    expect(shouldMarkPaidOnDelivery({ enabled: true, orderStatus: "EXPEDIEE", paymentStatus: "EN_ATTENTE" })).toBe(false);
  });

  it("never touches a payment someone or something already decided", () => {
    for (const paymentStatus of ["PAYE", "PARTIELLEMENT_PAYE", "ECHEC", "REMBOURSE"]) {
      expect(shouldMarkPaidOnDelivery({ enabled: true, orderStatus: "LIVREE", paymentStatus })).toBe(false);
    }
  });
});

describe("wooReportsPaid — WooCommerce's « paid » signal", () => {
  it("date_paid counts for non-COD methods", () => {
    expect(wooReportsPaid({ date_paid: "2026-10-02T10:00:00", payment_method: "bacs" })).toBe(true);
    expect(wooReportsPaid({ date_paid: "2026-10-02T10:00:00", payment_method: "stripe" })).toBe(true);
    expect(wooReportsPaid({ date_paid: "2026-10-02T10:00:00", payment_method: null })).toBe(true);
  });

  it("no date_paid = not paid", () => {
    expect(wooReportsPaid({ date_paid: null, payment_method: "bacs" })).toBe(false);
    expect(wooReportsPaid({ payment_method: "stripe" })).toBe(false);
  });

  it("cash on delivery: date_paid is ignored (stamped on « completed » or by plugins — no proof of cash)", () => {
    expect(wooReportsPaid({ date_paid: "2026-10-02T10:00:00", payment_method: "cod" })).toBe(false);
    expect(wooReportsPaid({ date_paid: "2026-10-02T10:00:00", payment_method: " COD " })).toBe(false);
  });
});

describe("Shopify never reports « delivered » (so its import / sync can never trigger the delivered-paid rule)", () => {
  it("no financial × fulfillment × cancellation combination maps to LIVREE; FULFILLED is shipping only", async () => {
    const { mapOrderStatus } = await import("@/lib/integrations/shopify/mapper");
    const financial = ["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "VOIDED", "EXPIRED", null];
    const fulfillment = ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "RESTOCKED", "PENDING_FULFILLMENT", "OPEN", "IN_PROGRESS", "ON_HOLD", "SCHEDULED", "REQUEST_DECLINED", null];
    for (const f of financial) {
      for (const ff of fulfillment) {
        for (const c of [null, "2026-10-01T00:00:00Z"]) {
          const m = mapOrderStatus(f, ff, c);
          if (m.ok) expect(m.status).not.toBe("LIVREE");
        }
      }
    }
    expect(mapOrderStatus("PAID", "FULFILLED", null)).toEqual({ ok: true, status: "EXPEDIEE" });
  });
});
