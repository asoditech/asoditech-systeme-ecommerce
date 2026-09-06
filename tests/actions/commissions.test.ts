import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCommissionAgentAction,
  updateCommissionAgentAction,
  assignOrderConfirmationAgentAction,
  closeCommissionStatementAction,
  markCommissionStatementPaidAction,
} from "@/actions/commissions";
import { updateOrderStatusAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function seedAgentViaAction(rate = 10) {
  const user = await createTestUser({ role: "SALES" });
  const res = await createCommissionAgentAction(fd({ userId: user.id, ratePerOrder: String(rate) }));
  if (!res.ok) throw new Error("agent setup failed");
  return { user, agentId: res.data.id };
}

async function seedDeliveredOrder(agentId: string | null) {
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: "LIVREE",
      confirmationAgentId: agentId,
      subtotal: 300,
      total: 300,
      currency: "MAD",
    },
  });
}

describe("commission actions", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("createCommissionAgentAction requires commissions.manage", async () => {
    await loginAsTestUser({ role: "SALES" });
    const target = await createTestUser({ role: "SALES" });
    await expect(createCommissionAgentAction(fd({ userId: target.id, ratePerOrder: "10" }))).rejects.toThrow(/autoris/i);
  });

  it("assigning an agent to an already-delivered order earns the commission immediately", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(12);
    const order = await seedDeliveredOrder(null);

    const res = await assignOrderConfirmationAgentAction(fd({ orderId: order.id, agentId }));
    expect(res.ok).toBe(true);

    const entries = await prisma.commissionEntry.findMany({ where: { orderId: order.id } });
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBe(12);
  });

  it("refuses to change the agent once a commission entry exists", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction();
    const other = await seedAgentViaAction();
    const order = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: order.id, agentId }));

    const res = await assignOrderConfirmationAgentAction(fd({ orderId: order.id, agentId: other.agentId }));
    expect(res.ok).toBe(false);
  });

  it("full lifecycle via updateOrderStatusAction: earns at LIVREE, reverses at RETOUR", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(15);
    const customer = await prisma.customer.create({ data: { fullName: "C" } });
    const warehouse = await prisma.warehouse.create({ data: { name: "E", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 100, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "EN_PREPARATION",
        confirmationAgentId: agentId,
        subtotal: 100,
        total: 100,
        currency: "MAD",
        items: { create: { productId: product.id, nameSnapshot: "P", skuSnapshot: "S", unitPrice: 100, quantity: 1, total: 100 } },
      },
    });

    await updateOrderStatusAction(fd({ id: order.id, status: "EXPEDIEE" }));
    await updateOrderStatusAction(fd({ id: order.id, status: "LIVREE" }));
    expect(await prisma.commissionEntry.count({ where: { orderId: order.id, type: "EARNED" } })).toBe(1);

    await updateOrderStatusAction(fd({ id: order.id, status: "RETOUR" }));
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: order.id } });
    expect(entries).toHaveLength(2);
    expect(entries.reduce((s, e) => s + Number(e.amount), 0)).toBe(0);
  });

  it("closeCommissionStatementAction sweeps the month, freezes totals, and rejects a double close", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(10);
    const o1 = await seedDeliveredOrder(agentId);
    const o2 = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: o1.id, agentId }));
    await assignOrderConfirmationAgentAction(fd({ orderId: o2.id, agentId }));

    // Backdate the two entries into last month.
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await prisma.commissionEntry.updateMany({ where: { agentId }, data: { createdAt: last } });

    const year = last.getUTCFullYear();
    const month = last.getUTCMonth() + 1;
    const res = await closeCommissionStatementAction(fd({ agentId, periodYear: String(year), periodMonth: String(month) }));
    expect(res.ok).toBe(true);

    const statement = await prisma.commissionStatement.findFirstOrThrow({ where: { agentId } });
    expect(statement.earnedCount).toBe(2);
    expect(Number(statement.netAmount)).toBe(20);
    expect(await prisma.commissionEntry.count({ where: { agentId, statementId: statement.id } })).toBe(2);

    const dup = await closeCommissionStatementAction(fd({ agentId, periodYear: String(year), periodMonth: String(month) }));
    expect(dup.ok).toBe(false);
  });

  it("rejects closing a period with no entries", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction();
    const res = await closeCommissionStatementAction(fd({ agentId, periodYear: "2024", periodMonth: "1" }));
    expect(res.ok).toBe(false);
  });

  it("a reversal after a month is closed lands in the still-open period, not the closed one", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(10);
    const order = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: order.id, agentId }));

    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10));
    await prisma.commissionEntry.updateMany({ where: { agentId }, data: { createdAt: last } });
    await closeCommissionStatementAction(
      fd({ agentId, periodYear: String(last.getUTCFullYear()), periodMonth: String(last.getUTCMonth() + 1) })
    );

    // Return the order now → a REVERSED entry created today, unsettled.
    await prisma.order.update({ where: { id: order.id }, data: { status: "RETOUR" } });
    const { reconcileOrderCommission } = await import("@/lib/commissions");
    await reconcileOrderCommission(order.id);

    const reversed = await prisma.commissionEntry.findFirstOrThrow({ where: { agentId, type: "REVERSED" } });
    expect(reversed.statementId).toBeNull();
  });

  it("markCommissionStatementPaidAction records the payment", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(10);
    const order = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: order.id, agentId }));
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 5));
    await prisma.commissionEntry.updateMany({ where: { agentId }, data: { createdAt: last } });
    const close = await closeCommissionStatementAction(
      fd({ agentId, periodYear: String(last.getUTCFullYear()), periodMonth: String(last.getUTCMonth() + 1) })
    );
    if (!close.ok) throw new Error("close failed");

    const res = await markCommissionStatementPaidAction(fd({ statementId: close.data.id }));
    expect(res.ok).toBe(true);
    const statement = await prisma.commissionStatement.findUniqueOrThrow({ where: { id: close.data.id } });
    expect(statement.status).toBe("PAYE");
    expect(Number(statement.paidAmount)).toBe(10);
    expect(statement.paidAt).not.toBeNull();
  });

  it("updateCommissionAgentAction changes the rate for future earnings only", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { agentId } = await seedAgentViaAction(10);
    const first = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: first.id, agentId }));

    await updateCommissionAgentAction(fd({ agentId, ratePerOrder: "20", isActive: "true" }));
    const second = await seedDeliveredOrder(agentId);
    await assignOrderConfirmationAgentAction(fd({ orderId: second.id, agentId }));

    const e1 = await prisma.commissionEntry.findFirstOrThrow({ where: { orderId: first.id } });
    const e2 = await prisma.commissionEntry.findFirstOrThrow({ where: { orderId: second.id } });
    expect(Number(e1.amount)).toBe(10);
    expect(Number(e2.amount)).toBe(20);
  });
});
