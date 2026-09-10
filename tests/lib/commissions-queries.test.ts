import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileOrderCommission } from "@/lib/commissions";
import { getAgentOrderPipeline, getAgentCommissionBreakdown } from "@/lib/queries/commissions";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

async function seedAgent(rate = 10) {
  const user = await createTestUser({ role: "CONFIRMATION" });
  const agent = await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: rate } });
  return agent;
}

async function seedOrder(status: string, agentId: string | null, confirmedAt: Date | null = null) {
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: status as never,
      confirmationAgentId: agentId,
      confirmedAt,
      subtotal: 100,
      total: 100,
      currency: "MAD",
    },
  });
}

describe("getAgentOrderPipeline", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("buckets an agent's orders by lifecycle stage, ignoring other agents' orders", async () => {
    const agent = await seedAgent();
    const other = await seedAgent();
    await seedOrder("NOUVELLE", agent.id);
    await seedOrder("CONFIRMEE", agent.id);
    await seedOrder("EXPEDIEE", agent.id);
    await seedOrder("LIVREE", agent.id);
    await seedOrder("LIVREE", agent.id);
    await seedOrder("RETOUR", agent.id);
    await seedOrder("ANNULEE", agent.id);
    await seedOrder("LIVREE", other.id); // must not leak into `agent`'s pipeline

    const pipeline = await getAgentOrderPipeline(agent.id);
    expect(pipeline).toEqual({ pending: 1, confirmed: 2, delivered: 2, returned: 1, cancelled: 1, total: 7 });
  });

  it("returns all zeros for an agent with no orders", async () => {
    const agent = await seedAgent();
    expect(await getAgentOrderPipeline(agent.id)).toEqual({
      pending: 0,
      confirmed: 0,
      delivered: 0,
      returned: 0,
      cancelled: 0,
      total: 0,
    });
  });

  it("with no range, behaves exactly as before (backward compatible)", async () => {
    const agent = await seedAgent();
    await seedOrder("LIVREE", agent.id, new Date("2024-01-01"));
    await seedOrder("LIVREE", agent.id, null);

    expect(await getAgentOrderPipeline(agent.id)).toEqual(await getAgentOrderPipeline(agent.id, undefined));
    expect((await getAgentOrderPipeline(agent.id)).delivered).toBe(2);
  });

  it("a range filters on Order.confirmedAt, not createdAt — excludes orders outside it and pending (null confirmedAt) orders", async () => {
    const agent = await seedAgent();
    await seedOrder("LIVREE", agent.id, new Date("2024-06-15")); // inside June
    await seedOrder("RETOUR", agent.id, new Date("2024-06-20")); // inside June
    await seedOrder("LIVREE", agent.id, new Date("2024-07-01")); // outside — July
    await seedOrder("NOUVELLE", agent.id, null); // pending — never confirmed, no confirmedAt at all

    const june = await getAgentOrderPipeline(agent.id, {
      from: new Date("2024-06-01"),
      to: new Date("2024-06-30T23:59:59"),
    });
    expect(june).toEqual({ pending: 0, confirmed: 0, delivered: 1, returned: 1, cancelled: 0, total: 2 });
  });
});

describe("getAgentCommissionBreakdown", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("sums gross EARNED/REVERSED regardless of settlement", async () => {
    const agent = await seedAgent(15);
    const delivered = await seedOrder("LIVREE", agent.id);
    const returned = await seedOrder("LIVREE", agent.id);
    await reconcileOrderCommission(delivered.id);
    await reconcileOrderCommission(returned.id);
    await prisma.order.update({ where: { id: returned.id }, data: { status: "RETOUR" } });
    await reconcileOrderCommission(returned.id);

    const breakdown = await getAgentCommissionBreakdown(agent.id);
    expect(breakdown.earnedCount).toBe(2);
    expect(breakdown.earnedAmount).toBe(30);
    expect(breakdown.reversedCount).toBe(1);
    expect(breakdown.reversedAmount).toBe(-15);
    expect(breakdown.netAmount).toBe(15);
  });

  it("returns zeros for an agent with no entries", async () => {
    const agent = await seedAgent();
    expect(await getAgentCommissionBreakdown(agent.id)).toEqual({
      earnedAmount: 0,
      earnedCount: 0,
      reversedAmount: 0,
      reversedCount: 0,
      netAmount: 0,
    });
  });

  it("a range filters on CommissionEntry.createdAt, matching getCommissionDashboardSummary's semantics", async () => {
    const agent = await seedAgent(10);
    const inRange = await seedOrder("LIVREE", agent.id);
    const outOfRange = await seedOrder("LIVREE", agent.id);
    await reconcileOrderCommission(inRange.id);
    await reconcileOrderCommission(outOfRange.id);
    await prisma.commissionEntry.updateMany({
      where: { orderId: inRange.id },
      data: { createdAt: new Date("2024-06-15") },
    });
    await prisma.commissionEntry.updateMany({
      where: { orderId: outOfRange.id },
      data: { createdAt: new Date("2024-07-15") },
    });

    const june = await getAgentCommissionBreakdown(agent.id, {
      from: new Date("2024-06-01"),
      to: new Date("2024-06-30T23:59:59"),
    });
    expect(june.earnedCount).toBe(1);
    expect(june.earnedAmount).toBe(10);
  });
});
