import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { pushStockToWooCommerce } from "@/lib/integrations/woocommerce/sync/stock-push";
import { pushStockToShopify } from "@/lib/integrations/shopify/sync/stock-push";
import { resetDb } from "../helpers/db";
import type { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import type { ShopifyClient } from "@/lib/integrations/shopify/client";

/** Records every (productId, quantity, variationId?) the sync pushes. */
function fakeWooClient() {
  const updates: { productId: number; quantity: number; variationId?: number }[] = [];
  const client = {
    async updateStock(productId: number, quantity: number, variationId?: number) {
      updates.push({ productId, quantity, variationId });
    },
  } as unknown as WooCommerceClient;
  return { client, updates };
}

async function wooProduct(externalId: string, sku: string) {
  return prisma.product.create({
    data: { name: sku, sku, price: 10, source: "WOOCOMMERCE", externalId, trackInventory: true, status: "ACTIF" },
  });
}

describe("WooCommerce stock push — active-ENTREPOT only (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("I1 — pushes ENTREPOT stock only when the product also sits in a MAGASIN", async () => {
    const entrepot = await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const magasin = await prisma.warehouse.create({ data: { name: "M", type: "MAGASIN" } });
    const p = await wooProduct("501", "WOO-1");
    await prisma.inventoryItem.create({ data: { warehouseId: entrepot.id, productId: p.id, quantityOnHand: 7 } });
    await prisma.inventoryItem.create({ data: { warehouseId: magasin.id, productId: p.id, quantityOnHand: 100 } });

    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);

    expect(updates).toEqual([{ productId: 501, quantity: 7, variationId: undefined }]);
  });

  it("I2 — a WooCommerce product with stock ONLY at a MAGASIN is pushed as 0, not skipped", async () => {
    const magasin = await prisma.warehouse.create({ data: { name: "M", type: "MAGASIN" } });
    await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const p = await wooProduct("502", "WOO-2");
    await prisma.inventoryItem.create({ data: { warehouseId: magasin.id, productId: p.id, quantityOnHand: 40 } });

    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);

    expect(updates).toEqual([{ productId: 502, quantity: 0, variationId: undefined }]);
  });

  it("I3 — an inactive ENTREPOT is excluded (product with stock only there → push 0)", async () => {
    const retired = await prisma.warehouse.create({ data: { name: "Retiré", type: "ENTREPOT", isActive: false } });
    const p = await wooProduct("503", "WOO-3");
    await prisma.inventoryItem.create({ data: { warehouseId: retired.id, productId: p.id, quantityOnHand: 15 } });

    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);

    expect(updates).toEqual([{ productId: 503, quantity: 0, variationId: undefined }]);
  });

  it("preserves the pre-32b skip when the product has no inventory row at all", async () => {
    await wooProduct("504", "WOO-4");
    const { client, updates } = fakeWooClient();
    const summary = await pushStockToWooCommerce(client);
    expect(updates).toHaveLength(0);
    expect(summary.skipped).toBe(1);
  });

  it("I4 — variation-level push follows the same ENTREPOT-only rule", async () => {
    const entrepot = await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const magasin = await prisma.warehouse.create({ data: { name: "M", type: "MAGASIN" } });
    const p = await wooProduct("505", "WOO-5");
    const v = await prisma.productVariation.create({
      data: { productId: p.id, sku: "WOO-5-V", attributes: { Taille: "M" }, source: "WOOCOMMERCE", externalId: "9055" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: entrepot.id, variationId: v.id, quantityOnHand: 4 } });
    await prisma.inventoryItem.create({ data: { warehouseId: magasin.id, variationId: v.id, quantityOnHand: 50 } });

    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);

    expect(updates).toEqual([{ productId: 505, quantity: 4, variationId: 9055 }]);
  });

  it("subtracts reserved units from the ENTREPOT quantity", async () => {
    const entrepot = await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const p = await wooProduct("506", "WOO-6");
    await prisma.inventoryItem.create({
      data: { warehouseId: entrepot.id, productId: p.id, quantityOnHand: 10, quantityReserved: 3 },
    });

    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);
    expect(updates[0].quantity).toBe(7);
  });
});

describe("Shopify stock push — unchanged by Phase 32b (I5)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("still pushes a source:SHOPIFY warehouse regardless of its local type", async () => {
    // A Shopify Location warehouse that happens to be typed MAGASIN locally.
    const loc = await prisma.warehouse.create({
      data: { name: "Shopify Loc", type: "MAGASIN", source: "SHOPIFY", externalId: "gid://shopify/Location/1" },
    });
    const product = await prisma.product.create({
      data: { name: "S", sku: "SHOP-1", price: 20, source: "SHOPIFY", externalId: "gid://shopify/Product/1", status: "ACTIF" },
    });
    await prisma.inventoryItem.create({
      data: { warehouseId: loc.id, productId: product.id, quantityOnHand: 9, externalId: "gid://shopify/InventoryItem/1" },
    });

    const batches: { inventoryItemId: string; locationId: string; quantity: number }[][] = [];
    const client = {
      async setInventoryQuantities(entries: { inventoryItemId: string; locationId: string; quantity: number }[]) {
        batches.push(entries);
      },
    } as unknown as ShopifyClient;

    const summary = await pushStockToShopify(client);
    expect(summary.updated).toBe(1);
    expect(batches[0][0]).toMatchObject({
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      quantity: 9,
    });
  });
});
