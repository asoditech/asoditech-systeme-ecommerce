import { describe, expect, it } from "vitest";
import {
  mapOrderStatus,
  mapProductStatus,
  mapPaymentMethod,
  isSimpleProduct,
  mapSimpleProductFields,
  totalRefundedAmount,
} from "@/lib/integrations/shopify/mapper";
import type { ShopifyProduct, ShopifyOrder } from "@/lib/integrations/shopify/types";

describe("mapProductStatus", () => {
  it("maps ACTIVE/ARCHIVED explicitly and defaults everything else to BROUILLON", () => {
    expect(mapProductStatus("ACTIVE")).toBe("ACTIF");
    expect(mapProductStatus("ARCHIVED")).toBe("ARCHIVE");
    expect(mapProductStatus("DRAFT")).toBe("BROUILLON");
    expect(mapProductStatus("something-unrecognized")).toBe("BROUILLON");
  });
});

describe("mapOrderStatus — verified against Shopify's exact enum values", () => {
  it("cancellation always wins regardless of financial/fulfillment status", () => {
    expect(mapOrderStatus("PAID", "FULFILLED", "2026-01-01T00:00:00Z")).toEqual({ ok: true, status: "ANNULEE" });
  });

  it("maps VOIDED and REFUNDED explicitly", () => {
    expect(mapOrderStatus("VOIDED", "UNFULFILLED", null)).toEqual({ ok: true, status: "ANNULEE" });
    expect(mapOrderStatus("REFUNDED", "FULFILLED", null)).toEqual({ ok: true, status: "REMBOURSEE" });
  });

  it("maps fulfillment progress to EXPEDIEE/LIVREE/RETOUR", () => {
    expect(mapOrderStatus("PAID", "FULFILLED", null)).toEqual({ ok: true, status: "LIVREE" });
    expect(mapOrderStatus("PAID", "PARTIALLY_FULFILLED", null)).toEqual({ ok: true, status: "EXPEDIEE" });
    expect(mapOrderStatus("PAID", "IN_PROGRESS", null)).toEqual({ ok: true, status: "EXPEDIEE" });
    expect(mapOrderStatus("PAID", "RESTOCKED", null)).toEqual({ ok: true, status: "RETOUR" });
  });

  it("maps a paid, not-yet-shipped order to CONFIRMEE", () => {
    expect(mapOrderStatus("PAID", "UNFULFILLED", null)).toEqual({ ok: true, status: "CONFIRMEE" });
    expect(mapOrderStatus("PARTIALLY_PAID", "OPEN", null)).toEqual({ ok: true, status: "CONFIRMEE" });
  });

  it("maps a pending/authorized, not-yet-shipped order to NOUVELLE", () => {
    expect(mapOrderStatus("PENDING", "UNFULFILLED", null)).toEqual({ ok: true, status: "NOUVELLE" });
    expect(mapOrderStatus("AUTHORIZED", "PENDING_FULFILLMENT", null)).toEqual({ ok: true, status: "NOUVELLE" });
  });

  it("maps EXPIRED to ECHEC", () => {
    expect(mapOrderStatus("EXPIRED", "UNFULFILLED", null)).toEqual({ ok: true, status: "ECHEC" });
  });

  it("never invents a mapping for an unrecognized combination — reports it instead", () => {
    const result = mapOrderStatus(null, null, null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("non prise en charge");
  });
});

describe("mapPaymentMethod", () => {
  it("maps Shopify's well-known gateway names explicitly", () => {
    expect(mapPaymentMethod(["cash_on_delivery"])).toBe("PAIEMENT_LIVRAISON");
    expect(mapPaymentMethod(["bank_deposit"])).toBe("VIREMENT_BANCAIRE");
    expect(mapPaymentMethod(["shopify_payments"])).toBe("CARTE_BANCAIRE");
  });

  it("falls back to AUTRE for an unrecognized/merchant-specific gateway id", () => {
    expect(mapPaymentMethod(["custom_local_gateway"])).toBe("AUTRE");
    expect(mapPaymentMethod([])).toBe("AUTRE");
  });
});

function makeVariant(overrides: Partial<ShopifyProduct["variants"]["nodes"][number]> = {}) {
  return {
    id: "gid://shopify/ProductVariant/1",
    title: "Default Title",
    sku: "SKU-1",
    price: "100.00",
    inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true, inventoryLevels: { nodes: [] } },
    ...overrides,
  };
}

function makeProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    title: "Produit test",
    handle: "produit-test",
    status: "ACTIVE",
    descriptionHtml: "<p>Une description</p>",
    variants: { nodes: [makeVariant()] },
    ...overrides,
  };
}

describe("isSimpleProduct", () => {
  it("treats a single 'Default Title' variant as simple", () => {
    expect(isSimpleProduct(makeProduct())).toBe(true);
  });

  it("treats multiple variants as not simple", () => {
    expect(
      isSimpleProduct(makeProduct({ variants: { nodes: [makeVariant(), makeVariant({ id: "gid://shopify/ProductVariant/2", title: "Rouge" })] } }))
    ).toBe(false);
  });

  it("treats a single variant with a real title as not simple", () => {
    expect(isSimpleProduct(makeProduct({ variants: { nodes: [makeVariant({ title: "Rouge" })] } }))).toBe(false);
  });
});

describe("mapSimpleProductFields", () => {
  it("falls back to a deterministic SHOPIFY-<id> SKU when Shopify has none", () => {
    const fields = mapSimpleProductFields(makeProduct({ variants: { nodes: [makeVariant({ sku: null, id: "gid://shopify/ProductVariant/42" })] } }));
    expect(fields.sku).toBe("SHOPIFY-42");
  });

  it("strips HTML from the description", () => {
    const fields = mapSimpleProductFields(makeProduct({ descriptionHtml: "<p>Bonjour <b>monde</b></p>" }));
    expect(fields.description).toBe("Bonjour monde");
  });
});

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-01-01T00:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    cancelReason: null,
    customer: null,
    email: "client@example.com",
    phone: null,
    shippingAddress: null,
    billingAddress: null,
    paymentGatewayNames: [],
    note: null,
    currentTotalPriceSet: { amount: 100, currency: "MAD" },
    subtotalPriceSet: { amount: 100, currency: "MAD" },
    totalDiscountsSet: { amount: 0, currency: "MAD" },
    totalShippingPriceSet: { amount: 0, currency: "MAD" },
    totalRefundedSet: { amount: 0, currency: "MAD" },
    lineItems: { nodes: [] },
    refunds: [],
    ...overrides,
  };
}

describe("totalRefundedAmount", () => {
  it("reads the amount directly from totalRefundedSet", () => {
    expect(totalRefundedAmount(makeOrder({ totalRefundedSet: { amount: 42.5, currency: "MAD" } }))).toBe(42.5);
  });
});
