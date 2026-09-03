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

    const res = await listInventoryItems({ lowStockOnly: true });
    expect(res.total).toBe(3);
    const names = res.items.map((i) => i.product?.name).sort();
    expect(names).toEqual(["low-a", "low-b", "low-c"]);
  });

  it("low-stock filter also honours the search term", async () => {
    await seedItems([
      { name: "low-shirt", onHand: 1, threshold: 5 },
      { name: "low-pants", onHand: 1, threshold: 5 },
    ]);
    const res = await listInventoryItems({ lowStockOnly: true, q: "shirt" });
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
    const res = await listInventoryItems({ lowStockOnly: true, q: "ABC_123" });
    expect(res.total).toBe(1);
    expect(res.items[0].product?.sku).toBe("ABC_123");
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
