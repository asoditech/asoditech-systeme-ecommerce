import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction, reopenOrderAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { assignOrderConfirmationAgentAction } from "@/actions/commissions";
import { createSaleAction } from "@/actions/sales";
import { reconcileOrderCommission } from "@/lib/commissions";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase 6B — one canonical Online confirmation (docs/adr/0045).
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

const QTY = 3;

/** A NOUVELLE Online order (qty 3) created through the real createOrderAction. */
async function seedNouvelleOrder() {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-6B-1", price: 100, cost: 40, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi", phone: "0612345678" } });
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
    items: [{ productId: product.id, quantity: QTY, unitPrice: 100, discount: 0 }],
  });
  if (!res.ok) throw new Error("order seed failed");
  mockCookieStore.clear();
  return { orderId: res.data.id, itemId: item.id };
}

/** A CONFIRMATION-role user, optionally a commission agent, logged in. */
async function loginConfirmer(opts: { agent?: "active" | "inactive" | "none" } = {}) {
  const user = await loginAsTestUser({ role: "CONFIRMATION" });
  const kind = opts.agent ?? "active";
  const agent =
    kind === "none"
      ? null
      : await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: 10, isActive: kind === "active" } });
  return { user, agent };
}

const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const reservedOf = async (itemId: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).quantityReserved;
const confirmAttempts = (orderId: string) =>
  prisma.orderConfirmationAttempt.findMany({ where: { orderId, outcome: "CONFIRME" }, orderBy: { createdAt: "asc" } });

// ---------------------------------------------------------------------------
// 1-2. Queue confirmation
// ---------------------------------------------------------------------------

describe("queue confirmation (canonical)", () => {
  it("1. by an ACTIVE commission agent: attempt + confirmer + confirmedAt + attribution + reservation", async () => {
    const { orderId, itemId } = await seedNouvelleOrder();
    const { user, agent } = await loginConfirmer({ agent: "active" });

    const r = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME", note: "ok client" }));
    expect(r.ok).toBe(true);

    const order = await orderOf(orderId);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmedAt).toBeInstanceOf(Date);
    expect(order.confirmationAgentId).toBe(agent!.id);
    expect(order.confirmationAttemptCount).toBe(1);
    const attempts = await confirmAttempts(orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ agentUserId: user.id, note: "ok client" });
    expect(await reservedOf(itemId)).toBe(QTY);
  });

  it("2. by a NON-agent: confirmation succeeds and is recorded, no attribution, no agent auto-created", async () => {
    const { orderId, itemId } = await seedNouvelleOrder();
    const { user } = await loginConfirmer({ agent: "none" });

    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))).ok).toBe(true);
    const order = await orderOf(orderId);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmationAgentId).toBeNull();
    expect((await confirmAttempts(orderId))[0]?.agentUserId).toBe(user.id);
    expect(await prisma.commissionAgent.count()).toBe(0);
    expect(await reservedOf(itemId)).toBe(QTY);
  });

  it("an INACTIVE agent confirms but is not credited", async () => {
    const { orderId } = await seedNouvelleOrder();
    await loginConfirmer({ agent: "inactive" });
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))).ok).toBe(true);
    expect((await orderOf(orderId)).confirmationAgentId).toBeNull();
  });

  it("non-confirming outcomes are unchanged (logged, order stays NOUVELLE, no reservation)", async () => {
    const { orderId, itemId } = await seedNouvelleOrder();
    await loginConfirmer();
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "RAPPELER" }))).ok).toBe(true);
    const order = await orderOf(orderId);
    expect(order.status).toBe("NOUVELLE");
    expect(order.confirmationAttemptCount).toBe(1);
    expect(order.confirmedAt).toBeNull();
    expect(order.confirmationAgentId).toBeNull();
    expect(await reservedOf(itemId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3-5. Direct status change on the order page
// ---------------------------------------------------------------------------

describe("direct NOUVELLE → CONFIRMEE (order page) uses the canonical confirmation", () => {
  it("3. by an ACTIVE agent: attempt recorded, attribution assigned, stock reserved", async () => {
    const { orderId, itemId } = await seedNouvelleOrder();
    const { user, agent } = await loginConfirmer({ agent: "active" });

    expect((await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }))).ok).toBe(true);
    const order = await orderOf(orderId);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmedAt).toBeInstanceOf(Date);
    expect(order.confirmationAgentId).toBe(agent!.id);
    expect(order.confirmationAttemptCount).toBe(1);
    expect((await confirmAttempts(orderId)).map((a) => a.agentUserId)).toEqual([user.id]);
    expect(await reservedOf(itemId)).toBe(QTY);
    // the existing audit behaviour is preserved
    expect(await prisma.auditEvent.count({ where: { entityId: orderId, action: "order.status_changed" } })).toBe(1);
  });

  it("4. by a NON-agent: succeeds, attempt recorded, no attribution", async () => {
    const { orderId } = await seedNouvelleOrder();
    const { user } = await loginConfirmer({ agent: "none" });
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }))).ok).toBe(true);
    const order = await orderOf(orderId);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmationAgentId).toBeNull();
    expect((await confirmAttempts(orderId))[0]?.agentUserId).toBe(user.id);
  });

  it("5. a crafted request cannot choose another agent", async () => {
    const { orderId } = await seedNouvelleOrder();
    const other = await createTestUser({ role: "CONFIRMATION" });
    const otherAgent = await prisma.commissionAgent.create({ data: { userId: other.id, ratePerOrder: 50 } });
    await loginConfirmer({ agent: "none" });

    const r = await updateOrderStatusAction(
      fd({ id: orderId, status: "CONFIRMEE", confirmationAgentId: otherAgent.id, agentId: otherAgent.id })
    );
    expect(r.ok).toBe(true);
    expect((await orderOf(orderId)).confirmationAgentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Retry / concurrency
// ---------------------------------------------------------------------------

describe("retry and concurrency", () => {
  it("6. concurrent / retried confirmations: one confirmation, one reservation, one commission", async () => {
    const { orderId, itemId } = await seedNouvelleOrder();
    await loginConfirmer({ agent: "active" });

    const results = await Promise.all([
      updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" })),
      recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" })),
      updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // a plain retry after success is refused too
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))).ok).toBe(false);

    expect(await confirmAttempts(orderId)).toHaveLength(1);
    expect((await orderOf(orderId)).confirmationAttemptCount).toBe(1);
    expect(await reservedOf(itemId)).toBe(QTY);

    // deliver it, reconcile repeatedly → exactly one EARNED entry
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    for (const status of ["EN_PREPARATION", "EXPEDIEE", "LIVREE"]) {
      expect((await updateOrderStatusAction(fd({ id: orderId, status }))).ok).toBe(true);
    }
    await reconcileOrderCommission(orderId);
    await reconcileOrderCommission(orderId);
    expect(await prisma.commissionEntry.count({ where: { orderId } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7-8. Reopen and reconfirm
// ---------------------------------------------------------------------------

describe("reopen resets the current confirmation state; history stays", () => {
  async function confirmedThenCancelled() {
    const { orderId, itemId } = await seedNouvelleOrder();
    const { user, agent } = await loginConfirmer({ agent: "active" });
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))).ok).toBe(true);
    const firstConfirmedAt = (await orderOf(orderId)).confirmedAt!;
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    expect((await cancelOrderAction(fd({ id: orderId, reason: "client injoignable" }))).ok).toBe(true);
    return { orderId, itemId, firstUser: user, firstAgent: agent!, firstConfirmedAt };
  }

  it("7. CONFIRMEE → ANNULEE → NOUVELLE: confirmedAt and attribution cleared, attempts + audit kept", async () => {
    const { orderId, itemId, firstUser, firstAgent } = await confirmedThenCancelled();
    expect((await orderOf(orderId)).confirmationAgentId).toBe(firstAgent.id);
    const auditBefore = await prisma.auditEvent.findMany({ where: { entityId: orderId }, select: { id: true } });

    expect((await reopenOrderAction(fd({ id: orderId }))).ok).toBe(true);
    const order = await orderOf(orderId);
    expect(order.status).toBe("NOUVELLE");
    expect(order.confirmedAt).toBeNull();
    expect(order.confirmationAgentId).toBeNull();
    expect(order.cancelledAt).toBeNull();
    // history is intact
    expect((await confirmAttempts(orderId)).map((a) => a.agentUserId)).toEqual([firstUser.id]);
    const auditAfter = await prisma.auditEvent.findMany({ where: { entityId: orderId }, select: { id: true } });
    expect(auditAfter.map((a) => a.id)).toEqual(expect.arrayContaining(auditBefore.map((a) => a.id)));
    const reopenAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: orderId, action: "order.status_changed", newValue: { path: ["status"], equals: "NOUVELLE" } },
    });
    expect(reopenAudit.previousValue).toMatchObject({ status: "ANNULEE", confirmationAgentId: firstAgent.id });
    // the reservation was released at cancellation and nothing re-reserved
    expect(await reservedOf(itemId)).toBe(0);
    expect(await prisma.commissionEntry.count({ where: { orderId } })).toBe(0);
  });

  it("8. reconfirm after reopen: new event, new confirmedAt, new attribution (another active agent)", async () => {
    const { orderId, itemId, firstUser, firstConfirmedAt } = await confirmedThenCancelled();
    expect((await reopenOrderAction(fd({ id: orderId }))).ok).toBe(true);

    mockCookieStore.clear();
    const { user: second, agent: secondAgent } = await loginConfirmer({ agent: "active" });
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }))).ok).toBe(true);

    const order = await orderOf(orderId);
    expect(order.status).toBe("CONFIRMEE");
    expect(order.confirmedAt!.getTime()).toBeGreaterThan(firstConfirmedAt.getTime());
    expect(order.confirmationAgentId).toBe(secondAgent!.id);
    expect((await confirmAttempts(orderId)).map((a) => a.agentUserId)).toEqual([firstUser.id, second.id]);
    expect(await reservedOf(itemId)).toBe(QTY); // reserved again exactly once
  });
});

// ---------------------------------------------------------------------------
// 9. Explicit manager attribution is never replaced by a confirmation
// ---------------------------------------------------------------------------

describe("explicit manager attribution", () => {
  it("9. a normal confirmation (queue or direct) does not replace it; the real confirmer is still recorded", async () => {
    for (const via of ["queue", "direct"] as const) {
      await resetDb();
      mockCookieStore.clear();
      const { orderId } = await seedNouvelleOrder();
      const managerAgentUser = await createTestUser({ role: "CONFIRMATION" });
      const assigned = await prisma.commissionAgent.create({ data: { userId: managerAgentUser.id, ratePerOrder: 20 } });
      await loginAsTestUser({ role: "MANAGER" });
      expect((await assignOrderConfirmationAgentAction(fd({ orderId, agentId: assigned.id }))).ok).toBe(true);

      mockCookieStore.clear();
      const { user: confirmer } = await loginConfirmer({ agent: "active" });
      const r =
        via === "queue"
          ? await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))
          : await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }));
      expect(r.ok, via).toBe(true);
      expect((await orderOf(orderId)).confirmationAgentId, via).toBe(assigned.id);
      expect((await confirmAttempts(orderId))[0]?.agentUserId, via).toBe(confirmer.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

describe("guard rails", () => {
  it("an order on an OFFLINE channel is never confirmed through the Online workflow", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const { orderId } = await seedNouvelleOrder();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    await prisma.order.update({ where: { id: orderId }, data: { salesChannelId: store.id } });
    await loginAsTestUser({ role: "ADMIN" });
    const r = await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }));
    expect(r.ok).toBe(false);
    expect((await orderOf(orderId)).status).toBe("NOUVELLE");
    expect(await confirmAttempts(orderId)).toHaveLength(0);
  });

  it("10. Offline sale is unchanged — no confirmation, no attribution involved", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN" } });
    const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casa", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "B-6B", price: 250, status: "ACTIF" } });
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
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(3);
    expect(await prisma.orderConfirmationAttempt.count()).toBe(0);
    expect(await prisma.commissionEntry.count()).toBe(0);
  });
});
