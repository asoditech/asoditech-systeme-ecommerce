import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listInventoryItems, getLowStockCount, listInventoryItemsForExport } from "@/lib/queries/inventory";
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

  // Batch 15 — Location Access Management v1 (docs/adr/0037): a scoped
  // caller's `allowedWarehouseIds` must be honoured even with no explicit
  // `warehouseId` filter (the previous gap: the plain /stock page and its
  // export had NO location scoping at all, unlike every other
  // location-aware surface in this app).
  it("allowedWarehouseIds restricts results even with no explicit warehouseId filter, in every stockStatus mode", async () => {
    const w1 = await prisma.warehouse.create({ data: { name: "W1", isDefault: true } });
    const w2 = await prisma.warehouse.create({ data: { name: "W2" } });
    const a = await prisma.product.create({ data: { name: "in-w1", sku: `A-${Math.random()}`, price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    const b = await prisma.product.create({ data: { name: "in-w2", sku: `B-${Math.random()}`, price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: w1.id, productId: a.id, quantityOnHand: 1 } }); // low
    await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: b.id, quantityOnHand: 1 } }); // low

    const restricted = await listInventoryItems({ allowedWarehouseIds: [w1.id] });
    expect(restricted.items.map((i) => i.product?.name)).toEqual(["in-w1"]);
    expect(restricted.total).toBe(1);

    const restrictedLow = await listInventoryItems({ stockStatus: "low", allowedWarehouseIds: [w1.id] });
    expect(restrictedLow.items.map((i) => i.product?.name)).toEqual(["in-w1"]);

    // An explicit warehouseId for a location outside the allowed set,
    // combined with the allowed set, must still yield nothing — never a
    // silent fallback to "unrestricted".
    const forged = await listInventoryItems({ warehouseId: w2.id, allowedWarehouseIds: [w1.id] });
    expect(forged.items).toHaveLength(0);

    // Zero accessible warehouses (a brand-new WAREHOUSE-role user with no
    // assignment yet) must show nothing — never "everything".
    const none = await listInventoryItems({ allowedWarehouseIds: [] });
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(0);
    const noneLow = await listInventoryItems({ stockStatus: "low", allowedWarehouseIds: [] });
    expect(noneLow.items).toHaveLength(0);

    // `null`/omitted means unrestricted (OWNER/ADMIN) — unchanged behaviour.
    const unrestricted = await listInventoryItems({});
    expect(unrestricted.total).toBe(2);
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

// Batch 3, Task 4 — General Stock CSV export: same filters/scope as the
// visible /stock table, plus the extra display columns (category, reference,
// barcode) the on-screen table doesn't need.
describe("listInventoryItemsForExport", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("includes category, reference, barcode, and the same on-hand/reserved/available figures as the page", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });
    const product = await prisma.product.create({
      data: { name: "Basket", sku: "BSK-1", reference: "MODEL-X", price: 200, status: "ACTIF", categoryId: category.id },
    });
    await prisma.barcode.create({ data: { code: "1234567890123", productId: product.id, isPrimary: true } });
    await prisma.inventoryItem.create({
      data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10, quantityReserved: 3, quantityDamaged: 1 },
    });

    const rows = await listInventoryItemsForExport({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productName: "Basket",
      reference: "MODEL-X",
      sku: "BSK-1",
      barcode: "1234567890123",
      categoryName: "Chaussures",
      warehouseName: "Principal",
      quantityOnHand: 10,
      quantityReserved: 3,
      available: 7,
      quantityDamaged: 1,
    });
  });

  it("returns every matching row unpaginated, unlike listInventoryItems' page of 25", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    for (let i = 0; i < 30; i++) {
      const product = await prisma.product.create({
        data: { name: `p${i}`, sku: `EXP-${i}`, price: 10, status: "ACTIF" },
      });
      await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 1 } });
    }
    const rows = await listInventoryItemsForExport({});
    expect(rows).toHaveLength(30);
  });

  it("respects the same warehouseId/categoryId/q filters as the page", async () => {
    const w1 = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const w2 = await prisma.warehouse.create({ data: { name: "B" } });
    const p1 = await prisma.product.create({ data: { name: "Chemise", sku: "CH-1", price: 50, status: "ACTIF" } });
    const p2 = await prisma.product.create({ data: { name: "Pantalon", sku: "PT-1", price: 50, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: w1.id, productId: p1.id, quantityOnHand: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: p2.id, quantityOnHand: 5 } });

    const byWarehouse = await listInventoryItemsForExport({ warehouseId: w1.id });
    expect(byWarehouse.map((r) => r.sku)).toEqual(["CH-1"]);

    const byQuery = await listInventoryItemsForExport({ q: "pant" });
    expect(byQuery.map((r) => r.sku)).toEqual(["PT-1"]);
  });

  it("honours the low/out stockStatus filter, same as the page's raw-SQL path", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const low = await prisma.product.create({ data: { name: "Bas", sku: "LOW-1", price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    const ok = await prisma.product.create({ data: { name: "Haut", sku: "OK-1", price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: low.id, quantityOnHand: 1 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: ok.id, quantityOnHand: 99 } });

    const lowRows = await listInventoryItemsForExport({ stockStatus: "low" });
    expect(lowRows.map((r) => r.sku)).toEqual(["LOW-1"]);
  });

  // Batch 15 — computed "Statut" export column (Rupture > Stock faible > OK).
  it("computes a stockStatus column: Rupture wins over Stock faible, OK otherwise", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const out = await prisma.product.create({ data: { name: "Rupture", sku: `OUT-${Math.random()}`, price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    const low = await prisma.product.create({ data: { name: "Faible", sku: `LOW-${Math.random()}`, price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    const ok = await prisma.product.create({ data: { name: "Ok", sku: `OK-${Math.random()}`, price: 10, status: "ACTIF", lowStockThreshold: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: out.id, quantityOnHand: 5, quantityReserved: 5 } }); // available 0
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: low.id, quantityOnHand: 2 } }); // <= threshold
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: ok.id, quantityOnHand: 99 } });

    const rows = await listInventoryItemsForExport({});
    const byName = new Map(rows.map((r) => [r.productName, r.stockStatus]));
    expect(byName.get("Rupture")).toBe("Rupture");
    expect(byName.get("Faible")).toBe("Stock faible");
    expect(byName.get("Ok")).toBe("OK");
  });

  // Batch 15 — Location Access Management v1: the export must never leak
  // stock from a warehouse the caller cannot access, with or without an
  // explicit warehouseId filter.
  it("allowedWarehouseIds restricts the export, and zero accessible warehouses exports nothing", async () => {
    const w1 = await prisma.warehouse.create({ data: { name: "W1", isDefault: true } });
    const w2 = await prisma.warehouse.create({ data: { name: "W2" } });
    const a = await prisma.product.create({ data: { name: "in-w1", sku: `EA-${Math.random()}`, price: 10, status: "ACTIF" } });
    const b = await prisma.product.create({ data: { name: "in-w2", sku: `EB-${Math.random()}`, price: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: w1.id, productId: a.id, quantityOnHand: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: b.id, quantityOnHand: 5 } });

    const restricted = await listInventoryItemsForExport({ allowedWarehouseIds: [w1.id] });
    expect(restricted.map((r) => r.productName)).toEqual(["in-w1"]);

    const forged = await listInventoryItemsForExport({ warehouseId: w2.id, allowedWarehouseIds: [w1.id] });
    expect(forged).toHaveLength(0);

    const none = await listInventoryItemsForExport({ allowedWarehouseIds: [] });
    expect(none).toHaveLength(0);
  });
});
