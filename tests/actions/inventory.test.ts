import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { adjustInventoryAction } from "@/actions/inventory";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedInventoryItem(quantity = 10) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-INV-1", price: 100 } });
  const item = await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: quantity },
  });
  return { warehouse, product, item };
}

describe("adjustInventoryAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without inventory.adjust permission", async () => {
    const { warehouse, product } = await seedInventoryItem();
    await loginAsTestUser({ role: "SALES" });
    await expect(
      adjustInventoryAction(
        formData({
          productId: product.id,
          warehouseId: warehouse.id,
          type: "AJUSTEMENT_POSITIF",
          quantity: "5",
          reason: "Réception fournisseur",
        })
      )
    ).rejects.toThrow(/non autorisé/i);
  });

  it("increases on-hand stock and records the movement", async () => {
    const { warehouse, product } = await seedInventoryItem(10);
    const user = await loginAsTestUser({ role: "WAREHOUSE" });

    const result = await adjustInventoryAction(
      formData({
        productId: product.id,
        warehouseId: warehouse.id,
        type: "RECEPTION",
        quantity: "5",
        reason: "Réception fournisseur",
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.quantityOnHand).toBe(15);

    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { type: "RECEPTION" },
    });
    expect(movement.quantity).toBe(5);
    expect(movement.performedById).toBe(user.id);
  });

  it("rejects an adjustment that would make stock negative", async () => {
    const { warehouse, product } = await seedInventoryItem(3);
    await loginAsTestUser({ role: "WAREHOUSE" });

    const result = await adjustInventoryAction(
      formData({
        productId: product.id,
        warehouseId: warehouse.id,
        type: "AJUSTEMENT_NEGATIF",
        quantity: "10",
        reason: "Inventaire physique",
      })
    );
    expect(result.ok).toBe(false);
  });

  it("requires a reason for every adjustment", async () => {
    const { warehouse, product } = await seedInventoryItem();
    await loginAsTestUser({ role: "WAREHOUSE" });

    const result = await adjustInventoryAction(
      formData({ productId: product.id, warehouseId: warehouse.id, type: "AJUSTEMENT_POSITIF", quantity: "5", reason: "" })
    );
    expect(result.ok).toBe(false);
  });

  it("tracks damaged quantity separately when type is ENDOMMAGE", async () => {
    const { warehouse, product } = await seedInventoryItem(10);
    await loginAsTestUser({ role: "WAREHOUSE" });

    const result = await adjustInventoryAction(
      formData({
        productId: product.id,
        warehouseId: warehouse.id,
        type: "ENDOMMAGE",
        quantity: "2",
        reason: "Colis endommagé en transit",
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.quantityOnHand).toBe(8);
      expect(result.data.quantityDamaged).toBe(2);
    }
  });

  it("prevents negative stock under two genuinely concurrent adjustments (audit fix)", async () => {
    const { warehouse, product } = await seedInventoryItem(5);
    await loginAsTestUser({ role: "WAREHOUSE" });

    // Both requests read stock=5 and each individually asks to remove 5 —
    // a stale-read pre-check would let both pass and land on -5. Only one
    // may succeed.
    const [first, second] = await Promise.all([
      adjustInventoryAction(
        formData({ productId: product.id, warehouseId: warehouse.id, type: "AJUSTEMENT_NEGATIF", quantity: "5", reason: "Sortie A" })
      ),
      adjustInventoryAction(
        formData({ productId: product.id, warehouseId: warehouse.id, type: "AJUSTEMENT_NEGATIF", quantity: "5", reason: "Sortie B" })
      ),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(0);
  });

  it("the InventoryItem exactly-one-reference DB constraint rejects a row with neither productId nor variationId (audit fix)", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt secondaire" } });
    await expect(
      prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, quantityOnHand: 0 } })
    ).rejects.toThrow();
  });

  it("notifies inventory.view holders when an adjustment drops stock to/below the threshold (docs/adr/0016-notifications.md)", async () => {
    const { warehouse, product } = await seedInventoryItem(10); // default lowStockThreshold is 5
    const actor = await loginAsTestUser({ role: "WAREHOUSE" });
    const teammate = await createTestUser({ role: "MANAGER" }); // also holds inventory.view

    const result = await adjustInventoryAction(
      formData({ productId: product.id, warehouseId: warehouse.id, type: "AJUSTEMENT_NEGATIF", quantity: "7", reason: "Inventaire physique" })
    );
    expect(result.ok).toBe(true);

    const notifications = await prisma.notification.findMany();
    expect(notifications.every((n) => n.type === "STOCK_FAIBLE")).toBe(true);
    const recipientIds = notifications.map((n) => n.userId);
    expect(recipientIds).toContain(teammate.id);
    expect(recipientIds).not.toContain(actor.id);
  });

  it("does not notify when the adjustment increases stock, even from a low starting point", async () => {
    const { warehouse, product } = await seedInventoryItem(2);
    await loginAsTestUser({ role: "WAREHOUSE" });
    await createTestUser({ role: "MANAGER" });

    await adjustInventoryAction(
      formData({ productId: product.id, warehouseId: warehouse.id, type: "RECEPTION", quantity: "20", reason: "Réception fournisseur" })
    );

    expect(await prisma.notification.count()).toBe(0);
  });
});
