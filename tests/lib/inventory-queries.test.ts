import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listInventoryItems, getLowStockCount } from "@/lib/queries/inventory";
import { resetDb } from "../helpers/db";

/**
 * Phase 32a — regression for moving inventory list filtering / pagination
 * and the low-stock count off JS-side full-table scans and into the DB.
 */
async function seedItems(specs: { onHand: number; threshold?: number; name: string }[]) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
  for (const s of specs) {
    const product = await prisma.product.create({
      data: {
        name: s.name,
        sku: `SKU-${s.name}-${Math.random()}`,
        price: 10,
        status: "ACTIF",
        lowStockThreshold: s.threshold ?? 5,
      },
    });
    await prisma.inventoryItem.create({
      data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: s.onHand },
    });
  }
  return warehouse;
}

describe("listInventoryItems (DB-side filtering & pagination)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("paginates in the database (page 2 returns the remainder, total is the full count)", async () => {
    await seedItems(Array.from({ length: 30 }, (_, i) => ({ name: `p${String(i).padStart(2, "0")}`, onHand: 100 })));

    const page1 = await listInventoryItems({ page: 1 });
    const page2 = await listInventoryItems({ page: 2 });

    expect(page1.total).toBe(30);
    expect(page1.items).toHaveLength(25);
    expect(page2.items).toHaveLength(5);
    // no overlap
    const ids = new Set(page1.items.map((i) => i.id));
    expect(page2.items.every((i) => !ids.has(i.id))).toBe(true);
  });

  it("filters by product name / sku search", async () => {
    await seedItems([
      { name: "Chemise", onHand: 50 },
      { name: "Pantalon", onHand: 50 },
      { name: "Robe", onHand: 50 },
    ]);
    const res = await listInventoryItems({ q: "pant" });
    expect(res.total).toBe(1);
    expect(res.items[0].product?.name).toBe("Pantalon");
  });

  it("low-stock filter returns exactly the rows at/under their product threshold, paginated", async () => {
    await seedItems([
      { name: "low-a", onHand: 2, threshold: 5 }, // low
      { name: "low-b", onHand: 5, threshold: 5 }, // low (== threshold)
      { name: "ok-a", onHand: 6, threshold: 5 }, // not low
      { name: "low-c", onHand: 0, threshold: 3 }, // low
      { name: "ok-b", onHand: 100, threshold: 5 }, // not low
    ]);

    const res = await listInventoryItems({ stockStatus: "low" });
    expect(res.total).toBe(3);
    const names = res.items.map((i) => i.product?.name).sort();
    expect(names).toEqual(["low-a", "low-b", "low-c"]);
  });

  it("low-stock filter also honours the search term", async () => {
    await seedItems([
      { name: "low-shirt", onHand: 1, threshold: 5 },
      { name: "low-pants", onHand: 1, threshold: 5 },
    ]);
    const res = await listInventoryItems({ stockStatus: "low", q: "shirt" });
    expect(res.total).toBe(1);
    expect(res.items[0].product?.name).toBe("low-shirt");
  });

  it("low-stock search treats an underscore in a SKU literally (not as a wildcard)", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "P", isDefault: true } });
    for (const sku of ["ABC_123", "ABCX123"]) {
      const product = await prisma.product.create({
        data: { name: sku, sku, price: 10, status: "ACTIF", lowStockThreshold: 5 },
      });
      await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 1 } });
    }
    const res = await listInventoryItems({ stockStatus: "low", q: "ABC_123" });
    expect(res.total).toBe(1);
    expect(res.items[0].product?.sku).toBe("ABC_123");
  });

  it("out-of-stock filter returns rows where available (on-hand minus reserved) is at or below zero", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "P2", isDefault: true } });
    const zero = await prisma.product.create({ data: { name: "zero", sku: `Z-${Math.random()}`, price: 10, status: "ACTIF" } });
    const reserved = await prisma.product.create({ data: { name: "reserved-out", sku: `R-${Math.random()}`, price: 10, status: "ACTIF" } });
    const inStock = await prisma.product.create({ data: { name: "in-stock", sku: `I-${Math.random()}`, price: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: zero.id, quantityOnHand: 0 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: reserved.id, quantityOnHand: 5, quantityReserved: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: inStock.id, quantityOnHand: 5 } });

    const res = await listInventoryItems({ stockStatus: "out" });
    const names = res.items.map((i) => i.product?.name).sort();
    expect(names).toEqual(["reserved-out", "zero"]);
  });

  it("filters by warehouse and by category, and sorts by quantity", async () => {
    const w1 = await prisma.warehouse.create({ data: { name: "W1", isDefault: true } });
    const w2 = await prisma.warehouse.create({ data: { name: "W2" } });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });
    const a = await prisma.product.create({ data: { name: "a", sku: `A-${Math.random()}`, price: 10, status: "ACTIF", categoryId: category.id } });
    const b = await prisma.product.create({ data: { name: "b", sku: `B-${Math.random()}`, price: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: w1.id, productId: a.id, quantityOnHand: 3 } });
    await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: b.id, quantityOnHand: 9 } });

    const byWarehouse = await listInventoryItems({ warehouseId: w1.id });
    expect(byWarehouse.items.map((i) => i.product?.name)).toEqual(["a"]);

    const byCategory = await listInventoryItems({ categoryId: category.id });
    expect(byCategory.items.map((i) => i.product?.name)).toEqual(["a"]);

    const sortedAsc = await listInventoryItems({ sort: "quantity-asc" });
    expect(sortedAsc.items.map((i) => i.quantityOnHand)).toEqual([3, 9]);
    const sortedDesc = await listInventoryItems({ sort: "quantity-desc" });
    expect(sortedDesc.items.map((i) => i.quantityOnHand)).toEqual([9, 3]);
  });
});

describe("getLowStockCount", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("counts every (warehouse, product|variation) row at/under threshold — variations use their parent product's threshold", async () => {
    const warehouse = await seedItems([
      { name: "low-1", onHand: 1, threshold: 5 },
      { name: "ok-1", onHand: 99, threshold: 5 },
    ]);

    // a variation whose parent product threshold is 10, stock 4 → low
    const parent = await prisma.product.create({
      data: { name: "Robe", sku: `R-${Math.random()}`, price: 100, status: "ACTIF", lowStockThreshold: 10 },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: parent.id, sku: `RV-${Math.random()}`, attributes: { Taille: "M" } },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 4 } });

    expect(await getLowStockCount()).toBe(2);
  });
});
