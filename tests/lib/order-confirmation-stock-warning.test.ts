import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { flagInsufficientStock } from "@/lib/queries/order-confirmation";
import { resetDb } from "../helpers/db";

/**
 * Batch 3, Task 8 — backorder warning at order confirmation. Purely
 * informational (see the function's own doc comment): it must never block
 * anything, just flag which orders in the queue have at least one line
 * whose quantity exceeds current available stock (on-hand − reserved),
 * using the exact same definition as
 * `checkAndNotifyInsufficientStockForOrder` in src/lib/notifications.ts.
 */
describe("flagInsufficientStock", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  async function seedOrder(productId: string, quantity: number) {
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    return prisma.order.create({
      data: {
        customerId: customer.id,
        status: "NOUVELLE",
        subtotal: 100,
        total: 100,
        currency: "MAD",
        items: {
          create: [{ productId, nameSnapshot: "P", skuSnapshot: "SKU", unitPrice: 100, quantity, total: 100 * quantity }],
        },
      },
      include: { items: { select: { productId: true, variationId: true, quantity: true } } },
    });
  }

  it("flags an order whose line quantity exceeds available stock (on-hand − reserved)", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SW-1", price: 100, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5, quantityReserved: 3 } });
    // available = 5 - 3 = 2, order wants 4
    const order = await seedOrder(product.id, 4);

    const flagged = await flagInsufficientStock([order]);
    expect(flagged.has(order.id)).toBe(true);
  });

  it("does not flag an order that fits within available stock", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SW-2", price: 100, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10, quantityReserved: 0 } });
    const order = await seedOrder(product.id, 4);

    const flagged = await flagInsufficientStock([order]);
    expect(flagged.has(order.id)).toBe(false);
  });

  it("does not flag a product with no InventoryItem row at all (not stock-tracked)", async () => {
    const product = await prisma.product.create({ data: { name: "Service", sku: "SW-3", price: 100, status: "ACTIF", trackInventory: false } });
    const order = await seedOrder(product.id, 100);

    const flagged = await flagInsufficientStock([order]);
    expect(flagged.has(order.id)).toBe(false);
  });

  it("sums stock across every warehouse for the same product before comparing", async () => {
    const w1 = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const w2 = await prisma.warehouse.create({ data: { name: "B" } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SW-4", price: 100, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: w1.id, productId: product.id, quantityOnHand: 2, quantityReserved: 0 } });
    await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: product.id, quantityOnHand: 3, quantityReserved: 0 } });
    const order = await seedOrder(product.id, 5); // exactly the combined total — not a shortfall

    const flagged = await flagInsufficientStock([order]);
    expect(flagged.has(order.id)).toBe(false);
  });

  it("returns an empty set for an empty order list without querying anything unnecessary", async () => {
    const flagged = await flagInsufficientStock([]);
    expect(flagged.size).toBe(0);
  });
});
