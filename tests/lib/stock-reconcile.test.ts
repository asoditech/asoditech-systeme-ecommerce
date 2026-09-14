import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileStockFromProvider } from "@/lib/integrations/shared/stock-reconcile";
import { resetDb } from "../helpers/db";

/**
 * reconcileStockFromProvider is the provider-agnostic ONBOARDING half of
 * WooCommerce/Shopify inventory sync (docs/adr/0036-inventory-single-source
 * -of-truth.md). It may only ever INITIALIZE a missing InventoryItem row —
 * an existing row's quantityOnHand is never overwritten again, no matter
 * how far the provider's own number drifts.
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

  it("NEVER overwrites an existing row's quantityOnHand, even when the provider reports a higher number", async () => {
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 2 } });

    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 20,
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
    });
    expect(outcome).toBe("unchanged");

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.quantityOnHand).toBe(2); // untouched
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("NEVER overwrites an existing row's quantityOnHand, even when the provider reports a lower number", async () => {
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 20 } });

    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 3, // below the 5-unit threshold — must NOT trigger a low-stock alert either
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });
    expect(outcome).toBe("unchanged");

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.quantityOnHand).toBe(20); // untouched
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("a repeated onboarding sync of an already-known row never resets its local stock", async () => {
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 7 } });
    for (const externalQuantity of [0, 999, 7, 3]) {
      await reconcileStockFromProvider({
        productId,
        warehouseId,
        externalQuantity,
        actor: { type: "INTEGRATION" },
        source: "SHOPIFY",
      });
    }
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.quantityOnHand).toBe(7);
  });

  it("a product still missing locally can always receive its onboarding baseline", async () => {
    const otherProduct = await prisma.product.create({
      data: { name: "Nouveau", sku: "SKU-RECON-2", price: 50, status: "ACTIF" },
    });
    const outcome = await reconcileStockFromProvider({
      productId: otherProduct.id,
      warehouseId,
      externalQuantity: 42,
      actor: { type: "INTEGRATION" },
      source: "WOOCOMMERCE",
    });
    expect(outcome).toBe("created");
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: otherProduct.id } });
    expect(item.quantityOnHand).toBe(42);
  });

  it("tags externalItemId onto an existing row (identity mapping only — never touches quantityOnHand)", async () => {
    await prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand: 5 } });

    await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 999,
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
      externalItemId: "gid://shopify/InventoryItem/2",
    });

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.externalId).toBe("gid://shopify/InventoryItem/2");
    expect(item.quantityOnHand).toBe(5); // still untouched
  });

  it("tags externalItemId onto a newly-created row", async () => {
    const outcome = await reconcileStockFromProvider({
      productId,
      warehouseId,
      externalQuantity: 5,
      actor: { type: "INTEGRATION" },
      source: "SHOPIFY",
      externalItemId: "gid://shopify/InventoryItem/1",
    });
    expect(outcome).toBe("created");
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
    expect(item.externalId).toBe("gid://shopify/InventoryItem/1");
  });
});
