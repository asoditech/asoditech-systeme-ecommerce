import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import {
  createOrderAction,
  createCustomerForOrderAction,
  updateOrderStatusAction,
  updateOrderPaymentStatusAction,
  cancelOrderAction,
  createRefundAction,
  updateRefundStatusAction,
} from "@/actions/orders";
import { createOrderSchema } from "@/lib/validation/order";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { installFakeWooCommerceServer, emptyFakeStore, FAKE_STORE_URL, FAKE_CONSUMER_KEY, FAKE_CONSUMER_SECRET } from "../helpers/fake-woocommerce";

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

  it("createCustomerForOrderAction creates a customer inline for an orders.create user and audits it", async () => {
    await loginAsTestUser({ role: "SALES" });
    const result = await createCustomerForOrderAction({ fullName: "Nouveau Client", phone: "0612345678", city: "Casablanca" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.fullName).toBe("Nouveau Client");
    expect(result.data.city).toBe("Casablanca");
    const audit = await prisma.auditEvent.findFirst({ where: { action: "customer.created", entityId: result.data.id } });
    expect(audit).not.toBeNull();
  });

  it("createCustomerForOrderAction rejects a caller without orders.create and a too-short name", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    await expect(createCustomerForOrderAction({ fullName: "X" })).rejects.toThrow(/non autorisé/i);
    await loginAsTestUser({ role: "SALES" });
    const bad = await createCustomerForOrderAction({ fullName: "X" });
    expect(bad.ok).toBe(false);
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

  it("defaults channel to WHATSAPP when omitted, and persists an explicit choice", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "SALES" });

    const defaulted = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: defaulted.data.id } });
      expect(order.channel).toBe("WHATSAPP");
      expect(order.source).toBe("INTERNE");
    }

    const explicit = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      channel: "TELEPHONE",
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      const order = await prisma.order.findUniqueOrThrow({ where: { id: explicit.data.id } });
      expect(order.channel).toBe("TELEPHONE");
    }
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

describe("createOrderAction — fulfilment warehouse (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  const orderInput = (customerId: string, productId: string, extra: Record<string, unknown> = {}) => ({
    customerId,
    paymentMethod: "PAIEMENT_LIVRAISON" as const,
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
    items: [{ productId, quantity: 2, unitPrice: 100, discount: 0 }],
    ...extra,
  });

  it("O1/O8 — defaults to getDefaultWarehouseId(), reserves there, and records it in the audit metadata", async () => {
    const { customer, product, warehouse } = await seedOrderable();
    await loginAsTestUser({ role: "SALES" });
    const r = await createOrderAction(orderInput(customer.id, product.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(order.fulfillmentWarehouseId).toBe(warehouse.id);
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouse.id, productId: product.id } });
    expect(item.quantityReserved).toBe(2);

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.created", entityId: r.data.id } });
    expect(audit.newValue).toMatchObject({ fulfillmentWarehouseId: warehouse.id });
  });

  it("O2 — an explicit active second warehouse reserves/fulfils there; the default is untouched", async () => {
    const { customer, product, warehouse } = await seedOrderable();
    const second = await prisma.warehouse.create({ data: { name: "Dépôt Sud", type: "ENTREPOT" } });
    await prisma.inventoryItem.create({ data: { warehouseId: second.id, productId: product.id, quantityOnHand: 30 } });

    await loginAsTestUser({ role: "SALES" });
    const r = await createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: second.id }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const secondItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: second.id, productId: product.id } });
    const defaultItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouse.id, productId: product.id } });
    expect(secondItem.quantityReserved).toBe(2);
    expect(defaultItem.quantityReserved).toBe(0);
  });

  it("O2 — an explicit active MAGASIN is accepted for an internal order", async () => {
    const { customer, product } = await seedOrderable();
    const shop = await prisma.warehouse.create({ data: { name: "Magasin Centre", type: "MAGASIN" } });
    await prisma.inventoryItem.create({ data: { warehouseId: shop.id, productId: product.id, quantityOnHand: 12 } });
    await loginAsTestUser({ role: "SALES" });
    const r = await createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: shop.id }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(order.fulfillmentWarehouseId).toBe(shop.id);
  });

  it("O3 — an inactive explicit warehouse is rejected and no order is created", async () => {
    const { customer, product } = await seedOrderable();
    const inactive = await prisma.warehouse.create({ data: { name: "Retiré", type: "ENTREPOT", isActive: false } });
    await loginAsTestUser({ role: "SALES" });
    const r = await createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: inactive.id }));
    expect(r).toMatchObject({ ok: false });
    expect(await prisma.order.count()).toBe(0);
  });

  it("O4 — a non-existent explicit warehouse is rejected", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "SALES" });
    const r = await createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: "does-not-exist" }));
    expect(r).toMatchObject({ ok: false });
    expect(await prisma.order.count()).toBe(0);
  });

  it("O5 — a historical order with fulfillmentWarehouseId null falls back to the compat resolution", async () => {
    const { customer, product, warehouse } = await seedOrderable();
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        subtotal: 200,
        total: 200,
        fulfillmentWarehouseId: null,
        items: { create: [{ productId: product.id, nameSnapshot: product.name, skuSnapshot: product.sku, unitPrice: 100, quantity: 2, total: 200 }] },
      },
      include: { items: true },
    });
    const lines = order.items.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }));
    const { reserveStockForOrder } = await import("@/lib/inventory");
    await prisma.$transaction((tx) => reserveStockForOrder(tx, order.id, lines, null));

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: warehouse.id, productId: product.id } });
    expect(item.quantityReserved).toBe(2);
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

  // Phase 32a regression: an order line for a variation carries BOTH the
  // parent productId and the variationId (createOrderAction snapshots them
  // together). The canonical stock primitive must target the variation's
  // InventoryItem row and not choke on "both ids present".
  it("reserves / fulfills / returns stock on the VARIATION row for a variation order line", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { warehouse, customer } = await seedOrderable();
    const parent = await prisma.product.create({
      data: { name: "Robe", sku: `ROBE-${Math.random()}`, price: 200, cost: 80, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: parent.id, sku: `ROBE-V-${Math.random()}`, attributes: { Couleur: "Rouge", Taille: "M" } },
    });
    const varItem = await prisma.inventoryItem.create({
      data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 12 },
    });

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
      items: [{ variationId: variation.id, quantity: 3, unitPrice: 200, discount: 0 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const orderId = created.data.id;

    let row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: varItem.id } });
    expect(row).toMatchObject({ quantityOnHand: 12, quantityReserved: 3 });

    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    const shipped = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
    expect(shipped.ok).toBe(true);
    row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: varItem.id } });
    expect(row).toMatchObject({ quantityOnHand: 9, quantityReserved: 0 });

    const returned = await updateOrderStatusAction(formData({ id: orderId, status: "RETOUR" }));
    expect(returned.ok).toBe(true);
    row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: varItem.id } });
    expect(row.quantityOnHand).toBe(12);

    // the parent product never got an InventoryItem or a movement
    expect(await prisma.inventoryItem.count({ where: { productId: parent.id } })).toBe(0);
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: varItem.id } });
    expect(movements.map((m) => m.type).sort()).toEqual(["RESERVATION", "RETOUR", "VENTE"]);
  });

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
    vi.unstubAllGlobals();
  });

  it("marks the order paid on WooCommerce when this app's own payment status becomes PAYE", async () => {
    const state = emptyFakeStore();
    installFakeWooCommerceServer(state);
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });
    const customer = await prisma.customer.create({ data: { fullName: "Client WC", phone: "0600000000" } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        source: "WOOCOMMERCE",
        externalId: "8001",
        paymentStatus: "EN_ATTENTE",
        subtotal: 100,
        total: 100,
      },
    });
    await loginAsTestUser({ role: "MANAGER" });

    const result = await updateOrderPaymentStatusAction(formData({ id: order.id, paymentStatus: "PAYE" }));
    expect(result.ok).toBe(true);

    expect(state.orderUpdates).toHaveLength(1);
    expect(state.orderUpdates[0]).toMatchObject({ orderId: 8001, body: { set_paid: true } });
  });

  it("does not call WooCommerce when the payment status is unchanged (already PAYE)", async () => {
    const state = emptyFakeStore();
    installFakeWooCommerceServer(state);
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });
    const customer = await prisma.customer.create({ data: { fullName: "Client WC", phone: "0600000001" } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        source: "WOOCOMMERCE",
        externalId: "8002",
        paymentStatus: "PAYE",
        subtotal: 100,
        total: 100,
      },
    });
    await loginAsTestUser({ role: "MANAGER" });

    // Setting it to the same status it already has (e.g. a no-op re-save).
    const result = await updateOrderPaymentStatusAction(formData({ id: order.id, paymentStatus: "PAYE" }));
    expect(result.ok).toBe(true);
    expect(state.orderUpdates).toHaveLength(0);
  });

  it("does not push anything for a purely internal order", async () => {
    const { customer, product } = await seedOrderable();
    await loginAsTestUser({ role: "MANAGER" });
    const created = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");

    const result = await updateOrderPaymentStatusAction(formData({ id: created.data.id, paymentStatus: "PAYE" }));
    expect(result.ok).toBe(true);
    // No integration configured at all — this must not throw either.
  });

  it("pushes the WooCommerce order status to « completed » when the order is marked LIVREE here", async () => {
    const state = emptyFakeStore();
    installFakeWooCommerceServer(state);
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });
    const customer = await prisma.customer.create({ data: { fullName: "Client WC" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, source: "WOOCOMMERCE", externalId: "8010", status: "EXPEDIEE", subtotal: 100, total: 100 },
    });
    await loginAsTestUser({ role: "MANAGER" });

    const result = await updateOrderStatusAction(formData({ id: order.id, status: "LIVREE" }));
    expect(result.ok).toBe(true);

    expect(state.orderUpdates).toHaveLength(1);
    expect(state.orderUpdates[0]).toMatchObject({ orderId: 8010, body: { status: "completed" } });
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

describe("order notifications (docs/adr/0016-notifications.md)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("createOrderAction notifies orders.view holders, excluding the creator", async () => {
    const { customer, product } = await seedOrderable();
    const creator = await loginAsTestUser({ role: "SALES" });
    const teammate = await createTestUser({ role: "MANAGER" });

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
    if (!result.ok) throw new Error("setup failed");

    const notifications = await prisma.notification.findMany();
    const recipientIds = notifications.map((n) => n.userId);
    expect(recipientIds).toContain(teammate.id);
    expect(recipientIds).not.toContain(creator.id);
    expect(notifications[0].type).toBe("NOUVELLE_COMMANDE");
    expect(notifications[0].entityId).toBe(result.data.id);
  });

  it("notifies orders.view holders when an order is returned", async () => {
    const { customer, product } = await seedOrderable();
    const actor = await loginAsTestUser({ role: "MANAGER" });
    const teammate = await createTestUser({ role: "SALES" });

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
    await prisma.notification.deleteMany(); // clear the "new order" notification from setup

    await updateOrderStatusAction(formData({ id: created.data.id, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: created.data.id, status: "EN_PREPARATION" }));
    await updateOrderStatusAction(formData({ id: created.data.id, status: "EXPEDIEE" }));
    await prisma.notification.deleteMany(); // clear low-stock check from the EXPEDIEE transition
    await updateOrderStatusAction(formData({ id: created.data.id, status: "RETOUR" }));

    const notifications = await prisma.notification.findMany();
    const recipientIds = notifications.map((n) => n.userId);
    expect(recipientIds).toContain(teammate.id);
    expect(recipientIds).not.toContain(actor.id);
    expect(notifications.every((n) => n.type === "COMMANDE_RETOURNEE")).toBe(true);
  });

  it("notifies orders.view holders when payment fails, deduped against a second ECHEC", async () => {
    const { customer, product } = await seedOrderable();
    const actor = await loginAsTestUser({ role: "MANAGER" });
    const teammate = await createTestUser({ role: "SALES" });

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
    await prisma.notification.deleteMany();

    await updateOrderPaymentStatusAction(formData({ id: created.data.id, paymentStatus: "ECHEC" }));
    // A second ECHEC->ECHEC call is rejected by the action itself before it
    // ever reaches notify() (existing.paymentStatus !== "ECHEC" guard) — the
    // dedupeKey exists as a backstop for a genuine retry of the same event,
    // asserted directly at the notify() layer in notifications.test.ts.

    const notifications = await prisma.notification.findMany();
    const recipientIds = notifications.map((n) => n.userId);
    expect(recipientIds).toContain(teammate.id);
    expect(recipientIds).not.toContain(actor.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("PROBLEME_PAIEMENT");
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

  it("prevents two concurrent refunds from jointly exceeding the order total (Phase 26 audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const orderId = await createTestOrderWithTotal(100);

    // Two genuinely concurrent requests, each individually well under the
    // order total (60 + 60 = 120 > 100) — a stale-read race would let both
    // pass the cap check against the same pre-refund aggregate. Only one
    // may succeed; see the row lock in createRefundAction.
    const [first, second] = await Promise.all([
      createRefundAction(formData({ orderId, amount: "60" })),
      createRefundAction(formData({ orderId, amount: "60" })),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const total = await prisma.refund.aggregate({ where: { orderId, status: { not: "REJETE" } }, _sum: { amount: true } });
    expect(Number(total._sum.amount)).toBe(60); // never 120
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
