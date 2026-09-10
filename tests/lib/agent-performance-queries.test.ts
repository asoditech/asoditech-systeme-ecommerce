import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { reconcileOrderCommission } from "@/lib/commissions";
import { listAgentPerformance } from "@/lib/queries/commissions";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

/**
 * /confirmation/performance's data source. Locked-in definition under test:
 * confirmedTotal = pipeline.total − pipeline.pending (every order that
 * reached CONFIRMEE at least once — cancelled-after-confirmed included),
 * conversion = delivered / confirmedTotal, `null` only when confirmedTotal
 * is 0 (never a fabricated 0%).
 */

async function seedAgent(rate = 10) {
  const user = await createTestUser({ role: "CONFIRMATION" });
  return prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: rate } });
}

async function seedOrder(status: string, agentId: string | null) {
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: status as never,
      confirmationAgentId: agentId,
      subtotal: 100,
      total: 100,
      currency: "MAD",
    },
  });
}

describe("listAgentPerformance", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("10 confirmed, 7 delivered => 70% conversion", async () => {
    const agent = await seedAgent();
    for (let i = 0; i < 7; i++) await seedOrder("LIVREE", agent.id);
    for (let i = 0; i < 3; i++) await seedOrder("EXPEDIEE", agent.id);

    const [row] = await listAgentPerformance();
    expect(row.confirmedTotal).toBe(10);
    expect(row.pipeline.delivered).toBe(7);
    expect(row.conversion).toBeCloseTo(0.7);
  });

  it("10 confirmed, 0 delivered => 0% (a real number, not a fabricated one)", async () => {
    const agent = await seedAgent();
    for (let i = 0; i < 10; i++) await seedOrder("EXPEDIEE", agent.id);

    const [row] = await listAgentPerformance();
    expect(row.confirmedTotal).toBe(10);
    expect(row.conversion).toBe(0);
  });

  it("0 confirmed => conversion is null (no division by zero), not 0%", async () => {
    await seedAgent();
    const [row] = await listAgentPerformance();
    expect(row.confirmedTotal).toBe(0);
    expect(row.conversion).toBeNull();
  });

  it("a NOUVELLE pre-assignment (pending) is excluded from confirmedTotal — it was never actually confirmed", async () => {
    const agent = await seedAgent();
    await seedOrder("NOUVELLE", agent.id);
    await seedOrder("LIVREE", agent.id);

    const [row] = await listAgentPerformance();
    expect(row.pipeline.pending).toBe(1);
    expect(row.confirmedTotal).toBe(1); // total(2) - pending(1)
    expect(row.conversion).toBe(1);
  });

  it("an order confirmed and later cancelled still counts toward confirmedTotal (no silent exclusion)", async () => {
    const agent = await seedAgent();
    await seedOrder("ANNULEE", agent.id); // reached CONFIRMEE at some point per the state machine, then cancelled
    await seedOrder("LIVREE", agent.id);

    const [row] = await listAgentPerformance();
    expect(row.confirmedTotal).toBe(2);
    expect(row.conversion).toBe(0.5);
  });

  it("reports existing pipeline return counts using the same bucket definitions", async () => {
    const agent = await seedAgent();
    await seedOrder("RETOUR", agent.id);
    await seedOrder("REMBOURSEE", agent.id);
    await seedOrder("LIVREE", agent.id);

    const [row] = await listAgentPerformance();
    expect(row.pipeline.returned).toBe(2);
  });

  it("reads EARNED and REVERSED commission from the existing ledger, net = earned - reversed", async () => {
    const agent = await seedAgent(20);
    const delivered = await seedOrder("LIVREE", agent.id);
    const returned = await seedOrder("LIVREE", agent.id);
    await reconcileOrderCommission(delivered.id);
    await reconcileOrderCommission(returned.id);
    await prisma.order.update({ where: { id: returned.id }, data: { status: "RETOUR" } });
    await reconcileOrderCommission(returned.id);

    const [row] = await listAgentPerformance();
    expect(row.breakdown.earnedAmount).toBe(40);
    expect(row.breakdown.reversedAmount).toBe(-20);
    expect(row.breakdown.netAmount).toBe(20);

    // Delivery/return never create a second calculation path — exactly one
    // EARNED and one REVERSED entry exist for the returned order.
    expect(await prisma.commissionEntry.count({ where: { orderId: returned.id } })).toBe(2);
  });

  it("keeps multiple agents' orders and commissions fully separated", async () => {
    const sara = await seedAgent(10);
    const yassine = await seedAgent(15);
    for (let i = 0; i < 5; i++) await seedOrder("LIVREE", sara.id);
    for (let i = 0; i < 2; i++) await seedOrder("LIVREE", yassine.id);
    await seedOrder("EXPEDIEE", yassine.id);

    const rows = await listAgentPerformance();
    const saraRow = rows.find((r) => r.id === sara.id)!;
    const yassineRow = rows.find((r) => r.id === yassine.id)!;

    expect(saraRow.confirmedTotal).toBe(5);
    expect(saraRow.pipeline.delivered).toBe(5);
    expect(yassineRow.confirmedTotal).toBe(3);
    expect(yassineRow.pipeline.delivered).toBe(2);
  });
});
