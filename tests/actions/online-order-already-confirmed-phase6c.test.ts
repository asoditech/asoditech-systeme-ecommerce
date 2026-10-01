import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction, reopenOrderAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { createSaleAction } from "@/actions/sales";
import { listOrdersAwaitingConfirmation } from "@/lib/queries/order-confirmation";
import { reconcileOrderCommission } from "@/lib/commissions";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import type { CreateOrderInput } from "@/lib/validation/order";

/**
 * Phase 6C — manual Online order « Client déjà confirmé »
 * (docs/adr/0046, on top of the canonical confirmation of docs/adr/0045).
 */

// Test 17 needs a failure INSIDE the canonical confirmation, after the order
// row was written. Everything else runs the real inventory module.
const failure = vi.hoisted(() => ({ reserve: false }));
vi.mock("@/lib/inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory")>();
  return {
    ...actual,
    reserveStockForOrder: async (...args: Parameters<typeof actual.reserveStockForOrder>) => {
      if (failure.reserve) throw new actual.InsufficientStockError("Stock insuffisant (test).");
      return actual.reserveStockForOrder(...args);
    },
  };
});

beforeEach(async () => {
  failure.reserve = false;
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  failure.reserve = false;
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const QTY = 3;

async function seedCatalog(onHand = 20) {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-6C-1", price: 100, cost: 40, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: onHand } });
  const customer = await prisma.customer.create({ data: { fullName: "Salma Idrissi", phone: "0611223344" } });
  return { warehouse, product, itemId: item.id, customerId: customer.id };
}

function orderInput(
  seed: { product: { id: string }; customerId: string },
  extra: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    customerId: seed.customerId,
    paymentMethod: "PAIEMENT_LIVRAISON",
    channel: "WHATSAPP",
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
    items: [{ productId: seed.product.id, quantity: QTY, unitPrice: 100, discount: 0 }],
    ...extra,
  };
}

/** A CONFIRMATION-role creator (orders.create + orders.confirm), optionally a commission agent. */
async function loginCreator(warehouseId: string, opts: { agent?: "active" | "inactive" | "none" } = {}) {
  const user = await loginAsTestUser({ role: "CONFIRMATION" });
  await grantLocationAccess(user.id, warehouseId);
  const kind = opts.agent ?? "none";
  const agent =
    kind === "none"
      ? null
      : await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: 10, isActive: kind === "active" } });
  return { user, agent };
}

async function create(input: CreateOrderInput) {
  const r = await createOrderAction(input);
  if (!r.ok) throw new Error(`createOrderAction failed: ${r.error}`);
  return r.data.id;
}

const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const reservedOf = async (itemId: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).quantityReserved;
const confirmAttempts = (orderId: string) =>
  prisma.orderConfirmationAttempt.findMany({ where: { orderId, outcome: "CONFIRME" }, orderBy: { createdAt: "asc" } });
const queueIds = async () => (await listOrdersAwaitingConfirmation()).orders.map((o) => o.id);

// ---------------------------------------------------------------------------
// The two explicit paths
// ---------------------------------------------------------------------------

describe("manual order — two explicit confirmation states at creation", () => {
  it("1. default (flag omitted / false): NOUVELLE, no confirmation, no reservation, in the queue", async () => {
    const seed = await seedCatalog();
    await loginCreator(seed.warehouse.id, { agent: "active" });

    const omitted = await create(orderInput(seed));
    const explicitFalse = await create(orderInput(seed, { customerAlreadyConfirmed: false }));
    for (const id of [omitted, explicitFalse]) {
      const order = await orderOf(id);
      expect(order.status).toBe("NOUVELLE");
      expect(order.confirmedAt).toBeNull();
      expect(order.confirmationAgentId).toBeNull();
      expect(order.confirmationAttemptCount).toBe(0);
      expect(await prisma.orderConfirmationAttempt.count({ where: { orderId: id } })).toBe(0);
    }
    expect(await reservedOf(seed.itemId)).toBe(0);
    expect(await queueIds()).toEqual(expect.arrayContaining([omitted, explicitFalse]));
    // the "nouvelle commande" alert is still raised, as before
    expect(await prisma.notification.count({ where: { type: "NOUVELLE_COMMANDE", entityId: omitted } })).toBeGreaterThan(0);
  });

  it("2-5. « Client déjà confirmé »: CONFIRMEE, confirmedAt, ONE CONFIRME attempt by the creator, not in the queue", async () => {
    const seed = await seedCatalog();
    const { user } = await loginCreator(seed.warehouse.id);

    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true, channel: "INSTAGRAM" }));
    const order = await orderOf(id);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmedAt).toBeInstanceOf(Date);
    expect(order.createdById).toBe(user.id);
    expect(order.channel).toBe("INSTAGRAM");
    expect(order.displayNumber).not.toBeNull();
    expect(order.confirmationAttemptCount).toBe(1);

    const attempts = await prisma.orderConfirmationAttempt.findMany({ where: { orderId: id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("CONFIRME");
    expect(attempts[0]!.agentUserId).toBe(user.id); // the confirmation actor is the creator
    expect(attempts[0]!.note).toMatch(/déjà confirmé.*Instagram/i);

    expect(await queueIds()).not.toContain(id);
    // never waited for confirmation → no "nouvelle commande" alert
    expect(await prisma.notification.count({ where: { type: "NOUVELLE_COMMANDE", entityId: id } })).toBe(0);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, action: "order.created" } });
    expect(audit.newValue).toMatchObject({ status: "CONFIRMEE", customerAlreadyConfirmed: true });
  });

  it("a crafted `status: CONFIRMEE` without the flag is ignored — the server decides, the order stays NOUVELLE", async () => {
    const seed = await seedCatalog();
    await loginCreator(seed.warehouse.id);
    const id = await create({ ...orderInput(seed), status: "CONFIRMEE", confirmedAt: new Date() } as unknown as CreateOrderInput);
    expect((await orderOf(id)).status).toBe("NOUVELLE");
    expect((await orderOf(id)).confirmedAt).toBeNull();
    expect(await reservedOf(seed.itemId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Commission-agent attribution (Phase 6B rules, unchanged)
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("6. creator with an ACTIVE CommissionAgent → attributed to that agent", async () => {
    const seed = await seedCatalog();
    const { agent } = await loginCreator(seed.warehouse.id, { agent: "active" });
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id)).confirmationAgentId).toBe(agent!.id);
  });

  it("7. creator with an INACTIVE CommissionAgent → no attribution; creator without one → none, and none auto-created", async () => {
    const seed = await seedCatalog();
    const { user } = await loginCreator(seed.warehouse.id, { agent: "inactive" });
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id)).confirmationAgentId).toBeNull();
    expect((await confirmAttempts(id))[0]?.agentUserId).toBe(user.id); // still the recorded confirmer

    mockCookieStore.clear();
    await loginCreator(seed.warehouse.id, { agent: "none" });
    const id2 = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id2)).confirmationAgentId).toBeNull();
    expect(await prisma.commissionAgent.count()).toBe(1); // only the inactive one
  });

  it("8. a manager-preset agent is preserved — not replaced by the creator's own active agent", async () => {
    const seed = await seedCatalog();
    const presetUser = await createTestUser({ role: "CONFIRMATION" });
    const preset = await prisma.commissionAgent.create({ data: { userId: presetUser.id, ratePerOrder: 20 } });
    const manager = await loginAsTestUser({ role: "MANAGER" }); // orders.create + orders.confirm + commissions.manage
    await grantLocationAccess(manager.id, seed.warehouse.id);
    await prisma.commissionAgent.create({ data: { userId: manager.id, ratePerOrder: 5 } });

    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true, confirmationAgentId: preset.id }));
    const order = await orderOf(id);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmationAgentId).toBe(preset.id);
    expect((await confirmAttempts(id))[0]?.agentUserId).toBe(manager.id);
  });

  it("13. crafted request: a creator without commissions.manage cannot force a commission agent (either path)", async () => {
    const seed = await seedCatalog();
    const otherUser = await createTestUser({ role: "CONFIRMATION" });
    const other = await prisma.commissionAgent.create({ data: { userId: otherUser.id, ratePerOrder: 50 } });
    await loginCreator(seed.warehouse.id, { agent: "active" });

    for (const customerAlreadyConfirmed of [true, false]) {
      const r = await createOrderAction(orderInput(seed, { customerAlreadyConfirmed, confirmationAgentId: other.id }));
      expect(r.ok, String(customerAlreadyConfirmed)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/pas autorisé à attribuer/);
    }
    expect(await prisma.order.count()).toBe(0);
    expect(await reservedOf(seed.itemId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stock + atomicity
// ---------------------------------------------------------------------------

describe("stock and transaction", () => {
  it("9. reserves stock exactly once — on-hand untouched", async () => {
    const seed = await seedCatalog(20);
    await loginCreator(seed.warehouse.id);
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect(await reservedOf(seed.itemId)).toBe(QTY);
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: seed.itemId } });
    expect(item.quantityOnHand).toBe(20);
    const movements = await prisma.inventoryMovement.findMany({ where: { orderId: id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: "RESERVATION", quantity: QTY });
  });

  it("10. insufficient available stock: same semantics as a Phase 6B confirmation (backorders allowed, docs/adr/0030)", async () => {
    const seed = await seedCatalog(1); // only 1 on hand, order needs 3
    await loginCreator(seed.warehouse.id);
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id)).status).toBe("CONFIRMEE");
    expect(await reservedOf(seed.itemId)).toBe(QTY);
    // identical to confirming an existing NOUVELLE order through the queue
    const nouvelle = await create(orderInput(seed));
    expect((await recordConfirmationAttemptAction(fd({ id: nouvelle, outcome: "CONFIRME" }))).ok).toBe(true);
    expect(await reservedOf(seed.itemId)).toBe(QTY * 2);
  });

  it("10/17. a failure inside the confirmation (stock error) rolls the WHOLE creation back — no partial order", async () => {
    const seed = await seedCatalog();
    await loginCreator(seed.warehouse.id, { agent: "active" });
    failure.reserve = true;

    const r = await createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Stock insuffisant/);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.orderConfirmationAttempt.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await reservedOf(seed.itemId)).toBe(0);
    expect(await prisma.auditEvent.count({ where: { action: "order.created" } })).toBe(0);

    // the display-number claim was rolled back too: the next order is #1
    failure.reserve = false;
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id)).displayNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe("security", () => {
  it("12. orders.create is still required; « déjà confirmé » also requires orders.confirm (DENY → refused, nothing created)", async () => {
    const seed = await seedCatalog();
    const { user } = await loginCreator(seed.warehouse.id);
    await prisma.userPermissionOverride.create({ data: { userId: user.id, permission: "orders.confirm", effect: "DENY" } });

    const r = await createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pas autorisé à confirmer/);
    expect(await prisma.order.count()).toBe(0);
    // the normal path is unaffected
    expect((await orderOf(await create(orderInput(seed)))).status).toBe("NOUVELLE");

    await prisma.userPermissionOverride.create({ data: { userId: user.id, permission: "orders.create", effect: "DENY" } });
    await expect(createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }))).rejects.toThrow(/non autorisé/i);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "WAREHOUSE" }); // no orders.create at all
    await expect(createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }))).rejects.toThrow(/non autorisé/i);
    expect(await prisma.order.count()).toBe(1);
  });

  it("11. tenant isolation: another tenant's customer / product / agent can't be used; nothing written in that tenant", async () => {
    const seed = await seedCatalog();
    await prismaBase.tenant.create({ data: { id: "tenant-b-6c", name: "B", slug: "tenant-b-6c" } });
    const custB = await prismaBase.customer.create({ data: { fullName: "Client B", tenantId: "tenant-b-6c" } });
    const prodB = await prismaBase.product.create({ data: { name: "Produit B", sku: "B-6C", price: 10, status: "ACTIF", tenantId: "tenant-b-6c" } });
    const userB = await prismaBase.user.create({
      data: { email: "b-6c@asoditech.test", name: "B", passwordHash: "x", role: "CONFIRMATION", tenantId: "tenant-b-6c" },
    });
    const agentB = await prismaBase.commissionAgent.create({ data: { userId: userB.id, ratePerOrder: 10, tenantId: "tenant-b-6c" } });

    const manager = await loginAsTestUser({ role: "MANAGER" });
    await grantLocationAccess(manager.id, seed.warehouse.id);
    const crafted = [
      orderInput({ ...seed, customerId: custB.id }, { customerAlreadyConfirmed: true }),
      orderInput({ ...seed, product: prodB }, { customerAlreadyConfirmed: true }),
      orderInput(seed, { customerAlreadyConfirmed: true, confirmationAgentId: agentB.id }),
    ];
    for (const input of crafted) expect((await createOrderAction(input)).ok).toBe(false);

    expect(await prismaBase.order.count()).toBe(0);
    expect(await prismaBase.orderConfirmationAttempt.count()).toBe(0);
    // a legitimate one lands in the caller's own tenant only
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await prismaBase.order.findUniqueOrThrow({ where: { id } })).tenantId).toBe("default");
    expect(await prismaBase.order.count({ where: { tenantId: "tenant-b-6c" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unchanged neighbours
// ---------------------------------------------------------------------------

describe("unchanged behaviour", () => {
  it("15. Path A then the normal Phase 6B confirmation still works (queue and direct)", async () => {
    const seed = await seedCatalog();
    const { user, agent } = await loginCreator(seed.warehouse.id, { agent: "active" });
    const viaQueue = await create(orderInput(seed));
    const viaDirect = await create(orderInput(seed));
    expect((await recordConfirmationAttemptAction(fd({ id: viaQueue, outcome: "CONFIRME" }))).ok).toBe(true);
    expect((await updateOrderStatusAction(fd({ id: viaDirect, status: "CONFIRMEE" }))).ok).toBe(true);
    for (const id of [viaQueue, viaDirect]) {
      const order = await orderOf(id);
      expect(order.status).toBe("CONFIRMEE");
      expect(order.confirmationAgentId).toBe(agent!.id);
      expect((await confirmAttempts(id)).map((a) => a.agentUserId)).toEqual([user.id]);
    }
    expect(await reservedOf(seed.itemId)).toBe(QTY * 2);
    // an already-confirmed order can't be confirmed a second time
    const already = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await recordConfirmationAttemptAction(fd({ id: already, outcome: "CONFIRME" }))).ok).toBe(false);
    expect(await confirmAttempts(already)).toHaveLength(1);
    expect(await reservedOf(seed.itemId)).toBe(QTY * 3);
  });

  it("commission: nothing earned at CONFIRMEE; earned once at LIVREE through the existing reconciliation", async () => {
    const seed = await seedCatalog();
    const { agent } = await loginCreator(seed.warehouse.id, { agent: "active" });
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect(await prisma.commissionEntry.count({ where: { orderId: id } })).toBe(0);

    await prisma.order.update({ where: { id }, data: { status: "LIVREE", deliveredAt: new Date() } });
    await reconcileOrderCommission(id, null);
    await reconcileOrderCommission(id, null);
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "EARNED", agentId: agent!.id });
  });

  it("16. cancel + reopen follows Phase 6B: back to NOUVELLE with confirmation state cleared, history kept", async () => {
    const seed = await seedCatalog();
    const { user, agent } = await loginCreator(seed.warehouse.id, { agent: "active" });
    const id = await create(orderInput(seed, { customerAlreadyConfirmed: true }));
    expect((await orderOf(id)).confirmationAgentId).toBe(agent!.id);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER" });
    expect((await cancelOrderAction(fd({ id, reason: "client injoignable" }))).ok).toBe(true);
    expect(await reservedOf(seed.itemId)).toBe(0);
    expect((await reopenOrderAction(fd({ id }))).ok).toBe(true);

    const order = await orderOf(id);
    expect(order.status).toBe("NOUVELLE");
    expect(order.confirmedAt).toBeNull();
    expect(order.confirmationAgentId).toBeNull();
    expect((await confirmAttempts(id)).map((a) => a.agentUserId)).toEqual([user.id]);
    expect(await prisma.auditEvent.count({ where: { entityId: id, action: "order.created" } })).toBe(1);
    expect(await queueIds()).toContain(id); // back in the queue for a NEW confirmation
  });

  it("14. Offline POS sale is unchanged — no confirmation, no attribution", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN" } });
    const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casa", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "B-6C-POS", price: 250, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: store.id, productId: product.id, quantityOnHand: 4 } });
    const seller = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(seller.id, channel.id);
    await grantLocationAccess(seller.id, store.id);

    const r = await createSaleAction({
      salesChannelId: channel.id,
      warehouseId: store.id,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, quantity: 1 }],
      payments: [{ method: "ESPECES", amount: 250 }],
    });
    expect(r.ok).toBe(true);
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.quantityOnHand).toBe(3);
    expect(after.quantityReserved).toBe(0);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderConfirmationAttempt.count()).toBe(0);
    // and a STORE_SELLER can't create an Online order at all
    const seed = { product, customerId: (await prisma.customer.create({ data: { fullName: "X Y" } })).id };
    await expect(createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }))).rejects.toThrow(/non autorisé/i);
  });
});
