import "server-only";

import { prisma } from "@/lib/prisma";
import { getAgentCommissionTotals, monthBounds } from "@/lib/commissions";

/** Active agents for an assign control / the order form. */
export async function listAssignableCommissionAgents() {
  const agents = await prisma.commissionAgent.findMany({
    where: { isActive: true },
    include: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return agents.map((a) => ({ id: a.id, name: a.user.name, ratePerOrder: Number(a.ratePerOrder) }));
}

/** ACTIVE users who are not already a commission agent — candidates for "add agent". */
export async function listUsersEligibleForAgent() {
  const [users, agents] = await Promise.all([
    prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.commissionAgent.findMany({ select: { userId: true } }),
  ]);
  const taken = new Set(agents.map((a) => a.userId));
  return users.filter((u) => !taken.has(u.id));
}

/** The /commissions overview: every agent with running + lifetime totals. */
export async function listCommissionAgentsWithTotals() {
  const agents = await prisma.commissionAgent.findMany({
    include: { user: { select: { name: true, email: true, role: true } } },
    orderBy: [{ isActive: "desc" }, { user: { name: "asc" } }],
  });
  return Promise.all(
    agents.map(async (a) => ({
      id: a.id,
      userName: a.user.name,
      userEmail: a.user.email,
      userRole: a.user.role,
      ratePerOrder: Number(a.ratePerOrder),
      currency: a.currency,
      isActive: a.isActive,
      totals: await getAgentCommissionTotals(a.id),
    }))
  );
}

/**
 * One agent's full picture: closed statements (newest first) + the
 * still-open entries grouped by the calendar month they were earned in, so
 * the operator can see exactly what a close would sweep up.
 */
export async function getAgentCommissionDetail(agentId: string) {
  const agent = await prisma.commissionAgent.findUnique({
    where: { id: agentId },
    include: { user: { select: { name: true } } },
  });
  if (!agent) return null;

  const [statements, openEntries] = await Promise.all([
    prisma.commissionStatement.findMany({
      where: { agentId },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      include: { closedBy: { select: { name: true } }, paidBy: { select: { name: true } } },
    }),
    prisma.commissionEntry.findMany({
      where: { agentId, statementId: null },
      orderBy: { createdAt: "desc" },
      include: { order: { select: { orderNumber: true, source: true, externalNumber: true } } },
    }),
  ]);

  // Group open entries by "YYYY-MM".
  const byMonth = new Map<
    string,
    { year: number; month: number; earned: number; reversed: number; net: number; earnedCount: number; reversedCount: number }
  >();
  for (const e of openEntries) {
    const d = e.createdAt;
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const bucket = byMonth.get(key) ?? { year, month, earned: 0, reversed: 0, net: 0, earnedCount: 0, reversedCount: 0 };
    const amount = Number(e.amount);
    if (e.type === "EARNED") {
      bucket.earned += amount;
      bucket.earnedCount += 1;
    } else {
      bucket.reversed += amount;
      bucket.reversedCount += 1;
    }
    bucket.net += amount;
    byMonth.set(key, bucket);
  }

  return {
    agent: { id: agent.id, userName: agent.user.name, ratePerOrder: Number(agent.ratePerOrder), currency: agent.currency, isActive: agent.isActive },
    totals: await getAgentCommissionTotals(agentId),
    statements: statements.map((s) => ({
      id: s.id,
      period: `${s.periodYear}-${String(s.periodMonth).padStart(2, "0")}`,
      periodYear: s.periodYear,
      periodMonth: s.periodMonth,
      status: s.status,
      earnedCount: s.earnedCount,
      reversedCount: s.reversedCount,
      netAmount: Number(s.netAmount),
      paidAmount: Number(s.paidAmount),
      currency: s.currency,
      closedByName: s.closedBy?.name ?? "—",
      closedAt: s.closedAt,
      paidByName: s.paidBy?.name ?? null,
      paidAt: s.paidAt,
    })),
    openMonths: [...byMonth.values()].sort((a, b) => b.year - a.year || b.month - a.month),
    openEntries: openEntries.slice(0, 100).map((e) => ({
      id: e.id,
      type: e.type,
      amount: Number(e.amount),
      orderId: e.orderId,
      orderNumber: e.order.orderNumber,
      orderSource: e.order.source,
      orderExternalNumber: e.order.externalNumber,
      createdAt: e.createdAt,
      note: e.note,
    })),
  };
}

/** Commission ledger entries for one order (order-detail display). */
export async function getOrderCommission(orderId: string) {
  const [order, entries] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { confirmationAgentId: true, confirmationAgent: { include: { user: { select: { name: true } } } } },
    }),
    prisma.commissionEntry.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!order) return null;
  const net = entries.reduce((s, e) => s + Number(e.amount), 0);
  return {
    agentId: order.confirmationAgentId,
    agentName: order.confirmationAgent?.user.name ?? null,
    agentRate: order.confirmationAgent ? Number(order.confirmationAgent.ratePerOrder) : null,
    hasEntries: entries.length > 0,
    net,
    entries: entries.map((e) => ({ id: e.id, type: e.type, amount: Number(e.amount), createdAt: e.createdAt, note: e.note })),
  };
}

/** Small helper: the last N closed months as {year, month, label} for the close-period picker. */
export function recentMonthOptions(count = 6): { year: number; month: number; label: string }[] {
  const out: { year: number; month: number; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    out.push({
      year,
      month,
      label: d.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }),
    });
  }
  return out;
}

export { monthBounds };
