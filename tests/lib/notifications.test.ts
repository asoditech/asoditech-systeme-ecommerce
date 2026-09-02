import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  notify,
  notifyNewOrder,
  notifyPaymentProblem,
  notifyOrderReturned,
  notifyShipmentFailed,
  notifySyncFailure,
  notifyConnectionError,
  checkAndNotifyLowStock,
} from "@/lib/notifications";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

describe("notify()", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("fans out only to users holding the recipient permission", async () => {
    const warehouse = await createTestUser({ role: "WAREHOUSE" }); // has inventory.view
    const sales = await createTestUser({ role: "SALES" }); // does not have inventory.view

    await notify({
      type: "STOCK_FAIBLE",
      title: "Stock faible : X",
      message: "msg",
      recipientPermission: "inventory.view",
    });

    const rows = await prisma.notification.findMany();
    const recipientIds = rows.map((r) => r.userId);
    expect(recipientIds).toContain(warehouse.id);
    expect(recipientIds).not.toContain(sales.id);
  });

  it("only reaches ACTIVE users, never DISABLED ones", async () => {
    const active = await createTestUser({ role: "ADMIN", status: "ACTIVE" });
    const disabled = await createTestUser({ role: "ADMIN", status: "DISABLED" });

    await notify({
      type: "NOUVELLE_COMMANDE",
      title: "Nouvelle commande",
      message: "msg",
      recipientPermission: "orders.view",
    });

    const rows = await prisma.notification.findMany();
    const recipientIds = rows.map((r) => r.userId);
    expect(recipientIds).toContain(active.id);
    expect(recipientIds).not.toContain(disabled.id);
  });

  it("excludes exceptUserId — the actor who just caused the event", async () => {
    const actor = await createTestUser({ role: "ADMIN" });
    const other = await createTestUser({ role: "ADMIN" });

    await notify({
      type: "NOUVELLE_COMMANDE",
      title: "Nouvelle commande",
      message: "msg",
      recipientPermission: "orders.view",
      exceptUserId: actor.id,
    });

    const rows = await prisma.notification.findMany();
    const recipientIds = rows.map((r) => r.userId);
    expect(recipientIds).toContain(other.id);
    expect(recipientIds).not.toContain(actor.id);
  });

  it("a keyless notification is never deduped against another keyless one", async () => {
    const user = await createTestUser({ role: "ADMIN" });
    await notify({ type: "NOUVELLE_COMMANDE", title: "A", message: "1", recipientPermission: "orders.view" });
    await notify({ type: "NOUVELLE_COMMANDE", title: "B", message: "2", recipientPermission: "orders.view" });

    const rows = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
  });

  it("a repeated dedupeKey for the same user is skipped, not duplicated", async () => {
    const user = await createTestUser({ role: "ADMIN" });
    await notify({
      type: "NOUVELLE_COMMANDE",
      title: "Nouvelle commande CMD-1",
      message: "m1",
      dedupeKey: "nouvelle_commande:order-1",
      recipientPermission: "orders.view",
    });
    // Same key, different content — simulates a retry after the caller's
    // own transaction committed but the response was lost.
    await notify({
      type: "NOUVELLE_COMMANDE",
      title: "Nouvelle commande CMD-1 (retry)",
      message: "m1 retry",
      dedupeKey: "nouvelle_commande:order-1",
      recipientPermission: "orders.view",
    });

    const rows = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Nouvelle commande CMD-1"); // the first write wins, never overwritten
  });

  it("concurrent duplicate calls for the same (user, dedupeKey) resolve to exactly one row", async () => {
    const user = await createTestUser({ role: "ADMIN" });
    const call = () =>
      notify({
        type: "ECHEC_LIVRAISON",
        title: "Échec de livraison",
        message: "msg",
        dedupeKey: "echec_livraison:shipment-race",
        recipientPermission: "orders.view",
      });

    await Promise.all([call(), call(), call(), call()]);

    const rows = await prisma.notification.findMany({ where: { userId: user.id, dedupeKey: "echec_livraison:shipment-race" } });
    expect(rows).toHaveLength(1);
  });

  it("truncates an overlong title/message rather than failing the write", async () => {
    await createTestUser({ role: "ADMIN" });
    await notify({
      type: "NOUVELLE_COMMANDE",
      title: "x".repeat(500),
      message: "y".repeat(1000),
      recipientPermission: "orders.view",
    });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.title.length).toBe(200);
    expect(row.message.length).toBe(500);
  });
});

describe("typed event helpers", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("notifyNewOrder — French title/message, dedupe by order id, tags an external source", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyNewOrder({
      id: "order-1",
      orderNumber: 42,
      total: 199.5,
      currency: "MAD",
      customerName: "Amine Tazi",
      source: "WOOCOMMERCE",
    });

    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("NOUVELLE_COMMANDE");
    expect(row.title).toContain("CMD-000042");
    expect(row.message).toContain("Amine Tazi");
    expect(row.message).toContain("WooCommerce");
    expect(row.entityType).toBe("Order");
    expect(row.entityId).toBe("order-1");
    expect(row.dedupeKey).toBe("nouvelle_commande:order-1");
  });

  it("notifyNewOrder — an internal (manual) order carries no source suffix", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyNewOrder({ id: "order-2", orderNumber: 7, total: 10, currency: "MAD", customerName: "Sara", source: "INTERNE" });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.message).not.toContain("importée");
  });

  it("notifyPaymentProblem", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyPaymentProblem({ id: "order-3", orderNumber: 5 });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("PROBLEME_PAIEMENT");
    expect(row.dedupeKey).toBe("probleme_paiement:order-3");
    expect(row.entityType).toBe("Order");
  });

  it("notifyOrderReturned", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyOrderReturned({ id: "order-4", orderNumber: 9, customerName: "Yassine" });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("COMMANDE_RETOURNEE");
    expect(row.message).toContain("Yassine");
  });

  it("notifyShipmentFailed — recipients gated on delivery.view, includes the reason when given", async () => {
    await createTestUser({ role: "WAREHOUSE" }); // has delivery.view
    await notifyShipmentFailed({ id: "ship-1", orderId: "order-5", orderNumber: 11, providerName: "Ozon Express", reason: "Client injoignable" });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("ECHEC_LIVRAISON");
    expect(row.message).toContain("Ozon Express");
    expect(row.message).toContain("Client injoignable");
    expect(row.dedupeKey).toBe("echec_livraison:ship-1");
  });

  it("notifySyncFailure — ECHEC vs PARTIEL word differently", async () => {
    await createTestUser({ role: "ADMIN" }); // has integrations.view
    await notifySyncFailure({ id: "run-1", provider: "WooCommerce", resource: "COMMANDES", status: "ECHEC", imported: 0, failed: 3 });
    let row = await prisma.notification.findFirstOrThrow();
    expect(row.title).toContain("Échec");

    await resetDb();
    await createTestUser({ role: "ADMIN" });
    await notifySyncFailure({ id: "run-2", provider: "Shopify", resource: "PRODUITS", status: "PARTIEL", imported: 4, failed: 1 });
    row = await prisma.notification.findFirstOrThrow();
    expect(row.title).toContain("partielle");
    expect(row.message).toContain("4 importé(s), 1 en échec");
  });

  it("notifyConnectionError — day-bucketed dedupe key", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyConnectionError({ entityType: "Integration", entityId: "int-1", label: "WooCommerce", recipientPermission: "integrations.view" });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("ERREUR_INTEGRATION");
    expect(row.dedupeKey).toMatch(/^erreur_connexion:int-1:\d{4}-\d{2}-\d{2}$/);
  });

  it("notifyConnectionError — a second failure the same day does not duplicate the alert", async () => {
    await createTestUser({ role: "ADMIN" });
    await notifyConnectionError({ entityType: "ShippingProvider", entityId: "sp-1", label: "Ozon Express", recipientPermission: "delivery.view" });
    await notifyConnectionError({ entityType: "ShippingProvider", entityId: "sp-1", label: "Ozon Express", recipientPermission: "delivery.view" });
    const rows = await prisma.notification.findMany();
    expect(rows).toHaveLength(1);
  });
});

describe("checkAndNotifyLowStock", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  async function seedProduct(quantityOnHand: number, lowStockThreshold = 5, trackInventory = true) {
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "T-shirt", sku: `SKU-${Math.random()}`, price: 100, status: "ACTIF", lowStockThreshold, trackInventory },
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand } });
    return { product, item };
  }

  it("fires RUPTURE_STOCK at exactly 0", async () => {
    await createTestUser({ role: "WAREHOUSE" }); // has inventory.view
    const { item } = await seedProduct(0);
    await checkAndNotifyLowStock({ productIds: [item.productId] });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("RUPTURE_STOCK");
  });

  it("fires STOCK_FAIBLE at/under the threshold but above 0", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    const { item } = await seedProduct(3, 5);
    await checkAndNotifyLowStock({ productIds: [item.productId] });
    const row = await prisma.notification.findFirstOrThrow();
    expect(row.type).toBe("STOCK_FAIBLE");
    expect(row.message).toContain("3 unité(s)");
  });

  it("does not fire above the threshold", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    const { item } = await seedProduct(50, 5);
    await checkAndNotifyLowStock({ productIds: [item.productId] });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("skips an untracked item entirely, even at 0", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    const { item } = await seedProduct(0, 5, false);
    await checkAndNotifyLowStock({ productIds: [item.productId] });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("re-fires at most once per day per item (day-bucketed dedupe)", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    const { item } = await seedProduct(0);
    await checkAndNotifyLowStock({ productIds: [item.productId] });
    await checkAndNotifyLowStock({ productIds: [item.productId] }); // same item, same day
    expect(await prisma.notification.count()).toBe(1);
  });

  it("no-ops silently when given no product/variation ids", async () => {
    await createTestUser({ role: "WAREHOUSE" });
    await expect(checkAndNotifyLowStock({})).resolves.toBeUndefined();
    expect(await prisma.notification.count()).toBe(0);
  });
});
