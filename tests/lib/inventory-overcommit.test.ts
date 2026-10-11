import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { InsufficientStockError, orderLineStockStates, reserveStockForOrder, stockRowKey } from "@/lib/inventory";
import { resetDb } from "../helpers/db";

/**
 * P2 — `maxOvercommit`: the per-row ceiling on `reserved − onHand`, checked on
 * the locked POST-update row (src/lib/inventory.ts). Real test database.
 */

async function seed(onHand: number, reserved = 0) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Sac", sku: `SAC-${Math.random()}`, price: 100, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: onHand, quantityReserved: reserved },
  });
  return { warehouse, product, item, key: stockRowKey(warehouse.id, { productId: product.id }) };
}

async function order(warehouseId: string, productId: string, quantities: number[]) {
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      fulfillmentWarehouseId: warehouseId,
      items: {
        create: quantities.map((q) => ({ productId, nameSnapshot: "Sac", skuSnapshot: "SAC", unitPrice: 100, quantity: q, total: 100 * q })),
      },
    },
    include: { items: true },
  });
}

const reserve = (o: { id: string; items: { productId: string | null; variationId: string | null; quantity: number }[] }, ceiling?: (k: string) => number | undefined) =>
  prisma.$transaction((tx) => reserveStockForOrder(tx, o.id, o.items, null, { ceiling }));

const reservedOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantityReserved;

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("maxOvercommit", () => {
  it("0 behaves exactly like enforceAvailable: allowed while covered, refused (and rolled back) beyond", async () => {
    const s = await seed(3);
    await reserve(await order(s.warehouse.id, s.product.id, [3]), () => 0);
    expect(await reservedOf(s.item.id)).toBe(3);
    await expect(reserve(await order(s.warehouse.id, s.product.id, [1]), () => 0)).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await reservedOf(s.item.id)).toBe(3);
    expect(await prisma.inventoryMovement.count({ where: { type: "RESERVATION" } })).toBe(1);
  });

  it("no ceiling = the historical non-blocking reservation", async () => {
    const s = await seed(1);
    await reserve(await order(s.warehouse.id, s.product.id, [5]));
    expect(await reservedOf(s.item.id)).toBe(5);
  });

  it("duplicate lines on one row share ONE cumulative allowance — each line cannot use it in full", async () => {
    const s = await seed(3);
    // 2 + 2 = 4 against 3 on hand → overcommit 1.
    await expect(reserve(await order(s.warehouse.id, s.product.id, [2, 2]), () => 0)).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await reservedOf(s.item.id)).toBe(0);
    await expect(reserve(await order(s.warehouse.id, s.product.id, [2, 2, 1]), () => 1)).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await reservedOf(s.item.id)).toBe(0);
    await reserve(await order(s.warehouse.id, s.product.id, [2, 2]), () => 1);
    expect(await reservedOf(s.item.id)).toBe(4);
  });

  it("orderLineStockStates aggregates duplicate lines by exact row and reports overcommit / over-reservation", async () => {
    const s = await seed(1, 2); // already over-reserved
    const states = await orderLineStockStates(
      prisma,
      [
        { productId: s.product.id, quantity: 1, trackInventory: true },
        { productId: s.product.id, quantity: 2, trackInventory: true },
      ],
      s.warehouse.id
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ kind: "tracked", rowKey: s.key, requested: 3, onHand: 1, reserved: 2, available: 0, overcommit: 4, short: true, overReserved: true });
  });

  it("concurrent reservations for the last unit: exactly one succeeds (row-locked post-update check)", async () => {
    const s = await seed(1);
    const a = await order(s.warehouse.id, s.product.id, [1]);
    const b = await order(s.warehouse.id, s.product.id, [1]);
    const results = await Promise.allSettled([reserve(a, () => 0), reserve(b, () => 0)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof InsufficientStockError)).toHaveLength(1);
    expect(await reservedOf(s.item.id)).toBe(1);
  });

  it("two overrides accepted from the SAME snapshot cannot both succeed — the second exceeds its accepted overcommit", async () => {
    const s = await seed(1);
    // Each shown: onHand 1, reserved 0, requested 2 → acceptedOvercommit 1.
    const a = await order(s.warehouse.id, s.product.id, [2]);
    const b = await order(s.warehouse.id, s.product.id, [2]);
    const results = await Promise.allSettled([reserve(a, () => 1), reserve(b, () => 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await reservedOf(s.item.id)).toBe(2);
  });

  it("multi-line orders with reversed line order never deadlock (deterministic lock order)", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const p1 = await prisma.product.create({ data: { name: "A", sku: "OC-A", price: 1, status: "ACTIF" } });
    const p2 = await prisma.product.create({ data: { name: "B", sku: "OC-B", price: 1, status: "ACTIF" } });
    await prisma.inventoryItem.createMany({
      data: [
        { warehouseId: warehouse.id, productId: p1.id, quantityOnHand: 1000 },
        { warehouseId: warehouse.id, productId: p2.id, quantityOnHand: 1000 },
      ],
    });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const make = (first: string, second: string) =>
      prisma.order.create({
        data: {
          customerId: customer.id,
          subtotal: 2,
          total: 2,
          fulfillmentWarehouseId: warehouse.id,
          items: {
            create: [
              { productId: first, nameSnapshot: "x", skuSnapshot: "x", unitPrice: 1, quantity: 1, total: 1 },
              { productId: second, nameSnapshot: "y", skuSnapshot: "y", unitPrice: 1, quantity: 1, total: 1 },
            ],
          },
        },
        include: { items: { orderBy: { id: "asc" } } },
      });
    for (let round = 0; round < 5; round++) {
      const forward = await make(p1.id, p2.id);
      const backward = await make(p2.id, p1.id);
      backward.items.reverse(); // submitted in the opposite order on purpose
      const results = await Promise.allSettled([reserve(forward, () => 0), reserve(backward, () => 0)]);
      expect(results.map((r) => r.status), `round ${round}`).toEqual(["fulfilled", "fulfilled"]);
    }
    const rows = await prisma.inventoryItem.findMany({ where: { warehouseId: warehouse.id } });
    expect(rows.map((r) => r.quantityReserved)).toEqual([10, 10]);
  });
});
