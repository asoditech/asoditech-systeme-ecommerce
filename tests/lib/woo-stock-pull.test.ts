import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { pullStockForWooCommerceOwner } from "@/lib/integrations/woocommerce/sync/stock-pull";
import { resetDb } from "../helpers/db";
import type { WooCommerceClient } from "@/lib/integrations/woocommerce/client";

/** Records every (productId[, variationId]) the targeted pull fetches, and
 * fails the test if `updateStock` is ever invoked — this function must be
 * strictly read-only against the provider. */
function fakeWooClient(opts: { productStock?: number; variationStock?: number }) {
  const getProductCalls: number[] = [];
  const getVariationCalls: { productId: number; variationId: number }[] = [];
  const client = {
    async getProduct(productId: number) {
      getProductCalls.push(productId);
      return {
        id: productId,
        name: "P",
        slug: "p",
        sku: "P",
        status: "publish",
        type: "simple",
        regular_price: 100,
        manage_stock: true,
        stock_quantity: opts.productStock ?? null,
        stock_status: "instock",
        categories: [],
        variations: [],
      };
    },
    async getProductVariation(productId: number, variationId: number) {
      getVariationCalls.push({ productId, variationId });
      return {
        id: variationId,
        sku: "V",
        regular_price: 100,
        price: 100,
        manage_stock: true,
        stock_quantity: opts.variationStock ?? null,
        stock_status: "instock",
        attributes: [],
      };
    },
    async updateStock() {
      throw new Error("pullStockForWooCommerceOwner must never call updateStock() — it is read-only.");
    },
  } as unknown as WooCommerceClient;
  return { client, getProductCalls, getVariationCalls };
}

describe("pullStockForWooCommerceOwner — targeted, read-only provider refresh (#15627)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
    vi.restoreAllMocks();
  });

  it("fetches exactly the one affected variation and reconciles it, never touching a sibling variation", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Variable", sku: "VP", price: 200, status: "ACTIF", source: "WOOCOMMERCE", externalId: "301" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: "VP-M", attributes: { Taille: "M" }, source: "WOOCOMMERCE", externalId: "3001" },
    });
    const sibling = await prisma.productVariation.create({
      data: { productId: product.id, sku: "VP-L", attributes: { Taille: "L" }, source: "WOOCOMMERCE", externalId: "3002" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 20 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: sibling.id, quantityOnHand: 99 } });

    const { client, getProductCalls, getVariationCalls } = fakeWooClient({ variationStock: 15 });

    const ok = await pullStockForWooCommerceOwner(client, { variationId: variation.id }, { type: "INTEGRATION" });
    expect(ok).toBe(true);

    // Exactly one targeted call, for exactly this variation — never the
    // whole-product / catalog path.
    expect(getProductCalls).toHaveLength(0);
    expect(getVariationCalls).toEqual([{ productId: 301, variationId: 3001 }]);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: variation.id } });
    expect(item.quantityOnHand).toBe(15);

    // The sibling variation must be completely untouched.
    const siblingItem = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: sibling.id } });
    expect(siblingItem.quantityOnHand).toBe(99);
  });

  it("fetches exactly the one affected simple product for a productId owner", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "E", type: "ENTREPOT", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Simple", sku: "SP", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "401" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });

    const { client, getProductCalls, getVariationCalls } = fakeWooClient({ productStock: 6 });

    const ok = await pullStockForWooCommerceOwner(client, { productId: product.id }, { type: "INTEGRATION" });
    expect(ok).toBe(true);
    expect(getProductCalls).toEqual([401]);
    expect(getVariationCalls).toHaveLength(0);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(6);
  });

  it("is a no-op (and never throws) for a non-WooCommerce product", async () => {
    const product = await prisma.product.create({ data: { name: "Interne", sku: "INT-1", price: 100, status: "ACTIF" } });
    const { client } = fakeWooClient({ productStock: 6 });

    const ok = await pullStockForWooCommerceOwner(client, { productId: product.id }, { type: "INTEGRATION" });
    expect(ok).toBe(false);
  });
});
