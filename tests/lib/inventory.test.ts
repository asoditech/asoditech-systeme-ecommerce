import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applyStockMovement,
  availableStock,
  availableStockTotal,
  ensureInventoryItem,
  getDefaultWarehouseId,
  InsufficientStockError,
  reserveStockForOrder,
  fulfillStockForOrder,
  releaseStockForOrder,
  returnStockForOrder,
} from "@/lib/inventory";
import { resetDb } from "../helpers/db";

async function seedProductInWarehouses(quantities: { name: string; isDefault?: boolean; qty: number }[]) {
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-${Date.now()}-${Math.random()}`, price: 100, status: "ACTIF" },
  });
  const warehouses: Record<string, { id: string }> = {};
  for (const w of quantities) {
    const warehouse = await prisma.warehouse.create({
      data: { name: w.name, isDefault: w.isDefault ?? false },
    });
    await prisma.inventoryItem.create({
      data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: w.qty },
    });
    warehouses[w.name] = { id: warehouse.id };
  }
  return { product, warehouses };
}

const run = (input: Parameters<typeof applyStockMovement>[1]) =>
  prisma.$transaction((tx) => applyStockMovement(tx, input));

describe("availableStock / availableStockTotal", () => {
  it("is max(0, onHand - reserved) for every case", () => {
    expect(availableStock({ quantityOnHand: 10, quantityReserved: 3 })).toBe(7); // partial
    expect(availableStock({ quantityOnHand: 5, quantityReserved: 5 })).toBe(0); // fully reserved
    expect(availableStock({ quantityOnHand: 4, quantityReserved: 9 })).toBe(0); // reserved > onHand
    expect(availableStock({ quantityOnHand: 0, quantityReserved: 0 })).toBe(0); // zero
    expect(availableStock({ quantityOnHand: -2, quantityReserved: 0 })).toBe(0); // negative onHand (historical)
    expect(availableStock({ quantityOnHand: 12, quantityReserved: 0 })).toBe(12); // positive
  });

  it("availableStockTotal sums across rows and returns null for an empty set", () => {
    expect(availableStockTotal([])).toBeNull();
    expect(
      availableStockTotal([
        { quantityOnHand: 10, quantityReserved: 2 },
        { quantityOnHand: 20, quantityReserved: 5 },
      ])
    ).toBe(23);
    expect(
      availableStockTotal([
        { quantityOnHand: 1, quantityReserved: 5 },
        { quantityOnHand: 1, quantityReserved: 5 },
      ])
    ).toBe(0);
  });
});

describe("applyStockMovement — warehouse scoping", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("resolves the InventoryItem by (warehouseId, productId) and mutates only that row", async () => {
    const { product, warehouses } = await seedProductInWarehouses([
      { name: "Entrepôt A", isDefault: true, qty: 10 },
      { name: "Entrepôt B", qty: 20 },
    ]);

    const result = await run({
      warehouseId: warehouses["Entrepôt A"].id,
      productId: product.id,
      type: "AJUSTEMENT_NEGATIF",
      quantity: 4,
      onHandDelta: -4,
    });

    expect(result.applied).toBe(true);
    const a = await prisma.inventoryItem.findFirstOrThrow({
      where: { warehouseId: warehouses["Entrepôt A"].id, productId: product.id },
    });
    const b = await prisma.inventoryItem.findFirstOrThrow({
      where: { warehouseId: warehouses["Entrepôt B"].id, productId: product.id },
    });
    expect(a.quantityOnHand).toBe(6);
    expect(b.quantityOnHand).toBe(20); // untouched
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: a.id } })).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: b.id } })).toBe(0);
  });

  it("resolves a variation row by (warehouseId, variationId)", async () => {
    const product = await prisma.product.create({
      data: { name: "Robe", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `V-${Math.random()}`, attributes: { Couleur: "Rouge", Taille: "M" } },
    });
    const wa = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const wb = await prisma.warehouse.create({ data: { name: "B" } });
    const ia = await prisma.inventoryItem.create({ data: { warehouseId: wa.id, variationId: variation.id, quantityOnHand: 5 } });
    const ib = await prisma.inventoryItem.create({ data: { warehouseId: wb.id, variationId: variation.id, quantityOnHand: 8 } });

    await run({ warehouseId: wb.id, variationId: variation.id, type: "AJUSTEMENT_POSITIF", quantity: 3, onHandDelta: 3 });

    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ia.id } })).quantityOnHand).toBe(5);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ib.id } })).quantityOnHand).toBe(11);
  });

  it("is a no-op (no movement) when no InventoryItem exists for the (warehouse, product) pair", async () => {
    const { product } = await seedProductInWarehouses([{ name: "A", isDefault: true, qty: 10 }]);
    const other = await prisma.warehouse.create({ data: { name: "Ailleurs" } });

    const result = await run({
      warehouseId: other.id,
      productId: product.id,
      type: "AJUSTEMENT_NEGATIF",
      quantity: 1,
      onHandDelta: -1,
    });

    expect(result).toEqual({ applied: false, reason: "no_inventory_item" });
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } })).quantityOnHand).toBe(10);
  });

  it("throws InsufficientStockError and rolls back (no movement) when on-hand would go negative", async () => {
    const { product, warehouses } = await seedProductInWarehouses([{ name: "A", isDefault: true, qty: 3 }]);

    await expect(
      run({ warehouseId: warehouses["A"].id, productId: product.id, type: "VENTE", quantity: 5, onHandDelta: -5 })
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } })).quantityOnHand).toBe(3);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("when BOTH productId and variationId are given, targets the VARIATION row (order-line shape)", async () => {
    const product = await prisma.product.create({
      data: { name: "Robe", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `V-${Math.random()}`, attributes: { Taille: "M" } },
    });
    const w = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    // a product-level row AND a variation-level row at the same warehouse
    const pItem = await prisma.inventoryItem.create({ data: { warehouseId: w.id, productId: product.id, quantityOnHand: 50 } });
    const vItem = await prisma.inventoryItem.create({ data: { warehouseId: w.id, variationId: variation.id, quantityOnHand: 7 } });

    const result = await run({
      warehouseId: w.id,
      productId: product.id, // parent — present
      variationId: variation.id, // wins
      type: "VENTE",
      quantity: 2,
      onHandDelta: -2,
    });

    expect(result.applied).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: vItem.id } })).quantityOnHand).toBe(5);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: pItem.id } })).quantityOnHand).toBe(50); // untouched
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: pItem.id } })).toBe(0);
  });

  it("throws when NEITHER productId nor variationId is given", async () => {
    const w = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    await expect(
      run({ warehouseId: w.id, type: "AJUSTEMENT_NEGATIF", quantity: 1, onHandDelta: -1 })
    ).rejects.toThrow(/productId or a variationId/);
  });

  it("clamps a negative quantityReserved to 0 rather than failing", async () => {
    const { product, warehouses } = await seedProductInWarehouses([{ name: "A", isDefault: true, qty: 10 }]);
    // reserved starts at 0; releasing 2 would drive it to -2.
    const result = await run({
      warehouseId: warehouses["A"].id,
      productId: product.id,
      type: "LIBERATION",
      quantity: 2,
      onHandDelta: 0,
      reservedDelta: -2,
    });
    expect(result.applied).toBe(true);
    const row = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(row.quantityReserved).toBe(0);
  });
});

describe("applyStockMovement — concurrency & multi-warehouse (Phase 32a regression)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("Warehouse A / B scenario: concurrent mutations on A never touch B", async () => {
    const { product, warehouses } = await seedProductInWarehouses([
      { name: "Entrepôt A", isDefault: true, qty: 10 },
      { name: "Entrepôt B", qty: 20 },
    ]);
    const A = warehouses["Entrepôt A"].id;
    const B = warehouses["Entrepôt B"].id;

    // Two concurrent -6 against A: 10 can only satisfy one; the other must
    // roll back (post-update negative check under the row lock).
    const results = await Promise.allSettled([
      run({ warehouseId: A, productId: product.id, type: "VENTE", quantity: 6, onHandDelta: -6 }),
      run({ warehouseId: A, productId: product.id, type: "VENTE", quantity: 6, onHandDelta: -6 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(failed).toBe(1);

    const a = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: A, productId: product.id } });
    const b = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: B, productId: product.id } });
    expect(a.quantityOnHand).toBe(4); // deducted once, not twice
    expect(b.quantityOnHand).toBe(20); // completely untouched
  });

  it("concurrent mutations against BOTH warehouses each change only their own row", async () => {
    const { product, warehouses } = await seedProductInWarehouses([
      { name: "Entrepôt A", isDefault: true, qty: 10 },
      { name: "Entrepôt B", qty: 20 },
    ]);
    const A = warehouses["Entrepôt A"].id;
    const B = warehouses["Entrepôt B"].id;

    await Promise.all([
      run({ warehouseId: A, productId: product.id, type: "AJUSTEMENT_NEGATIF", quantity: 3, onHandDelta: -3 }),
      run({ warehouseId: B, productId: product.id, type: "AJUSTEMENT_POSITIF", quantity: 5, onHandDelta: 5 }),
    ]);

    const a = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: A, productId: product.id } });
    const b = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: B, productId: product.id } });
    expect(a.quantityOnHand).toBe(7);
    expect(b.quantityOnHand).toBe(25);
  });
});

describe("order stock helpers still resolve the default warehouse (Phase 32a)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("reserve → fulfill → return operate on the default-warehouse row when the product also sits elsewhere", async () => {
    const { product, warehouses } = await seedProductInWarehouses([
      { name: "Entrepôt principal", isDefault: true, qty: 10 },
      { name: "Boutique", qty: 4 },
    ]);
    const order = await prisma.order.create({
      data: {
        customerId: (await prisma.customer.create({ data: { fullName: "Client" } })).id,
        subtotal: 100,
        total: 100,
      },
    });
    const lines = [{ productId: product.id, variationId: null, quantity: 3 }];

    await prisma.$transaction((tx) => reserveStockForOrder(tx, order.id, lines, null));
    let def = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Entrepôt principal"].id } });
    let shop = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Boutique"].id } });
    expect(def).toMatchObject({ quantityOnHand: 10, quantityReserved: 3 });
    expect(shop).toMatchObject({ quantityOnHand: 4, quantityReserved: 0 });

    await prisma.$transaction((tx) => fulfillStockForOrder(tx, order.id, lines, null));
    def = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Entrepôt principal"].id } });
    expect(def).toMatchObject({ quantityOnHand: 7, quantityReserved: 0 });

    await prisma.$transaction((tx) => returnStockForOrder(tx, order.id, lines, null, "Retour client"));
    def = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Entrepôt principal"].id } });
    shop = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Boutique"].id } });
    expect(def.quantityOnHand).toBe(10);
    expect(shop.quantityOnHand).toBe(4); // never touched by any order movement
  });

  it("falls back to a product's single InventoryItem row when it has no row at the default warehouse", async () => {
    // Default warehouse exists but the product's only stock is at a store.
    await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "X", sku: `S-${Math.random()}`, price: 10, status: "ACTIF" } });
    const store = await prisma.warehouse.create({ data: { name: "Magasin", type: "MAGASIN" } });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: store.id, productId: product.id, quantityOnHand: 6 } });
    const order = await prisma.order.create({
      data: { customerId: (await prisma.customer.create({ data: { fullName: "C" } })).id, subtotal: 10, total: 10 },
    });

    await prisma.$transaction((tx) =>
      reserveStockForOrder(tx, order.id, [{ productId: product.id, variationId: null, quantity: 2 }], null)
    );
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityReserved).toBe(2);
  });

  it("an order line whose product was deleted (both ids null) is a silent no-op", async () => {
    const { warehouses } = await seedProductInWarehouses([{ name: "Entrepôt principal", isDefault: true, qty: 10 }]);
    const order = await prisma.order.create({
      data: { customerId: (await prisma.customer.create({ data: { fullName: "C" } })).id, subtotal: 10, total: 10 },
    });
    await prisma.$transaction((tx) =>
      reserveStockForOrder(tx, order.id, [{ productId: null, variationId: null, quantity: 2 }], null)
    );
    // nothing changed, no movement, no throw
    expect(await prisma.inventoryMovement.count()).toBe(0);
    const row = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Entrepôt principal"].id } });
    expect(row).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it("releaseStockForOrder undoes a reservation", async () => {
    const { product } = await seedProductInWarehouses([{ name: "Entrepôt principal", isDefault: true, qty: 10 }]);
    const order = await prisma.order.create({
      data: { customerId: (await prisma.customer.create({ data: { fullName: "C" } })).id, subtotal: 10, total: 10 },
    });
    const lines = [{ productId: product.id, variationId: null, quantity: 4 }];
    await prisma.$transaction((tx) => reserveStockForOrder(tx, order.id, lines, null));
    await prisma.$transaction((tx) => releaseStockForOrder(tx, order.id, lines, null));
    const row = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(row).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it("honours the order's explicit fulfillmentWarehouseId, leaving the default warehouse untouched", async () => {
    const { product, warehouses } = await seedProductInWarehouses([
      { name: "Entrepôt principal", isDefault: true, qty: 10 },
      { name: "Boutique", qty: 8 },
    ]);
    const order = await prisma.order.create({
      data: {
        customerId: (await prisma.customer.create({ data: { fullName: "C" } })).id,
        subtotal: 10,
        total: 10,
        fulfillmentWarehouseId: warehouses["Boutique"].id,
      },
    });
    const lines = [{ productId: product.id, variationId: null, quantity: 3 }];
    await prisma.$transaction((tx) => reserveStockForOrder(tx, order.id, lines, null));
    await prisma.$transaction((tx) => fulfillStockForOrder(tx, order.id, lines, null));

    const def = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Entrepôt principal"].id } });
    const shop = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouses["Boutique"].id } });
    expect(def).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(shop.quantityOnHand).toBe(5);
    const movements = await prisma.inventoryMovement.findMany({ where: { orderId: order.id } });
    expect(movements.every((m) => m.warehouseId === warehouses["Boutique"].id)).toBe(true);
  });
});

describe("getDefaultWarehouseId (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("returns the default warehouse's id, null when none, and is tx-aware", async () => {
    expect(await getDefaultWarehouseId()).toBeNull();

    await prisma.warehouse.create({ data: { name: "Autre", isDefault: false } });
    expect(await getDefaultWarehouseId()).toBeNull();

    const def = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    expect(await getDefaultWarehouseId()).toBe(def.id);

    const inTx = await prisma.$transaction((tx) => getDefaultWarehouseId(tx));
    expect(inTx).toBe(def.id);
  });
});

describe("ensureInventoryItem (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  async function seed() {
    const warehouse = await prisma.warehouse.create({ data: { name: "Dest", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: 10, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `V-${Math.random()}`, attributes: { Taille: "M" } },
    });
    return { warehouse, product, variation };
  }

  it("creates a missing row with zero quantities, then returns the existing row unchanged", async () => {
    const { warehouse, product } = await seed();

    const created = await prisma.$transaction((tx) =>
      ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id })
    );
    expect(created).toMatchObject({ quantityOnHand: 0, quantityReserved: 0, productId: product.id });

    await prisma.inventoryItem.update({ where: { id: created.id }, data: { quantityOnHand: 12 } });
    const again = await prisma.$transaction((tx) =>
      ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id })
    );
    expect(again.id).toBe(created.id);
    expect(again.quantityOnHand).toBe(12); // untouched
    expect(await prisma.inventoryItem.count({ where: { warehouseId: warehouse.id, productId: product.id } })).toBe(1);
  });

  it("variationId wins when both refs are supplied; throws when neither is given", async () => {
    const { warehouse, product, variation } = await seed();
    const row = await prisma.$transaction((tx) =>
      ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id, variationId: variation.id })
    );
    expect(row.variationId).toBe(variation.id);
    expect(row.productId).toBeNull();

    await expect(
      prisma.$transaction((tx) => ensureInventoryItem(tx, { warehouseId: warehouse.id }))
    ).rejects.toThrow(/productId or a variationId/);
  });

  it("concurrent calls for the same pair produce exactly one row", async () => {
    const { warehouse, product } = await seed();
    const results = await Promise.all([
      prisma.$transaction((tx) => ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id })),
      prisma.$transaction((tx) => ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id })),
      prisma.$transaction((tx) => ensureInventoryItem(tx, { warehouseId: warehouse.id, productId: product.id })),
    ]);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await prisma.inventoryItem.count({ where: { warehouseId: warehouse.id, productId: product.id } })).toBe(1);
  });
});
