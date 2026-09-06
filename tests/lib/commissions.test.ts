import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileOrderCommission, getAgentCommissionTotals } from "@/lib/commissions";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

async function seedAgent(rate = 10) {
  const user = await createTestUser({ role: "SALES" });
  const agent = await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: rate } });
  return { user, agent };
}

async function seedOrder(opts: { status?: string; agentId?: string | null } = {}) {
  const customer = await prisma.customer.create({ data: { fullName: "Client X" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: (opts.status ?? "EXPEDIEE") as never,
      confirmationAgentId: opts.agentId ?? null,
      subtotal: 200,
      total: 200,
      currency: "MAD",
    },
  });
}

describe("reconcileOrderCommission", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("creates a single EARNED entry when a delivered order has an agent", async () => {
    const { agent } = await seedAgent(12);
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });

    const r = await reconcileOrderCommission(order.id);
    expect(r.outcome).toBe("earned");
    expect(r.amount).toBe(12);

    const entries = await prisma.commissionEntry.findMany({ where: { orderId: order.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("EARNED");
    expect(Number(entries[0].amount)).toBe(12);
    expect(Number(entries[0].rateApplied)).toBe(12);
  });

  it("does nothing without an agent, or when the order is not delivered", async () => {
    const { agent } = await seedAgent();
    const noAgent = await seedOrder({ status: "LIVREE", agentId: null });
    const notDelivered = await seedOrder({ status: "EXPEDIEE", agentId: agent.id });

    expect((await reconcileOrderCommission(noAgent.id)).outcome).toBe("unchanged");
    expect((await reconcileOrderCommission(notDelivered.id)).outcome).toBe("unchanged");
    expect(await prisma.commissionEntry.count()).toBe(0);
  });

  it("is idempotent — repeated calls never double-credit", async () => {
    const { agent } = await seedAgent();
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });

    await reconcileOrderCommission(order.id);
    await reconcileOrderCommission(order.id);
    await reconcileOrderCommission(order.id);

    expect(await prisma.commissionEntry.count({ where: { orderId: order.id, type: "EARNED" } })).toBe(1);
  });

  it("concurrent reconciles resolve to exactly one EARNED entry", async () => {
    const { agent } = await seedAgent();
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });

    await Promise.all([
      reconcileOrderCommission(order.id),
      reconcileOrderCommission(order.id),
      reconcileOrderCommission(order.id),
    ]);

    expect(await prisma.commissionEntry.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("keeps the rate snapshot — a later rate change does not touch an earned entry", async () => {
    const { agent } = await seedAgent(10);
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });
    await reconcileOrderCommission(order.id);

    await prisma.commissionAgent.update({ where: { id: agent.id }, data: { ratePerOrder: 25 } });
    await reconcileOrderCommission(order.id);

    const entry = await prisma.commissionEntry.findFirstOrThrow({ where: { orderId: order.id, type: "EARNED" } });
    expect(Number(entry.amount)).toBe(10);
  });

  it("reverses when a previously-earned order leaves LIVREE (return), netting to zero", async () => {
    const { agent } = await seedAgent(15);
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });
    await reconcileOrderCommission(order.id);

    await prisma.order.update({ where: { id: order.id }, data: { status: "RETOUR" } });
    const r = await reconcileOrderCommission(order.id);
    expect(r.outcome).toBe("reversed");

    const entries = await prisma.commissionEntry.findMany({ where: { orderId: order.id } });
    expect(entries).toHaveLength(2);
    expect(entries.reduce((s, e) => s + Number(e.amount), 0)).toBe(0);

    // No third entry on a repeat.
    await reconcileOrderCommission(order.id);
    expect(await prisma.commissionEntry.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("does not re-earn after a reversal even if the order somehow returns to LIVREE", async () => {
    const { agent } = await seedAgent();
    const order = await seedOrder({ status: "LIVREE", agentId: agent.id });
    await reconcileOrderCommission(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: "RETOUR" } });
    await reconcileOrderCommission(order.id);

    await prisma.order.update({ where: { id: order.id }, data: { status: "LIVREE" } });
    await reconcileOrderCommission(order.id);

    expect(await prisma.commissionEntry.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("getAgentCommissionTotals reflects earned, reversed and remaining", async () => {
    const { agent } = await seedAgent(10);
    const a = await seedOrder({ status: "LIVREE", agentId: agent.id });
    const b = await seedOrder({ status: "LIVREE", agentId: agent.id });
    await reconcileOrderCommission(a.id);
    await reconcileOrderCommission(b.id);
    await prisma.order.update({ where: { id: b.id }, data: { status: "RETOUR" } });
    await reconcileOrderCommission(b.id);

    const totals = await getAgentCommissionTotals(agent.id);
    expect(totals.unsettledEarnedCount).toBe(2);
    expect(totals.unsettledReversedCount).toBe(1);
    expect(totals.unsettledNet).toBe(10); // 10 + 10 − 10
    expect(totals.lifetimeNet).toBe(10);
    expect(totals.paidTotal).toBe(0);
    expect(totals.remaining).toBe(10);
  });
});
