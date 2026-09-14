import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { installFakeWooCommerceServer, emptyFakeStore, FAKE_STORE_URL, FAKE_CONSUMER_KEY, FAKE_CONSUMER_SECRET } from "../helpers/fake-woocommerce";

/**
 * confirmPhysicalReturnAction is the ONLY mechanism that credits
 * physically-returned stock back (docs/adr/0036-inventory-single-source
 * -of-truth.md) — fully decoupled from Order.status.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedOrderable(qty = 10) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-RET-${Math.random()}`, price: 100, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: qty } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Retour" } });
  return { warehouse, product, customer };
}

/** Creates, confirms, prepares and ships an order for `quantity` units of a
 * fresh product (on-hand starts at 10) — EXPEDIEE physically consumes it. */
async function createShippedOrder(quantity: number) {
  const { product, customer, warehouse } = await seedOrderable();
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
    items: [{ productId: product.id, quantity, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed: " + JSON.stringify(created));
  const orderId = created.data.id;
  await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
  await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
  const shipped = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
  if (!shipped.ok) throw new Error("setup failed to ship: " + JSON.stringify(shipped));
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  return { order, product, warehouse };
}

describe("confirmPhysicalReturnAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a role without orders.return", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order } = await createShippedOrder(5);
    await loginAsTestUser({ role: "WAREHOUSE" }); // holds inventory.adjust but not orders.return

    await expect(
      confirmPhysicalReturnAction({
        orderId: order.id,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: order.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
      })
    ).rejects.toThrow(/non autoris/i);
  });

  it("rejects a return on an order that has not shipped", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { product, customer } = await seedOrderable();
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
      items: [{ productId: product.id, quantity: 3, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.data.id }, include: { items: true } });

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  it("a full sellable return restores exactly the shipped quantity to on-hand", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);
    const before = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(before.quantityOnHand).toBe(5); // 10 - 5 consumed

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 5, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);

    const after = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(after.quantityOnHand).toBe(10);
    expect(after.quantityDamaged).toBe(0);
  });

  it("a partial sellable return restores only what was submitted, remaining decreases correctly", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);

    const first = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 2, quantityDamaged: 0 }],
    });
    expect(first.ok).toBe(true);
    let item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(7); // 5 + 2

    // remaining is now 5 - 2 = 3 — a second event for the remaining 3 succeeds.
    const second = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 3, quantityDamaged: 0 }],
    });
    expect(second.ok).toBe(true);
    item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10);
    expect(await prisma.orderReturn.count({ where: { orderId: order.id } })).toBe(2); // multiple return events
  });

  it("a damaged-only return records quantityDamaged and never touches on-hand", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 0, quantityDamaged: 3 }],
    });
    expect(result.ok).toBe(true);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(5); // unchanged
    expect(item.quantityDamaged).toBe(3);
  });

  it("a sellable + damaged split on one line applies both correctly", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 3, quantityDamaged: 2 }],
    });
    expect(result.ok).toBe(true);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(8); // 5 + 3
    expect(item.quantityDamaged).toBe(2);
  });

  it("over-return is rejected — the WHOLE request, never partially applied", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 4, quantityDamaged: 2 }], // 6 > 5 consumed
    });
    expect(result.ok).toBe(false);

    // Nothing applied at all.
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(5);
    expect(item.quantityDamaged).toBe(0);
    expect(await prisma.orderReturn.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("over-return across two SEPARATE events (second pushes past the ceiling) is rejected", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);

    await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 3, quantityDamaged: 0 }],
    });
    const second = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 3, quantityDamaged: 0 }], // only 2 remain
    });
    expect(second.ok).toBe(false);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(8); // only the first event applied (5 + 3)
  });

  it("an exact idempotency retry (same orderId + idempotencyKey) does not duplicate the event or movements", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(5);
    const idempotencyKey = randomUUID();

    const first = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey,
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 5, quantityDamaged: 0 }],
    });
    expect(first.ok).toBe(true);

    const retry = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey, // same key
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 5, quantityDamaged: 0 }],
    });
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) expect(retry.data.id).toBe(first.data.id); // same event, no-op

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10); // not 15 — the retry did not re-apply
    expect(await prisma.orderReturn.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "RETOUR" } })).toBe(1);
  });

  it("two concurrent submissions cannot together exceed the physically consumed quantity", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(2); // only 2 units consumed

    // Both requests see the same starting "remaining = 2" if unserialized;
    // the row lock (SELECT ... FOR UPDATE) must make only one succeed.
    const [a, b] = await Promise.all([
      confirmPhysicalReturnAction({
        orderId: order.id,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: order.items[0].id, quantitySellable: 2, quantityDamaged: 0 }],
      }),
      confirmPhysicalReturnAction({
        orderId: order.id,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: order.items[0].id, quantitySellable: 2, quantityDamaged: 0 }],
      }),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityOnHand).toBe(10); // deducted 2 at ship, restored 2 once — never more
  });

  it("uses the order's own fulfilment warehouse and records it on the return line", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, warehouse } = await createShippedOrder(4);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 4, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);

    const line = await prisma.orderReturnLine.findFirstOrThrow({ where: { orderItemId: order.items[0].id } });
    expect(line.warehouseId).toBe(warehouse.id);
  });

  it("creates correct InventoryMovement rows, each linked to the return event via orderReturnId", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order } = await createShippedOrder(5);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 3, quantityDamaged: 2 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const movements = await prisma.inventoryMovement.findMany({ where: { orderReturnId: result.data.id } });
    expect(movements).toHaveLength(2);
    const retour = movements.find((m) => m.type === "RETOUR")!;
    const endommage = movements.find((m) => m.type === "ENDOMMAGE")!;
    expect(retour).toMatchObject({ quantity: 3, orderId: order.id, orderReturnId: result.data.id });
    expect(endommage).toMatchObject({ quantity: 2, orderId: order.id, orderReturnId: result.data.id });
  });

  it("a deleted product does not corrupt return history — the line still records snapshots, no movement applied", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(3);
    const orderItemId = order.items[0].id;

    // Delete the product — OrderItem.productId is SetNull, same as any
    // other deleted-product order line.
    await prisma.product.delete({ where: { id: product.id } });

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId, quantitySellable: 3, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = await prisma.orderReturnLine.findFirstOrThrow({ where: { orderReturnId: result.data.id } });
    expect(line.nameSnapshot).toBeTruthy();
    expect(line.skuSnapshot).toBeTruthy();
    expect(line.orderItemId).toBe(orderItemId); // the OrderItem row itself survives (only its productId is SetNull)
    const orderItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
    expect(orderItem.productId).toBeNull();
    expect(await prisma.inventoryMovement.count({ where: { orderReturnId: result.data.id } })).toBe(0); // no product to credit
  });

  it("never performs any Order.status transition as a side effect", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order } = await createShippedOrder(5);
    const statusBefore = order.status;

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 5, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(statusBefore); // still EXPEDIEE — untouched
  });

  it("records an audit event and the receiving user on the return", async () => {
    const user = await loginAsTestUser({ role: "MANAGER" });
    const { order } = await createShippedOrder(2);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      note: "Colis ouvert, produit intact",
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 2, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const orderReturn = await prisma.orderReturn.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(orderReturn.receivedById).toBe(user.id);
    expect(orderReturn.note).toBe("Colis ouvert, produit intact");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.return_confirmed", entityId: order.id } });
    expect(audit.actorUserId).toBe(user.id);
  });

  it("rejects a line referencing an order item from a different order", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order: orderA } = await createShippedOrder(3);
    const { order: orderB } = await createShippedOrder(3);

    const result = await confirmPhysicalReturnAction({
      orderId: orderA.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: orderB.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  // docs/adr/0036: the source of the order no longer determines whether
  // ASODITECH pushes — a physical return credits real stock back and must
  // push the new sellable number outward, same as every other local
  // mutation (manual adjustment, stocktake, transfer, order fulfillment).
  it("pushes the new sellable stock to a linked WooCommerce store after a physical return", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { order, product } = await createShippedOrder(4);

    await prisma.product.update({
      where: { id: product.id },
      data: { source: "WOOCOMMERCE", externalId: "7777" },
    });
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

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 4, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);
    expect(state.stockUpdates.length).toBeGreaterThan(0);
  });

  // docs/adr/0024/0025/0026 — tenant scoping is automatic (the Prisma
  // extension resolves the active tenant from the logged-in session, and
  // Postgres RLS enforces it a second time at the database level, covering
  // even the raw `SELECT ... FOR UPDATE` lock). Proven behaviourally here,
  // not just by inspection.
  describe("multi-tenant isolation", () => {
    const TENANT_B = "tenant-b-returns";

    async function seedTenantBOrder(quantity: number) {
      await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
      const warehouse = await prismaBase.warehouse.create({
        data: { name: "Entrepôt B", isDefault: true, tenantId: TENANT_B },
      });
      const product = await prismaBase.product.create({
        data: { name: "Produit B", sku: `SKU-B-${Math.random()}`, price: 100, status: "ACTIF", tenantId: TENANT_B },
      });
      await prismaBase.inventoryItem.create({
        data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10, tenantId: TENANT_B },
      });
      const customer = await prismaBase.customer.create({ data: { fullName: "Client B", tenantId: TENANT_B } });
      const order = await prismaBase.order.create({
        data: {
          customerId: customer.id,
          tenantId: TENANT_B,
          subtotal: 100 * quantity,
          total: 100 * quantity,
          status: "EXPEDIEE",
          shippedAt: new Date(),
          fulfillmentWarehouseId: warehouse.id,
          items: {
            create: [
              {
                productId: product.id,
                tenantId: TENANT_B,
                nameSnapshot: "Produit B",
                skuSnapshot: "SKU-B",
                unitPrice: 100,
                quantity,
                total: 100 * quantity,
              },
            ],
          },
        },
        include: { items: true },
      });
      return { order, product, warehouse };
    }

    it("a tenant-A user cannot return an order belonging to tenant B — it is simply not found", async () => {
      await loginAsTestUser({ role: "MANAGER" }); // tenant A (default)
      const { order: orderB } = await seedTenantBOrder(5);

      const result = await confirmPhysicalReturnAction({
        orderId: orderB.id,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: orderB.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/introuvable/i);

      // Nothing in tenant B moved.
      const itemB = await prismaBase.inventoryItem.findFirstOrThrow({ where: { productId: (await prismaBase.product.findFirstOrThrow({ where: { tenantId: TENANT_B } })).id } });
      expect(itemB.quantityOnHand).toBe(10);
      expect(await prismaBase.orderReturn.count({ where: { tenantId: TENANT_B } })).toBe(0);

      await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
    });

    it("a tenant-A user cannot read tenant B's return history", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const { order: orderB } = await seedTenantBOrder(3);
      await prismaBase.orderReturn.create({
        data: { orderId: orderB.id, idempotencyKey: "b-key", tenantId: TENANT_B },
      });

      const visible = await prisma.orderReturn.findMany();
      expect(visible.every((r) => r.orderId !== orderB.id)).toBe(true);
    });
  });
});
