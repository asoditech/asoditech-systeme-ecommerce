import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "../helpers/db";

/**
 * DB-level guarantees from the Phase 32c migration
 * (20260903142733_stocktaking).
 */
describe("stocktake schema — DB constraints (Phase 32c)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  async function seed() {
    const warehouse = await prisma.warehouse.create({ data: { name: "E", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    const item = await prisma.inventoryItem.create({
      data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5 },
    });
    return { warehouse, product, item };
  }

  it("rejects a stocktake line with a negative countedQuantity (CHECK)", async () => {
    const { warehouse, item } = await seed();
    const session = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    await expect(
      prisma.stocktakeLine.create({
        data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: 5, countedQuantity: -1 },
      })
    ).rejects.toThrow();

    const ok = await prisma.stocktakeLine.create({
      data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: 5, countedQuantity: 0 },
    });
    expect(ok.countedQuantity).toBe(0);
  });

  it("allows a negative systemQuantityAtCount (historical on-hand drift)", async () => {
    const { warehouse, item } = await seed();
    const session = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    const line = await prisma.stocktakeLine.create({
      data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: -2 },
    });
    expect(line.systemQuantityAtCount).toBe(-2);
  });

  it("enforces one line per (session, inventoryItem)", async () => {
    const { warehouse, item } = await seed();
    const session = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    await prisma.stocktakeLine.create({
      data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: 5 },
    });
    await expect(
      prisma.stocktakeLine.create({
        data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: 5 },
      })
    ).rejects.toThrow();
  });

  it("enforces at most one EN_COURS session per warehouse (partial unique index)", async () => {
    const { warehouse } = await seed();
    await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    await expect(prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } })).rejects.toThrow();

    // once the first is terminal, a new one is allowed
    await prisma.stocktakeSession.updateMany({ where: { warehouseId: warehouse.id }, data: { status: "ANNULE" } });
    const second = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    expect(second.status).toBe("EN_COURS");

    // and two open sessions in DIFFERENT warehouses are fine
    const other = await prisma.warehouse.create({ data: { name: "E2" } });
    const third = await prisma.stocktakeSession.create({ data: { warehouseId: other.id } });
    expect(third.status).toBe("EN_COURS");
  });

  it("assigns a sequential sessionNumber", async () => {
    const { warehouse } = await seed();
    const w2 = await prisma.warehouse.create({ data: { name: "E2" } });
    const a = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    const b = await prisma.stocktakeSession.create({ data: { warehouseId: w2.id } });
    expect(b.sessionNumber).toBeGreaterThan(a.sessionNumber);
  });

  it("cascades line deletion with the session, and with the inventory item / product", async () => {
    const { warehouse, product, item } = await seed();
    const session = await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    const line = await prisma.stocktakeLine.create({
      data: { stocktakeSessionId: session.id, inventoryItemId: item.id, systemQuantityAtCount: 5 },
    });

    // deleting the product cascades InventoryItem -> StocktakeLine
    await prisma.product.delete({ where: { id: product.id } });
    expect(await prisma.stocktakeLine.count({ where: { id: line.id } })).toBe(0);

    // and deleting a session cascades its remaining lines
    const p2 = await prisma.product.create({ data: { name: "P2", sku: `S-${Math.random()}`, price: 10 } });
    const i2 = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: p2.id, quantityOnHand: 1 } });
    const l2 = await prisma.stocktakeLine.create({
      data: { stocktakeSessionId: session.id, inventoryItemId: i2.id, systemQuantityAtCount: 1 },
    });
    await prisma.stocktakeSession.delete({ where: { id: session.id } });
    expect(await prisma.stocktakeLine.count({ where: { id: l2.id } })).toBe(0);
  });

  it("blocks deleting a Warehouse that has stocktake history (onDelete: Restrict)", async () => {
    const { warehouse } = await seed();
    await prisma.stocktakeSession.create({ data: { warehouseId: warehouse.id } });
    await expect(prisma.warehouse.delete({ where: { id: warehouse.id } })).rejects.toThrow();
  });

  it("has the INVENTAIRE movement enum value and the inventory_movements.stocktakeSessionId column", async () => {
    const enumRows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'InventoryMovementType' AND e.enumlabel = 'INVENTAIRE'`;
    expect(enumRows).toHaveLength(1);
    const colRows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'inventory_movements' AND column_name = 'stocktakeSessionId'`;
    expect(colRows).toHaveLength(1);
  });
});
