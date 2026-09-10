import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  listOrdersAwaitingConfirmation,
  listRecentlyConfirmedOrders,
  listOrdersConfirmedByAgent,
  getConfirmationDashboardSummary,
} from "@/lib/queries/order-confirmation";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

async function seedOrder(overrides: {
  status?: string;
  confirmationAttemptCount?: number;
  confirmationAgentId?: string | null;
}) {
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: (overrides.status ?? "NOUVELLE") as never,
      confirmationAttemptCount: overrides.confirmationAttemptCount ?? 0,
      confirmationAgentId: overrides.confirmationAgentId ?? null,
      subtotal: 100,
      total: 100,
      currency: "MAD",
    },
  });
}

describe("listOrdersAwaitingConfirmation — onlyRetried", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("without onlyRetried returns every NOUVELLE order", async () => {
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 0 });
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 2 });
    await seedOrder({ status: "CONFIRMEE" });

    const { total } = await listOrdersAwaitingConfirmation({});
    expect(total).toBe(2);
  });

  it("with onlyRetried keeps only NOUVELLE orders with at least one attempt", async () => {
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 0 });
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 2 });
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 1 });

    const { total, orders } = await listOrdersAwaitingConfirmation({ onlyRetried: true });
    expect(total).toBe(2);
    expect(orders.every((o) => o.confirmationAttemptCount > 0)).toBe(true);
  });
});

describe("listRecentlyConfirmedOrders", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("excludes NOUVELLE and ANNULEE, and orders never touched by the queue", async () => {
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 1 });
    await seedOrder({ status: "ANNULEE", confirmationAttemptCount: 1 });
    await seedOrder({ status: "CONFIRMEE", confirmationAttemptCount: 0 }); // manually created, skipped the queue
    const viaQueue = await seedOrder({ status: "LIVREE", confirmationAttemptCount: 1 });

    const { total, orders } = await listRecentlyConfirmedOrders({});
    expect(total).toBe(1);
    expect(orders[0].id).toBe(viaQueue.id);
  });
});

describe("listOrdersConfirmedByAgent", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("returns only orders owned by that agent, any status", async () => {
    const user = await createTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: 10 } });
    const otherAgent = await prisma.commissionAgent.create({
      data: { userId: (await createTestUser({ role: "CONFIRMATION" })).id, ratePerOrder: 10 },
    });

    await seedOrder({ status: "CONFIRMEE", confirmationAgentId: agent.id });
    await seedOrder({ status: "LIVREE", confirmationAgentId: agent.id });
    await seedOrder({ status: "LIVREE", confirmationAgentId: otherAgent.id });

    const { total, orders } = await listOrdersConfirmedByAgent(agent.id);
    expect(total).toBe(2);
    expect(orders.every((o) => o.confirmationAgentId === agent.id)).toBe(true);
  });
});

describe("getConfirmationDashboardSummary", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("counts the queue and follow-up backlog", async () => {
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 0 });
    await seedOrder({ status: "NOUVELLE", confirmationAttemptCount: 1 });
    await seedOrder({ status: "CONFIRMEE" });

    const summary = await getConfirmationDashboardSummary();
    expect(summary.toConfirm).toBe(2);
    expect(summary.toRecall).toBe(1);
    expect(summary.confirmedToday).toBe(0);
    expect(summary.confirmedThisMonth).toBe(0);
  });
});
