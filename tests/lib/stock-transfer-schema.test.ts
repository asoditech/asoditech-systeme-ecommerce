import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "../helpers/db";

/**
 * DB-level guarantees from the Phase 32b migration
 * (20260903131628_stock_transfers_and_order_fulfilment).
 */
describe("stock transfer schema — DB constraints (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  async function twoWarehouses() {
    const a = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const b = await prisma.warehouse.create({ data: { name: "B", type: "MAGASIN" } });
    return { a, b };
  }

  it("rejects a transfer whose source equals its destination (CHECK)", async () => {
    const { a } = await twoWarehouses();
    await expect(
      prisma.stockTransfer.create({ data: { sourceWarehouseId: a.id, destinationWarehouseId: a.id } })
    ).rejects.toThrow();
  });

  it("allows a transfer between two distinct warehouses", async () => {
    const { a, b } = await twoWarehouses();
    const t = await prisma.stockTransfer.create({
      data: { sourceWarehouseId: a.id, destinationWarehouseId: b.id },
    });
    expect(t.status).toBe("BROUILLON");
    expect(t.transferNumber).toBeGreaterThan(0);
  });

  it("rejects a line with quantitySent <= 0 and quantityReceived > quantitySent (CHECK)", async () => {
    const { a, b } = await twoWarehouses();
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    const t = await prisma.stockTransfer.create({
      data: { sourceWarehouseId: a.id, destinationWarehouseId: b.id },
    });

    await expect(
      prisma.stockTransferLine.create({ data: { stockTransferId: t.id, productId: product.id, quantitySent: 0 } })
    ).rejects.toThrow();

    await expect(
      prisma.stockTransferLine.create({
        data: { stockTransferId: t.id, productId: product.id, quantitySent: 5, quantityReceived: 6 },
      })
    ).rejects.toThrow();

    const ok = await prisma.stockTransferLine.create({
      data: { stockTransferId: t.id, productId: product.id, quantitySent: 5, quantityReceived: 3 },
    });
    expect(ok.quantityReceived).toBe(3);
  });

  it("cascades line deletion with the transfer; nulls product/variation refs on catalogue deletion", async () => {
    const { a, b } = await twoWarehouses();
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    const t = await prisma.stockTransfer.create({
      data: {
        sourceWarehouseId: a.id,
        destinationWarehouseId: b.id,
        lines: { create: [{ productId: product.id, quantitySent: 2 }] },
      },
      include: { lines: true },
    });

    // product delete → SetNull, line survives
    await prisma.product.delete({ where: { id: product.id } });
    const line = await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: t.lines[0].id } });
    expect(line.productId).toBeNull();

    // transfer delete → line cascades
    await prisma.stockTransfer.delete({ where: { id: t.id } });
    expect(await prisma.stockTransferLine.count({ where: { id: t.lines[0].id } })).toBe(0);
  });

  it("InventoryMovement.warehouseId is NOT NULL — a raw insert omitting it fails", async () => {
    const { a } = await twoWarehouses();
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    const item = await prisma.inventoryItem.create({
      data: { warehouseId: a.id, productId: product.id, quantityOnHand: 5 },
    });
    await expect(
      prisma.$executeRaw`INSERT INTO "inventory_movements" ("id", "inventoryItemId", "type", "quantity", "createdAt")
        VALUES ('m-test-1', ${item.id}, 'AJUSTEMENT_POSITIF', 1, now())`
    ).rejects.toThrow();
  });

  it("has the two new movement enum values", async () => {
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'InventoryMovementType'`;
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toContain("TRANSFERT_SORTIE");
    expect(labels).toContain("TRANSFERT_ENTREE");
  });

  it("a Warehouse referenced by a transfer cannot be deleted (onDelete: Restrict)", async () => {
    const { a, b } = await twoWarehouses();
    await prisma.stockTransfer.create({ data: { sourceWarehouseId: a.id, destinationWarehouseId: b.id } });
    await expect(prisma.warehouse.delete({ where: { id: a.id } })).rejects.toThrow();
  });
});
