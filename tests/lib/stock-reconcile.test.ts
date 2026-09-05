import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileStockFromProvider } from "@/lib/integrations/shared/stock-reconcile";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

/**
 * reconcileStockFromProvider is the provider-agnostic "pull" half of
 * WooCommerce/Shopify inventory sync (docs/adr/0016-notifications.md §3).
 * Previously untested; covered here alongside the low-stock notification
 * this phase added to its downward branch.
 */
describe("reconcileStockFromProvider", () => {
  let warehouseId: string;
  let productId: string;

  beforeEach(async () => {
    await resetDb();
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Casquette", sku: "SKU-RECON-1", price: 100, status: "ACTIF", lowStockThreshold: 5 },
    });
    warehouseId = warehouse.id;
    productId = product.id;
  });
  afterEach(async () => {
    await resetDb();
  });

  it("creates a new InventoryItem on first sight, clamped at 0, no movement/audit row", async () => {
    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: -3, // a provider should never report negative, but never trust it either
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });
    expect(outcome).toBe("created");

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.quantityOnHand).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it("is a no-op when the external count already matches — no phantom movement", async () => {
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 10 } });
    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 10,
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });
    expect(outcome).toBe("unchanged");
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("an upward reconciliation records AJUSTEMENT_POSITIF and does not notify", async () => {
    await createTestUser({ role: "WAREHOUSE" }); // holds inventory.view
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 2 } });

    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 20,
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
    });
    expect(outcome).toBe("reconciled");

    const movement = await prisma.inventoryMovement.findFirstOrThrow();
    expect(movement.type).toBe("AJUSTEMENT_POSITIF");
    expect(movement.quantity).toBe(18);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("a downward reconciliation that crosses the threshold notifies inventory.view holders", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 20 } });

    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 3, // below the 5-unit threshold
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });
    expect(outcome).toBe("reconciled");

    const movement = await prisma.inventoryMovement.findFirstOrThrow();
    expect(movement.type).toBe("AJUSTEMENT_NEGATIF");
    expect(movement.quantity).toBe(17);

    const notification = await prisma.notification.findFirstOrThrow();
    expect(notification.type).toBe("STOCK_FAIBLE");
  });

  it("a downward reconciliation that stays above the threshold does not notify", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 20 } });

    await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 15, // still well above the 5-unit threshold
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });

    expect(await prisma.notification.count()).toBe(0);
  });

  it("excludes the triggering user from the low-stock notification", async () => {
    const actor = await createTestUser({ role: "WAREHOUSE" });
    const other = await createTestUser({ role: "WAREHOUSE" });
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 20 } });

    await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 0,
      actor: { type: "USER", userId: actor.id },
      source: "SHOPIFY",
    });

    const recipientIds = (await prisma.notification.findMany()).map((n) => n.userId);
    expect(recipientIds).toContain(other.id);
    expect(recipientIds).not.toContain(actor.id);
  });

  it("tags externalItemId onto the row and keeps it fresh on re-sync", async () => {
    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 5,
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
      externalItemId: "gid://shopify/InventoryItem/1",
    });
    expect(outcome).toBe("created");

    await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 5, // unchanged quantity, but a new external id
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
      externalItemId: "gid://shopify/InventoryItem/2",
    });

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.externalId).toBe("gid://shopify/InventoryItem/2");
  });

  describe("echo-loop guard (lastPushedQuantity)", () => {
    it("treats an inbound quantity matching this app's own recent push as unchanged — no movement, on-hand untouched", async () => {
      await prisma.inventoryItem.create({
        data: { warehouseId, productId, quantityOnHand: 10, quantityReserved: 3, lastPushedQuantity: 7, lastPushedAt: new Date() },
      });

      // This app pushed sellable stock (10 - 3 reserved = 7); the store's
      // webhook now echoes that exact number back. Reconciling it as a
      // genuine change would apply 7 as the new *on-hand* quantity,
      // silently discarding the 3 reserved units.
      const outcome = await reconcileStockFromProvider({
        productId,
        warehouseId,
        externalQuantity: 7,
        actor: { type: "INTEGRATION" },
        source: "WOOCOMMERCE",
      });
      expect(outcome).toBe("unchanged");

      const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
      expect(item.quantityOnHand).toBe(10);
      expect(item.quantityReserved).toBe(3);
      expect(await prisma.inventoryMovement.count()).toBe(0);
    });

    it("still reconciles a genuine external change even when it happens to equal an old push, once the echo window has passed", async () => {
      await prisma.inventoryItem.create({
        data: {
          warehouseId,
          productId,
          quantityOnHand: 10,
          quantityReserved: 3,
          lastPushedQuantity: 7,
          lastPushedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // a full day ago
        },
      });

      const outcome = await reconcileStockFromProvider({
        productId,
        warehouseId,
        externalQuantity: 7,
        actor: { type: "INTEGRATION" },
        source: "WOOCOMMERCE",
      });
      expect(outcome).toBe("reconciled");

      const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
      expect(item.quantityOnHand).toBe(7);
    });

    it("reconciles normally when the inbound quantity differs from the last pushed one", async () => {
      await prisma.inventoryItem.create({
        data: { warehouseId, productId, quantityOnHand: 10, quantityReserved: 3, lastPushedQuantity: 7, lastPushedAt: new Date() },
      });

      // A genuine independent change on the store side (e.g. a manual
      // admin edit), not this app's own echo.
      const outcome = await reconcileStockFromProvider({
        productId,
        warehouseId,
        externalQuantity: 4,
        actor: { type: "INTEGRATION" },
        source: "WOOCOMMERCE",
      });
      expect(outcome).toBe("reconciled");

      const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
      expect(item.quantityOnHand).toBe(4);
    });
  });
});
