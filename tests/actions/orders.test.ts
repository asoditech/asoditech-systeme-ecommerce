import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createOrderAction,
  updateOrderStatusAction,
  updateOrderPaymentStatusAction,
  cancelOrderAction,
  createRefundAction,
  updateRefundStatusAction,
} from "@/actions/orders";
import { createOrderSchema } from "@/lib/validation/order";
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

  it("nets out both per-item and order-level discounts from the total (audit fix)", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "SALES" });

    // 2 x 100 = 200 gross, minus a 20 per-line discount, minus a 10
    // order-level discount, plus 5 shipping = 175.
    const result = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 5,
      discountTotal: 10,
      currency: "MAD",
      notes: "",
      internalNotes: "",
      shippingAddressLine1: "",
      shippingAddressLine2: "",
      shippingCity: "",
      shippingRegion: "",
      shippingCountry: "",
      shippingPhone: "",
      items: [{ productId: product.id, quantity: 2, unitPrice: 100, discount: 20 }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(order.subtotal.toString()).toBe("200");
    expect(order.total.toString()).toBe("175");
  });

  it("rejects a per-line discount larger than the line's own gross amount", () => {
    const parsed = createOrderSchema.safeParse({
      customerId: "x",
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100, discount: 500 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an order-level discount that would make the total negative", () => {
    const parsed = createOrderSchema.safeParse({
      customerId: "x",
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 999,
      currency: "MAD",
      items: [{ productId: "p1", quantity: 1, unitPrice: 100, discount: 0 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an order item referencing an archived product, even when the ID is supplied directly (audit fix)", async () => {
    const { customer, product } = await seedOrderable();
    await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVE" } });
    await loginAsTestUser({ role: "SALES" });

    // The search-assisted UI only ever offers ACTIF products, but a
    // crafted request can still supply an archived product's ID directly
    // — createOrderAction itself must reject it, not just the search.
    const result = await createOrderAction({
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
    expect(result.ok).toBe(false);

    const orders = await prisma.order.findMany({ where: { customerId: customer.id } });
    expect(orders).toHaveLength(0);
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

  it("rejects fulfillment (EXPEDIEE) rather than let on-hand stock go negative (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, product } = await createTestOrder(); // reserves 2 units, on-hand stays 10

    // Simulate stock having been reduced out-of-band (damage, recount)
    // between order creation and shipment, below what this order needs.
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 1 } });

    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    const result = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stock insuffisant/i);

    // The whole transition must have rolled back — status unchanged, stock untouched.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("EN_PREPARATION");
    const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(itemAfter.quantityOnHand).toBe(1);
  });

  it("prevents double stock deduction under concurrent EXPEDIEE requests (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, product } = await createTestOrder();
    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));

    // Two genuinely concurrent requests to ship the same order — only one
    // may succeed and apply the stock deduction exactly once.
    const [first, second] = await Promise.all([
      updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" })),
      updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" })),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(8); // deducted once (10 - 2), not twice
  });
});

describe("updateOrderPaymentStatusAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects REMBOURSE as a direct target — only a completed Refund may set it (audit fix)", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "MANAGER" });
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

    const result = await updateOrderPaymentStatusAction(
      formData({ id: created.data.id, paymentStatus: "REMBOURSE" })
    );
    expect(result.ok).toBe(false);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(order.paymentStatus).toBe("EN_ATTENTE");
  });
});

describe("refunds", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function createTestOrderWithTotal(total: number) {
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
      items: [{ productId: product.id, quantity: 1, unitPrice: total, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");
    return created.data.id;
  }

  it("rejects a refund that would push the total refunded amount past the order total (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);

    const first = await createRefundAction(formData({ orderId, amount: "60" }));
    expect(first.ok).toBe(true);

    const second = await createRefundAction(formData({ orderId, amount: "60" }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/solde remboursable|intégralement remboursée/i);
  });

  it("counts EN_ATTENTE and APPROUVE refunds toward the cap, not just COMPLETE ones", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);

    const first = await createRefundAction(formData({ orderId, amount: "80" }));
    expect(first.ok).toBe(true);
    // First refund defaults to EN_ATTENTE — never approved/completed — yet
    // it must still count against the remaining refundable balance.
    const second = await createRefundAction(formData({ orderId, amount: "30" }));
    expect(second.ok).toBe(false);
  });

  it("rejects an invalid refund transition (REJETE -> COMPLETE)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);
    const created = await createRefundAction(formData({ orderId, amount: "50" }));
    if (!created.ok) throw new Error("setup failed");

    await updateRefundStatusAction(formData({ id: created.data.id, status: "REJETE" }));
    const result = await updateRefundStatusAction(formData({ id: created.data.id, status: "COMPLETE" }));
    expect(result.ok).toBe(false);
  });

  it("sets the order's paymentStatus to REMBOURSE only when a refund reaches COMPLETE", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);
    const created = await createRefundAction(formData({ orderId, amount: "50" }));
    if (!created.ok) throw new Error("setup failed");

    await updateRefundStatusAction(formData({ id: created.data.id, status: "APPROUVE" }));
    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).not.toBe("REMBOURSE");

    await updateRefundStatusAction(formData({ id: created.data.id, status: "COMPLETE" }));
    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe("REMBOURSE");
  });

  it("a REJETE refund does not count against the refundable balance", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);
    const first = await createRefundAction(formData({ orderId, amount: "80" }));
    if (!first.ok) throw new Error("setup failed");
    await updateRefundStatusAction(formData({ id: first.data.id, status: "REJETE" }));

    const second = await createRefundAction(formData({ orderId, amount: "80" }));
    expect(second.ok).toBe(true);
  });
});
