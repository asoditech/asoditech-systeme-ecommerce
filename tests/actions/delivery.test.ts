import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createShippingProviderAction, createShipmentAction, updateShipmentStatusAction } from "@/actions/delivery";
import { updateOrderStatusAction, createOrderAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedShippableOrder() {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-DLV-1", price: 100, status: "ACTIF" } });
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
    shippingAddressLine1: "",
    shippingAddressLine2: "",
    shippingCity: "",
    shippingRegion: "",
    shippingCountry: "",
    shippingPhone: "",
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed");
  return created.data.id;
}

describe("createShipmentAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects creating a shipment for a brand-new (NOUVELLE) order (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedShippableOrder(); // status is NOUVELLE
    const provider = await createShippingProviderAction(formData({ name: "Livraison Rapide", type: "MANUEL" }));
    if (!provider.ok) throw new Error("setup failed");

    const result = await createShipmentAction(formData({ orderId, providerId: provider.data.id }));
    expect(result.ok).toBe(false);

    const shipments = await prisma.shipment.findMany({ where: { orderId } });
    expect(shipments).toHaveLength(0);
  });

  it("allows creating a shipment once the order is CONFIRMEE", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedShippableOrder();
    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    const provider = await createShippingProviderAction(formData({ name: "Livraison Rapide", type: "MANUEL" }));
    if (!provider.ok) throw new Error("setup failed");

    const result = await createShipmentAction(formData({ orderId, providerId: provider.data.id }));
    expect(result.ok).toBe(true);
  });

  it("rejects a shipment for a cancelled order", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await seedShippableOrder();
    await updateOrderStatusAction(formData({ id: orderId, status: "ANNULEE" }));
    const provider = await createShippingProviderAction(formData({ name: "Livraison Rapide", type: "MANUEL" }));
    if (!provider.ok) throw new Error("setup failed");

    const result = await createShipmentAction(formData({ orderId, providerId: provider.data.id }));
    expect(result.ok).toBe(false);
  });
});

describe("updateShipmentStatusAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function createTestShipment() {
    const orderId = await seedShippableOrder();
    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    // A shipment is created while the order is still being prepared (see
    // SHIPPABLE_ORDER_STATUSES in src/actions/delivery.ts); the order only
    // moves to EXPEDIEE once it's actually handed to the carrier.
    const provider = await createShippingProviderAction(formData({ name: "Livraison Rapide", type: "MANUEL" }));
    if (!provider.ok) throw new Error("setup failed");
    const shipment = await createShipmentAction(formData({ orderId, providerId: provider.data.id }));
    if (!shipment.ok) throw new Error("setup failed");
    await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
    return { orderId, shipmentId: shipment.data.id };
  }

  it("auto-advances the order to LIVREE when the shipment reaches LIVRE (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, shipmentId } = await createTestShipment();

    await updateShipmentStatusAction(formData({ id: shipmentId, status: "EN_TRANSIT" }));
    const result = await updateShipmentStatusAction(formData({ id: shipmentId, status: "LIVRE" }));
    expect(result.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("LIVREE");
    expect(order.deliveredAt).not.toBeNull();
  });

  it("rejects an invalid shipment transition", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { shipmentId } = await createTestShipment();

    const result = await updateShipmentStatusAction(formData({ id: shipmentId, status: "LIVRE" }));
    expect(result.ok).toBe(false); // EN_ATTENTE -> LIVRE is not a valid direct transition
  });
});
