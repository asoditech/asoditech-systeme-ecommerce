import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isPurgeCandidate } from "@/lib/orders/purge-ui";
import { PURGEABLE_STATUSES } from "@/lib/orders/purge";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { OrderRowActions } = await import("@/components/orders/order-row-actions");

/** Orders table → the order page's own purge, as a row-menu shortcut. */

const summary = {
  orderId: "o1",
  orderLabel: "CMD-000042",
  statusLabel: "Nouvelle",
  customerName: "Sara Amrani",
  total: "250,00 MAD",
  lines: [{ name: "T-shirt — Noir", sku: "TS-NOIR", quantity: 1 }],
};

describe("which rows offer the shortcut (list pre-filter, no per-row query)", () => {
  it("only in-app orders, in a purgeable status, never shipped", () => {
    for (const status of PURGEABLE_STATUSES) {
      expect(isPurgeCandidate({ source: "INTERNE", status, shippedAt: null })).toBe(true);
    }
    expect(isPurgeCandidate({ source: "WOOCOMMERCE", status: "NOUVELLE", shippedAt: null })).toBe(false);
    expect(isPurgeCandidate({ source: "SHOPIFY", status: "ANNULEE", shippedAt: null })).toBe(false);
    expect(isPurgeCandidate({ source: "INTERNE", status: "EXPEDIEE", shippedAt: new Date() })).toBe(false);
    expect(isPurgeCandidate({ source: "INTERNE", status: "LIVREE", shippedAt: null })).toBe(false);
    // ANNULEE after a shipment (e.g. from ECHEC) was shipped → never a candidate
    expect(isPurgeCandidate({ source: "INTERNE", status: "ANNULEE", shippedAt: new Date() })).toBe(false);
  });
});

describe("row menu", () => {
  it("is a compact icon trigger named for the order — no permanent destructive button in the row", () => {
    const html = renderToStaticMarkup(createElement(OrderRowActions, { orderHref: "/commandes/o1", summary }));
    expect(html).toContain('aria-label="Actions pour la commande CMD-000042"');
    expect(html).not.toContain("Purger définitivement"); // dialog closed
    expect(html).not.toMatch(/bg-destructive/);
  });
});

const { ProductRowActions } = await import("@/components/products/product-row-actions");
const { RemoveProductButton } = await import("@/components/products/remove-product-button");

describe("products table → the product page's own « Retirer du catalogue »", () => {
  it("row menu is a compact icon trigger named for the product", () => {
    const html = renderToStaticMarkup(createElement(ProductRowActions, { productId: "p1", productName: "Sac cuir" }));
    expect(html).toContain('aria-label="Actions pour Sac cuir"');
    expect(html).not.toContain("Retirer « Sac cuir »"); // confirmation closed
  });

  it("the product page keeps its existing outline button", () => {
    const html = renderToStaticMarkup(createElement(RemoveProductButton, { productId: "p1", productName: "Sac cuir", neverSold: true }));
    expect(html).toContain("Retirer du catalogue");
  });
});
