import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createShipmentAction, createShippingProviderAction, updateShipmentStatusAction } from "@/actions/delivery";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { updateAutoPaidOnDeliveryAction } from "@/actions/settings";
import { applyDeliveredPayment } from "@/lib/orders/delivered-payment";
import { importOrder } from "@/lib/integrations/woocommerce/sync/orders";
import type { WcOrder } from "@/lib/integrations/woocommerce/types";
import { resetDb } from "../helpers/db";
import { grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * « Marquer automatiquement les commandes comme payées à la livraison »
 * (BusinessSettings.autoPaidOnDelivery, owner decision 2026-10-16): per
 * company, default OFF; on a valid transition to LIVREE an EN_ATTENTE payment
 * becomes PAYE once, audited, inside the delivery's transaction; never
 * ECHEC / PARTIELLEMENT_PAYE / REMBOURSE; never another company's orders.
 *
 * DB-backed — needs the local test database WITH migration
 * 20261016120000_delivery_payment_brand_logo_whatsapp_outbox applied.
 */

const TENANT_B = "tenant-b-delivered-paid";

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const setAutoPaid = (on: boolean, tenantId = "default") =>
  prismaBase.businessSettings.upsert({ where: { tenantId }, update: { autoPaidOnDelivery: on }, create: { tenantId, autoPaidOnDelivery: on } });

const paymentOf = async (id: string) => (await prismaBase.order.findUniqueOrThrow({ where: { id } })).paymentStatus;
const deliveredPaidAudits = (id: string) =>
  prismaBase.auditEvent.count({ where: { entityType: "Order", entityId: id, metadata: { path: ["reason"], equals: "delivered_auto_paid" } } });

async function confirmedOrder(paymentMethod: "PAIEMENT_LIVRAISON" | "VIREMENT_BANCAIRE" = "PAIEMENT_LIVRAISON") {
  const warehouse =
    (await prisma.warehouse.findFirst({ where: { isDefault: true } })) ??
    (await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } }));
  // A MANAGER only works from the locations assigned to them (docs/adr/0037).
  const actor = await getCurrentUser();
  if (actor && !hasGlobalLocationAccess(actor.role)) await grantLocationAccess(actor.id, warehouse.id);
  const product = await prisma.product.create({ data: { name: "Coffret", sku: `SKU-DP-${Math.random().toString(36).slice(2, 8)}`, price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod,
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "12 rue Hassan II",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "MA",
    shippingPhone: "0600000000",
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error(`setup failed: ${created.error}`);
  expect((await updateOrderStatusAction(fd({ id: created.data.id, status: "CONFIRMEE" }))).ok).toBe(true);
  return created.data.id;
}

async function manualShipment(orderId: string) {
  const provider = await createShippingProviderAction(fd({ name: "Livreur maison", type: "MANUEL" }));
  if (!provider.ok) throw new Error("setup failed");
  const s = await createShipmentAction(fd({ orderId, providerId: provider.data.id }));
  if (!s.ok) throw new Error("shipment setup failed: " + s.error);
  return s.data.id;
}

function wooOrder(id: number, status: string, method: string): WcOrder {
  return {
    id, number: String(id), status, currency: "MAD", date_created: "2026-10-01T10:00:00", date_paid: "2026-10-01T10:01:00",
    customer_id: 0, total: 180, total_tax: 0, shipping_total: 0, discount_total: 0, payment_method: method,
    payment_method_title: null, customer_note: null,
    billing: { first_name: "Imp", last_name: "Ort", company: null, address_1: "x", address_2: null, city: "Rabat", state: null, postcode: null, country: "MA", email: "imp@example.com", phone: null },
    shipping: { first_name: "", last_name: "", company: null, address_1: "", address_2: null, city: "", state: null, postcode: null, country: "", email: null, phone: null },
    line_items: [{ id: 1, name: "Sac cuir", product_id: 7701, variation_id: null, sku: "SAC", quantity: 1, price: 180, subtotal: 180, total: 180, total_tax: 0 }],
    refunds: [],
  } as unknown as WcOrder;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("parcel « Livré » → order LIVREE", () => {
  it("ON: a COD order becomes « Payé » once, audited as the company rule (no courier record)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await setAutoPaid(true);
    const orderId = await confirmedOrder();
    const shipmentId = await manualShipment(orderId);
    expect((await updateShipmentStatusAction(fd({ id: shipmentId, status: "LIVRE" }))).ok).toBe(true);
    expect((await prismaBase.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("LIVREE");
    expect(await paymentOf(orderId)).toBe("PAYE");
    expect(await deliveredPaidAudits(orderId)).toBe(1);
    const audit = await prismaBase.auditEvent.findFirstOrThrow({ where: { entityId: orderId, metadata: { path: ["reason"], equals: "delivered_auto_paid" } } });
    expect(audit).toMatchObject({ actorType: "USER", previousValue: { paymentStatus: "EN_ATTENTE" }, newValue: { paymentStatus: "PAYE" } });
    // Replayed « Livré » (same parcel): refused as a conflict, nothing more written.
    await updateShipmentStatusAction(fd({ id: shipmentId, status: "LIVRE" }));
    expect(await deliveredPaidAudits(orderId)).toBe(1);
    expect(await prismaBase.refund.count()).toBe(0);
  });

  it("OFF (default): delivered stays « En attente »", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await confirmedOrder();
    const shipmentId = await manualShipment(orderId);
    expect((await updateShipmentStatusAction(fd({ id: shipmentId, status: "LIVRE" }))).ok).toBe(true);
    expect(await paymentOf(orderId)).toBe("EN_ATTENTE");
    expect(await deliveredPaidAudits(orderId)).toBe(0);
  });

  it("ON: a recorded payment failure (ECHEC) or a partial payment is never overwritten", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await setAutoPaid(true);
    for (const paymentStatus of ["ECHEC", "PARTIELLEMENT_PAYE"] as const) {
      const orderId = await confirmedOrder();
      await prismaBase.order.update({ where: { id: orderId }, data: { paymentStatus } });
      const shipmentId = await manualShipment(orderId);
      await updateShipmentStatusAction(fd({ id: shipmentId, status: "LIVRE" }));
      expect(await paymentOf(orderId)).toBe(paymentStatus);
    }
  });
});

describe("order status changed by hand to LIVREE", () => {
  it("ON: EXPEDIEE → LIVREE marks it paid in the same transaction", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await setAutoPaid(true);
    const orderId = await confirmedOrder("VIREMENT_BANCAIRE");
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }))).ok).toBe(true);
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" }))).ok).toBe(true);
    expect(await paymentOf(orderId)).toBe("EN_ATTENTE");
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "LIVREE" }))).ok).toBe(true);
    expect(await paymentOf(orderId)).toBe("PAYE");
    expect(await deliveredPaidAudits(orderId)).toBe(1);
  });
});

describe("transaction integrity", () => {
  it("a rolled-back delivery rolls the payment change back too", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await setAutoPaid(true);
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const order = await prisma.order.create({ data: { customerId: customer.id, status: "LIVREE", subtotal: 100, total: 100 } });
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await applyDeliveredPayment(tx, { orderId: order.id, via: "order_status", actorType: "SYSTEM" })).toBe(true);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await paymentOf(order.id)).toBe("EN_ATTENTE");
    expect(await deliveredPaidAudits(order.id)).toBe(0);
  });
});

describe("company isolation", () => {
  it("each company's own setting applies; another company's order is never touched", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await setAutoPaid(true, "default");
    await setAutoPaid(false, TENANT_B);
    const custB = await prismaBase.customer.create({ data: { tenantId: TENANT_B, fullName: "Client B" } });
    const orderB = await prismaBase.order.create({ data: { tenantId: TENANT_B, customerId: custB.id, status: "LIVREE", subtotal: 100, total: 100 } });

    // Company A (ON) cannot reach B's order.
    await loginAsTestUser({ role: "MANAGER" });
    expect(await prisma.$transaction((tx) => applyDeliveredPayment(tx, { orderId: orderB.id, via: "order_status", actorType: "SYSTEM" }))).toBe(false);
    expect(await paymentOf(orderB.id)).toBe("EN_ATTENTE");

    // Company B (OFF) — its own setting, not A's.
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER", tenantId: TENANT_B });
    expect(await prisma.$transaction((tx) => applyDeliveredPayment(tx, { orderId: orderB.id, via: "order_status", actorType: "SYSTEM" }))).toBe(false);
    expect(await paymentOf(orderB.id)).toBe("EN_ATTENTE");
  });
});

describe("WooCommerce import", () => {
  it("a COD order IMPORTED already « completed » is never marked paid — not by its date_paid, not retroactively by the setting", async () => {
    // 2026-10-16 review: the rule follows a delivery the company observes; a
    // first historical import must not mark every past delivered order paid.
    await loginAsTestUser({ role: "MANAGER" });
    await prisma.product.create({ data: { name: "Sac cuir", sku: "SAC", price: 180, status: "ACTIF", source: "WOOCOMMERCE", externalId: "7701" } });
    const find = (id: number) => prismaBase.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: String(id) } });

    await importOrder(wooOrder(9501, "completed", "cod"), { type: "INTEGRATION" });
    expect((await find(9501)).status).toBe("LIVREE");
    expect((await find(9501)).paymentStatus).toBe("EN_ATTENTE");

    await setAutoPaid(true);
    await importOrder(wooOrder(9502, "completed", "cod"), { type: "INTEGRATION" });
    const imported = await find(9502);
    expect(imported.status).toBe("LIVREE");
    expect(imported.paymentStatus).toBe("EN_ATTENTE");
    expect(await deliveredPaidAudits(imported.id)).toBe(0);
    // Re-sync of the same delivered order: still no change (no transition observed).
    await importOrder(wooOrder(9502, "completed", "cod"), { type: "INTEGRATION" });
    expect(await deliveredPaidAudits(imported.id)).toBe(0);
  });

  it("a COD order moving processing → completed on a later webhook follows the setting", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await setAutoPaid(true);
    await prisma.product.create({ data: { name: "Sac cuir", sku: "SAC", price: 180, status: "ACTIF", source: "WOOCOMMERCE", externalId: "7701" } });
    await importOrder(wooOrder(9503, "processing", "cod"), { type: "INTEGRATION" });
    const order = await prismaBase.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "9503" } });
    expect(order.paymentStatus).toBe("EN_ATTENTE"); // date_paid on a COD order is not a payment
    await importOrder(wooOrder(9503, "completed", "cod"), { type: "INTEGRATION" });
    const after = await prismaBase.order.findUniqueOrThrow({ where: { id: order.id } });
    if (after.status === "LIVREE") expect(after.paymentStatus).toBe("PAYE");
    else expect(after.paymentStatus).toBe("EN_ATTENTE"); // transition held for a person (store rules) → no payment change
  });
});

describe("setting", () => {
  it("settings.manage only, audited, default OFF", async () => {
    expect((await prismaBase.businessSettings.findFirst({ where: { tenantId: "default" } }))?.autoPaidOnDelivery ?? false).toBe(false);
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(updateAutoPaidOnDeliveryAction(fd({ autoPaidOnDelivery: "true" }))).rejects.toThrow();
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await updateAutoPaidOnDeliveryAction(fd({ autoPaidOnDelivery: "true" }))).ok).toBe(true);
    expect((await prismaBase.businessSettings.findFirstOrThrow({ where: { tenantId: "default" } })).autoPaidOnDelivery).toBe(true);
    expect(await prismaBase.auditEvent.count({ where: { entityType: "BusinessSettings", action: "settings.updated" } })).toBe(1);
  });
});
