import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function seedNouvelleOrder(qty = 3) {
  const warehouse = await prisma.warehouse.create({
    data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true },
  });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: "SKU-CONF-1", price: 100, cost: 40, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 },
  });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi", phone: "0612345678" } });

  // createOrderAction needs an authenticated orders.create user; the
  // calling test re-logs-in as the role under test afterwards.
  await loginAsTestUser({ role: "OWNER" });
  const res = await createOrderAction({
    customerId: customer.id,
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
    items: [{ productId: product.id, quantity: qty, unitPrice: 100, discount: 0 }],
  });
  if (!res.ok) throw new Error("order seed failed");
  return { orderId: res.data.id, product, warehouse, customer };
}

describe("recordConfirmationAttemptAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a role without orders.confirm", async () => {
    const { orderId } = await seedNouvelleOrder();
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(
      recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))
    ).rejects.toThrow(/non autoris/i);
  });

  it("a no-answer attempt is logged, the order stays NOUVELLE, and the counter bumps", async () => {
    const { orderId } = await seedNouvelleOrder();
    await loginAsTestUser({ role: "CONFIRMATION" });

    const res = await recordConfirmationAttemptAction(
      fd({ id: orderId, outcome: "PAS_DE_REPONSE", note: "sonne dans le vide" })
    );
    expect(res.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("NOUVELLE");
    expect(order.confirmationAttemptCount).toBe(1);
    expect(order.lastConfirmationAttemptAt).not.toBeNull();

    const attempts = await prisma.orderConfirmationAttempt.findMany({ where: { orderId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe("PAS_DE_REPONSE");
    expect(attempts[0].note).toBe("sonne dans le vide");
  });

  it("CONFIRME moves the order to CONFIRMEE and auto-credits a caller who is a commission agent", async () => {
    const { orderId } = await seedNouvelleOrder();
    const me = await loginAsTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({ data: { userId: me.id, ratePerOrder: 12 } });

    const res = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));
    expect(res.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmedAt).not.toBeNull();
    expect(order.confirmationAgentId).toBe(agent.id);
  });

  it("CONFIRME does not overwrite an agent already assigned to the order", async () => {
    const { orderId } = await seedNouvelleOrder();
    const other = await createTestUser({ role: "CONFIRMATION" });
    const otherAgent = await prisma.commissionAgent.create({ data: { userId: other.id, ratePerOrder: 10 } });
    await prisma.order.update({ where: { id: orderId }, data: { confirmationAgentId: otherAgent.id } });

    const me = await loginAsTestUser({ role: "CONFIRMATION" });
    await prisma.commissionAgent.create({ data: { userId: me.id, ratePerOrder: 15 } });

    await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.confirmationAgentId).toBe(otherAgent.id);
  });

  it("CONFIRME reserves stock; ANNULE from NOUVELLE touches no stock (ADR 0030)", async () => {
    const { orderId, product } = await seedNouvelleOrder(3);
    // A NOUVELLE order reserves nothing.
    let item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityReserved).toBe(0);

    await loginAsTestUser({ role: "CONFIRMATION" });
    const res = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));
    expect(res.ok).toBe(true);

    item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityReserved).toBe(3);
  });

  // Audit fix (docs/adr/0030's own stated intent, not previously enforced):
  // a WooCommerce/Shopify order's stock is already accounted for by the
  // separate provider stock pull-sync — the store reduces its own stock the
  // moment the order is paid/processing, and that gets mirrored into
  // `quantityOnHand` directly. Reserving it AGAIN here double-deducted the
  // same physical units once the order was later shipped through this
  // queue (the "Stock insuffisant" incident this fixes).
  it("CONFIRME does NOT reserve stock for a WooCommerce-sourced order (docs/adr/0030 audit fix)", async () => {
    const { orderId, product } = await seedNouvelleOrder(3);
    await prisma.order.update({ where: { id: orderId }, data: { source: "WOOCOMMERCE", externalId: "9001" } });

    await loginAsTestUser({ role: "CONFIRMATION" });
    const res = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));
    expect(res.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("CONFIRMEE");
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityReserved).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { orderId } })).toBe(0);
  });

  it("ANNULE from NOUVELLE cancels the order without any stock movement", async () => {
    const { orderId, product } = await seedNouvelleOrder(3);
    await loginAsTestUser({ role: "CONFIRMATION" });
    const res = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "ANNULE", note: "faux client" }));
    expect(res.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("ANNULEE");
    expect(order.cancelledAt).not.toBeNull();

    const after = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.quantityReserved).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { orderId } })).toBe(0);
  });

  it("refuses to act on an order that is no longer NOUVELLE", async () => {
    const { orderId } = await seedNouvelleOrder();
    await loginAsTestUser({ role: "CONFIRMATION" });
    await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));

    const res = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "PAS_DE_REPONSE" }));
    expect(res.ok).toBe(false);
  });
});
