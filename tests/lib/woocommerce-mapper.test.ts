import { describe, expect, it } from "vitest";
import {
  mapOrderStatus,
  mapProductStatus,
  mapPaymentMethod,
  mapProductFields,
  totalRefundedAmount,
} from "@/lib/integrations/woocommerce/mapper";
import type { WcProduct, WcOrder } from "@/lib/integrations/woocommerce/types";

describe("mapOrderStatus", () => {
  it("maps every documented WooCommerce core status explicitly", () => {
    expect(mapOrderStatus("pending")).toEqual({ ok: true, status: "NOUVELLE" });
    expect(mapOrderStatus("on-hold")).toEqual({ ok: true, status: "NOUVELLE" });
    expect(mapOrderStatus("processing")).toEqual({ ok: true, status: "CONFIRMEE" });
    expect(mapOrderStatus("completed")).toEqual({ ok: true, status: "LIVREE" });
    expect(mapOrderStatus("cancelled")).toEqual({ ok: true, status: "ANNULEE" });
    expect(mapOrderStatus("refunded")).toEqual({ ok: true, status: "REMBOURSEE" });
    expect(mapOrderStatus("failed")).toEqual({ ok: true, status: "ECHEC" });
  });

  it("never invents a mapping for drafts/trash — reports them as unsupported instead", () => {
    expect(mapOrderStatus("checkout-draft").ok).toBe(false);
    expect(mapOrderStatus("auto-draft").ok).toBe(false);
    expect(mapOrderStatus("trash").ok).toBe(false);
  });

  it("never invents a mapping for an unrecognized custom/plugin status", () => {
    const result = mapOrderStatus("wc-custom-subscription-status");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("wc-custom-subscription-status");
  });
});

describe("mapProductStatus", () => {
  it("maps publish to ACTIF and everything else to the conservative BROUILLON default", () => {
    expect(mapProductStatus("publish")).toBe("ACTIF");
    expect(mapProductStatus("draft")).toBe("BROUILLON");
    expect(mapProductStatus("pending")).toBe("BROUILLON");
    expect(mapProductStatus("private")).toBe("BROUILLON");
    expect(mapProductStatus("something-unrecognized")).toBe("BROUILLON");
  });
});

describe("mapPaymentMethod", () => {
  it("maps WooCommerce's four core gateways explicitly", () => {
    expect(mapPaymentMethod("cod")).toBe("PAIEMENT_LIVRAISON");
    expect(mapPaymentMethod("bacs")).toBe("VIREMENT_BANCAIRE");
    expect(mapPaymentMethod("paypal")).toBe("CARTE_BANCAIRE");
  });

  it("falls back to AUTRE for a third-party gateway id rather than guessing", () => {
    expect(mapPaymentMethod("stripe_cc")).toBe("AUTRE");
    expect(mapPaymentMethod(null)).toBe("AUTRE");
    expect(mapPaymentMethod(undefined)).toBe("AUTRE");
  });
});

function makeWcProduct(overrides: Partial<WcProduct> = {}): WcProduct {
  return {
    id: 1,
    name: "Produit test",
    slug: "produit-test",
    sku: "SKU-1",
    status: "publish",
    type: "simple",
    description: null,
    regular_price: 100,
    sale_price: null,
    price: 100,
    manage_stock: true,
    stock_quantity: 5,
    stock_status: "instock",
    categories: [],
    variations: [],
    ...overrides,
  };
}

describe("mapProductFields", () => {
  it("falls back to a deterministic WC-<id> SKU when WooCommerce has none, rather than an empty string", () => {
    const fields = mapProductFields(makeWcProduct({ sku: "", id: 42 }));
    expect(fields.sku).toBe("WC-42");
  });

  it("only treats sale_price as a real sale when it is positive and below the regular price", () => {
    expect(mapProductFields(makeWcProduct({ regular_price: 100, sale_price: 80 })).salePrice).toBe(80);
    expect(mapProductFields(makeWcProduct({ regular_price: 100, sale_price: 0 })).salePrice).toBeNull();
    expect(mapProductFields(makeWcProduct({ regular_price: 100, sale_price: 150 })).salePrice).toBeNull();
  });
});

function makeWcOrder(overrides: Partial<WcOrder> = {}): WcOrder {
  return {
    id: 10,
    number: "10",
    status: "processing",
    currency: "MAD",
    date_created: "2026-01-01T00:00:00",
    date_paid: null,
    customer_id: 0,
    total: 100,
    total_tax: 0,
    shipping_total: 0,
    discount_total: 0,
    payment_method: null,
    payment_method_title: null,
    customer_note: null,
    billing: {
      first_name: "Amine",
      last_name: "Tazi",
      company: null,
      address_1: "12 Rue Atlas",
      address_2: null,
      city: "Casablanca",
      state: null,
      postcode: null,
      country: "MA",
      email: "amine@example.com",
      phone: "0600000000",
    },
    shipping: {
      first_name: "",
      last_name: "",
      company: null,
      address_1: "",
      address_2: null,
      city: "",
      state: null,
      postcode: null,
      country: "",
      email: null,
      phone: null,
    },
    line_items: [],
    refunds: [],
    ...overrides,
  };
}

describe("totalRefundedAmount", () => {
  it("sums the absolute value of negative WooCommerce refund totals", () => {
    const wc = makeWcOrder({
      refunds: [
        { id: 1, reason: null, total: "-10.00" },
        { id: 2, reason: "partiel", total: "-5.50" },
      ],
    });
    expect(totalRefundedAmount(wc)).toBeCloseTo(15.5);
  });

  it("returns 0 when there are no refunds", () => {
    expect(totalRefundedAmount(makeWcOrder())).toBe(0);
  });
});
