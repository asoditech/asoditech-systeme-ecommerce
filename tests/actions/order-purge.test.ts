import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction } from "@/actions/orders";
import { previewOrderPurgeAction, purgeTestOrderAction } from "@/actions/order-purge";
import { validatePackingAction } from "@/actions/packing";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Controlled purge of a test order: stock released only through the domain
 * function, inventory movements and audit history kept, numbers never reused.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** A simple product (on hand 10) + an order of 2 units moved through `steps`. */
async function seedOrder(steps: ("CONFIRMEE" | "EN_PREPARATION" | "EXPEDIEE")[] = []) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "1 Rue X",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "Maroc",
    shippingPhone: "0611223344",
    items: [{ productId: product.id, quantity: 2, unitPrice: 50, discount: 0 }],
  });
  if (!created.ok) throw new Error(created.error);
  for (const status of steps) {
    const r = await updateOrderStatusAction(fd({ id: created.data.id, status }));
    if (!r.ok) throw new Error(r.error);
  }
  return { orderId: created.data.id, product, item, customer, warehouse };
}

const stock = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id } });
const purge = (orderId: string, reason = "Commande de test") => purgeTestOrderAction({ orderId, reason });

describe("purgeTestOrderAction — permission and input", () => {
  it("OWNER / ADMIN only; a reason is required", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId } = await seedOrder();
    for (const role of ["MANAGER", "CONFIRMATION"] as const) {
      mockCookieStore.clear();
      await loginAsTestUser({ role });
      await expect(purge(orderId), role).rejects.toThrow(/non autorisé/i);
      await expect(previewOrderPurgeAction(orderId), role).rejects.toThrow(/non autorisé/i);
    }
    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER" });
    expect(await purge(orderId, " ")).toEqual({ ok: false, error: "Indiquez le motif de la purge.", fieldErrors: undefined });
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
  });
});

describe("purgeTestOrderAction — eligible orders", () => {
  it("NOUVELLE: order, lines, confirmation attempts and its notifications removed; audit kept + order.purged; stock untouched", async () => {
    const owner = await loginAsTestUser({ role: "OWNER" });
    const { orderId, item } = await seedOrder();
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await prisma.notification.create({ data: { userId: owner.id, type: "NOUVELLE_COMMANDE", title: "Nouvelle commande", message: "x", entityType: "Order", entityId: orderId } });
    await prisma.notification.create({ data: { userId: owner.id, type: "NOUVELLE_COMMANDE", title: "Autre", message: "y", entityType: "Order", entityId: "another-order" } });
    const auditBefore = await prisma.auditEvent.count({ where: { entityId: orderId } });

    expect(await previewOrderPurgeAction(orderId)).toMatchObject({ ok: true, data: { eligible: true, preview: { releaseReservation: false } } });
    expect(await purge(orderId)).toMatchObject({ ok: true, data: { id: orderId, label: "CMD-000001" } });

    expect(await prisma.order.count({ where: { id: orderId } })).toBe(0);
    expect(await prisma.orderItem.count({ where: { orderId } })).toBe(0);
    expect(await prisma.notification.count({ where: { entityId: orderId } })).toBe(0);
    expect(await prisma.notification.count({ where: { entityId: "another-order" } })).toBe(1); // only this order's
    expect(await prisma.auditEvent.count({ where: { entityId: orderId, action: { not: "order.purged" } } })).toBe(auditBefore); // history kept
    const purged = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: orderId, action: "order.purged" } });
    expect(purged.actorUserId).toBe(owner.id);
    expect(purged.previousValue).toMatchObject({
      orderNumber: before.orderNumber,
      label: "CMD-000001",
      status: "NOUVELLE",
      total: "100",
      lines: [{ name: "Casquette", sku: "CAP-1", quantity: 2 }],
    });
    expect(purged.metadata).toMatchObject({ reason: "Commande de test", reservationReleased: false });
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
  });

  it("CONFIRMEE: the reservation is released through releaseStockForOrder; movements are kept", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder(["CONFIRMEE"]);
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 2 });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id } });
    expect(movementsBefore.map((m) => m.type)).toEqual(["RESERVATION"]);

    expect((await purge(orderId)).ok).toBe(true);
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    const after = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(after.map((m) => m.type)).toEqual(["RESERVATION", "LIBERATION"]); // nothing deleted, one release added
    expect(after.every((m) => m.orderId === null)).toBe(true); // link cleared by the DB, rows kept
    expect(after.find((m) => m.id === movementsBefore[0].id)).toBeTruthy();
  });

  it("REGRESSION — CONFIRMEE → EN_PREPARATION (packed) → purge: reservation released once, on-hand unchanged, packing data harmless", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder(["CONFIRMEE", "EN_PREPARATION"]);
    // Packing verified, as a real operator would before shipping.
    expect((await validatePackingAction({ orderId, codes: ["CAP-1", "CAP-1"] })).ok).toBe(true);
    const packed = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(packed).toMatchObject({ status: "EN_PREPARATION", packingMethod: "SCAN" });
    expect(packed.packedAt).not.toBeNull();
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 2 }); // packing never moves stock
    const movementCountBefore = await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id } });

    expect((await purge(orderId)).ok).toBe(true);

    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(movements).toHaveLength(movementCountBefore + 1);
    expect(movements.map((m) => m.type)).toEqual(["RESERVATION", "LIBERATION"]);
    expect(movements.filter((m) => m.type === "LIBERATION")).toHaveLength(1); // released exactly once
    expect(movements.every((m) => (m.onHandDelta ?? 0) === 0)).toBe(true); // on-hand never touched
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: orderId, action: "order.purged" } });
    expect(audit.metadata).toMatchObject({ reservationReleased: true });
  });

  it("ANNULEE after confirmation: the cancel already released — no second release", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder(["CONFIRMEE"]);
    expect((await cancelOrderAction(fd({ id: orderId, reason: "test" }))).ok).toBe(true);
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect((await purge(orderId)).ok).toBe(true);
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    const types = (await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } })).map((m) => m.type);
    expect(types).toEqual(["RESERVATION", "LIBERATION"]);
  });

  it("failed shipment attempts (ECHEC, no carrier id) are deleted with the order", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId } = await seedOrder(["CONFIRMEE"]);
    const provider = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "API", providerKey: "ozonexpress" } });
    await prisma.shipment.create({ data: { orderId, providerId: provider.id, status: "ECHEC", failedReason: "Ville inconnue" } });
    expect((await purge(orderId)).ok).toBe(true);
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(0);
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(0);
  });

  it("order numbers are never reused after a purge", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const first = await seedOrder();
    const purged = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } });
    expect((await purge(first.orderId)).ok).toBe(true);
    const next = await createOrderAction({
      customerId: first.customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      notes: "",
      internalNotes: "",
      shippingAddressLine1: "",
      shippingAddressLine2: "",
      shippingCity: "",
      shippingRegion: "",
      shippingCountry: "",
      shippingPhone: "",
      items: [{ productId: first.product.id, quantity: 1, unitPrice: 50, discount: 0 }],
    });
    if (!next.ok) throw new Error(next.error);
    const created = await prisma.order.findUniqueOrThrow({ where: { id: next.data.id } });
    expect(created.orderNumber).toBeGreaterThan(purged.orderNumber);
    expect(created.displayNumber).toBeGreaterThan(purged.displayNumber ?? 0);
  });

  it("two concurrent purges: one succeeds, the other finds nothing — never a double release", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder(["CONFIRMEE"]);
    const results = await Promise.all([purge(orderId), purge(orderId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: "Commande introuvable." });
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id, type: "LIBERATION" } })).toBe(1);
  });
});

describe("purgeTestOrderAction — refused orders stay exactly as they were", () => {
  async function expectRefused(orderId: string, itemId: string, re: RegExp) {
    const stockBefore = await stock(itemId);
    const movementsBefore = await prisma.inventoryMovement.count({ where: { inventoryItemId: itemId } });
    const r = await purge(orderId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
    expect(await stock(itemId)).toMatchObject({ quantityOnHand: stockBefore.quantityOnHand, quantityReserved: stockBefore.quantityReserved });
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: itemId } })).toBe(movementsBefore);
    expect(await prisma.auditEvent.count({ where: { action: "order.purged" } })).toBe(0);
  }

  it("shipped (EXPEDIEE): stock was deducted", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder(["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE"]);
    expect(await stock(item.id)).toMatchObject({ quantityOnHand: 8, quantityReserved: 0 });
    await expectRefused(orderId, item.id, /expédiée/);
  });

  it("imported WooCommerce / Shopify order", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { orderId, item } = await seedOrder();
    await prisma.order.update({ where: { id: orderId }, data: { source: "WOOCOMMERCE", externalId: "9001" } });
    await expectRefused(orderId, item.id, /réimportée/);
  });

  it("a real carrier parcel (externalId), a manual shipment", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const a = await seedOrder(["CONFIRMEE"]);
    const api = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "API", providerKey: "ozonexpress" } });
    await prisma.shipment.create({ data: { orderId: a.orderId, providerId: api.id, status: "EN_ATTENTE", externalId: "OZE-1", trackingNumber: "OZE-1" } });
    await expectRefused(a.orderId, a.item.id, /transporteur \(OZE-1\)/);
    expect(await prisma.shipment.count({ where: { orderId: a.orderId } })).toBe(1);

    const manual = await prisma.shippingProvider.create({ data: { name: "Livreur", type: "MANUEL" } });
    await prisma.shipment.deleteMany({ where: { orderId: a.orderId } }); // fixture reset (test data only)
    await prisma.shipment.create({ data: { orderId: a.orderId, providerId: manual.id, status: "EN_ATTENTE", trackingNumber: "MAN-1" } });
    await expectRefused(a.orderId, a.item.id, /expédition/);
  });

  it("a refund, a physical return, a commission entry", async () => {
    const owner = await loginAsTestUser({ role: "ADMIN" });
    const r = await seedOrder();
    await prisma.refund.create({ data: { orderId: r.orderId, amount: 10 } });
    await expectRefused(r.orderId, r.item.id, /remboursement/);
    await prisma.refund.deleteMany({ where: { orderId: r.orderId } });

    await prisma.orderReturn.create({ data: { orderId: r.orderId, idempotencyKey: "k1" } });
    await expectRefused(r.orderId, r.item.id, /retour physique/);
    await prisma.orderReturn.deleteMany({ where: { orderId: r.orderId } });

    const agent = await prisma.commissionAgent.create({ data: { userId: owner.id, ratePerOrder: 10 } });
    await prisma.commissionEntry.create({ data: { orderId: r.orderId, agentId: agent.id, type: "EARNED", amount: 10, rateApplied: 10 } });
    await expectRefused(r.orderId, r.item.id, /commission/);
  });
});
