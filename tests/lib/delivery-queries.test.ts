import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listOrdersAwaitingShipment, listShipments, getDeliveryStats } from "@/lib/queries/delivery";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { createShippingProviderAction } from "@/actions/delivery";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedConfirmedOrder() {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: `SKU-${Math.random()}`, price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "12 rue Hassan II",
    shippingAddressLine2: "",
    shippingCity: "Casablanca",
    shippingRegion: "",
    shippingCountry: "MA",
    shippingPhone: "0600000000",
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed");
  await updateOrderStatusAction(formData({ id: created.data.id, status: "CONFIRMEE" }));
  return created.data.id;
}

/**
 * Phase 27B live-test regression: `listOrdersAwaitingShipment` (powers the
 * "À expédier" tab, the only UI entry point into shipment creation) used
 * to exclude an order the moment it had ANY shipment row, including one
 * that failed locally (ECHEC, no external parcel — exactly what an
 * unresolved delivery-provider city produces). That left an operator with
 * no way to retry through the product at all. See
 * docs/adr/0013-ozonexpress-integration.md.
 */
describe("listOrdersAwaitingShipment", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("includes a freshly confirmed order with no shipment yet", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedConfirmedOrder();
    const orders = await listOrdersAwaitingShipment();
    expect(orders.map((o) => o.id)).toContain(orderId);
  });

  it("still includes an order whose only shipment attempt failed (ECHEC, no external id)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedConfirmedOrder();
    const provider = await createShippingProviderAction(formData({ name: "OzonExpress", type: "API" }));
    if (!provider.ok) throw new Error("setup failed");

    await prisma.shipment.create({
      data: { orderId, providerId: provider.data.id, status: "ECHEC", failedReason: "Ville non résolue." },
    });

    const orders = await listOrdersAwaitingShipment();
    expect(orders.map((o) => o.id)).toContain(orderId);
  });

  it("excludes an order that already has a live shipment (EN_ATTENTE)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedConfirmedOrder();
    const provider = await createShippingProviderAction(formData({ name: "OzonExpress", type: "API" }));
    if (!provider.ok) throw new Error("setup failed");

    await prisma.shipment.create({
      data: { orderId, providerId: provider.data.id, status: "EN_ATTENTE", externalId: "ext-1" },
    });

    const orders = await listOrdersAwaitingShipment();
    expect(orders.map((o) => o.id)).not.toContain(orderId);
  });

  it("excludes an order that already has a live shipment in transit (EN_TRANSIT)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedConfirmedOrder();
    const provider = await createShippingProviderAction(formData({ name: "OzonExpress", type: "API" }));
    if (!provider.ok) throw new Error("setup failed");

    await prisma.shipment.create({
      data: { orderId, providerId: provider.data.id, status: "EN_TRANSIT", externalId: "ext-2" },
    });

    const orders = await listOrdersAwaitingShipment();
    expect(orders.map((o) => o.id)).not.toContain(orderId);
  });

  it("includes an order in ECHEC status, not just CONFIRMEE/EN_PREPARATION", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedConfirmedOrder();
    await prisma.order.update({ where: { id: orderId }, data: { status: "ECHEC" } });

    const orders = await listOrdersAwaitingShipment();
    expect(orders.map((o) => o.id)).toContain(orderId);
  });
});

describe("listShipments / getDeliveryStats — date range filter", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedShipment(createdAt: Date, status: "EN_ATTENTE" | "LIVRE" | "ECHEC" = "EN_ATTENTE") {
    const warehouse = await prisma.warehouse.create({ data: { name: `E-${Math.random()}`, isDefault: false } });
    const product = await prisma.product.create({ data: { name: "P", sku: `SKU-${Math.random()}`, price: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, subtotal: 10, total: 10, fulfillmentWarehouseId: warehouse.id },
    });
    const provider = await prisma.shippingProvider.create({ data: { name: `Prov-${Math.random()}`, type: "MANUEL" } });
    return prisma.shipment.create({
      data: { orderId: order.id, providerId: provider.id, status, createdAt },
    });
  }

  it("listShipments only returns shipments created within the given range", async () => {
    await seedShipment(new Date("2026-01-05"));
    const inRange = await seedShipment(new Date("2026-02-15"));
    await seedShipment(new Date("2026-03-20"));

    const { shipments, total } = await listShipments({
      dateFrom: new Date("2026-02-01"),
      dateTo: new Date("2026-02-28T23:59:59"),
    });
    expect(total).toBe(1);
    expect(shipments.map((s) => s.id)).toEqual([inRange.id]);
  });

  it("getDeliveryStats scopes every count to the given range", async () => {
    await seedShipment(new Date("2026-01-05"), "LIVRE"); // outside range
    await seedShipment(new Date("2026-02-10"), "LIVRE"); // inside range
    await seedShipment(new Date("2026-02-20"), "ECHEC"); // inside range

    const stats = await getDeliveryStats(new Date("2026-02-01"), new Date("2026-02-28T23:59:59"));
    expect(stats.total).toBe(2);
    expect(stats.delivered).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it("with no range given, both queries see every shipment (matches the pre-filter default)", async () => {
    await seedShipment(new Date("2020-01-01"));
    await seedShipment(new Date("2030-01-01"));

    const { total } = await listShipments({});
    const stats = await getDeliveryStats();
    expect(total).toBe(2);
    expect(stats.total).toBe(2);
  });
});
