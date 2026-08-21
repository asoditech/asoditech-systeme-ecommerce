import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedOrderable() {
  const warehouse = await prisma.warehouse.create({
    data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true },
  });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: "SKU-ORD-1", price: 100, cost: 40, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 },
  });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  return { warehouse, product, customer };
}

describe("createOrderAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without orders.create permission", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "SUPPORT" });
    await expect(
      createOrderAction({
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
      })
    ).rejects.toThrow(/non autorisé/i);
  });

  it("creates an order, snapshots product price/cost, and reserves stock without touching on-hand", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "SALES" });

    const result = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 20,
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
      items: [{ productId: product.id, quantity: 3, unitPrice: 100, discount: 0 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.id }, include: { items: true } });
    expect(order.total.toString()).toBe("320");
    expect(order.items[0].costSnapshot?.toString()).toBe("40");

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10);
    expect(item.quantityReserved).toBe(3);
  });
});

describe("updateOrderStatusAction — state machine", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function createTestOrder() {
    const { customer, product } = await seedOrderable();
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
      items: [{ productId: product.id, quantity: 2, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");
    return { orderId: created.data.id, product };
  }

  it("rejects an invalid transition (NOUVELLE -> LIVREE)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await createTestOrder();

    const result = await updateOrderStatusAction(formData({ id: orderId, status: "LIVREE" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/transition/i);
  });

  it("fulfills stock (deducts on-hand, releases reservation) when moving to EXPEDIEE", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, product } = await createTestOrder();

    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    const result = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
    expect(result.ok).toBe(true);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(8);
    expect(item.quantityReserved).toBe(0);
  });

  it("releases the reservation without touching on-hand when cancelled before shipment", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, product } = await createTestOrder();

    await cancelOrderAction(formData({ id: orderId, reason: "Client a changé d'avis" }));

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10);
    expect(item.quantityReserved).toBe(0);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("ANNULEE");
  });

  it("returns stock to on-hand when a shipped order is later cancelled/failed", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, product } = await createTestOrder();

    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "ECHEC" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "ANNULEE" }));

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10);
  });

  it("records an audit event with previous and new status on every transition", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await createTestOrder();

    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "order.status_changed", entityId: orderId },
    });
    expect(audit.previousValue).toMatchObject({ status: "NOUVELLE" });
    expect(audit.newValue).toMatchObject({ status: "CONFIRMEE" });
  });
});
