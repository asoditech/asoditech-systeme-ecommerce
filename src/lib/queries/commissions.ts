import "server-only";

import { prisma } from "@/lib/prisma";
import { getAgentCommissionTotals, monthBounds } from "@/lib/commissions";
import type { OrderStatus } from "@prisma/client";

/** The CommissionAgent id for a user, if they're registered as an agent — used to scope "Mes confirmations" to the current caller. */
export async function getCommissionAgentIdForUser(userId: string): Promise<string | null> {
  const agent = await prisma.commissionAgent.findUnique({ where: { userId }, select: { id: true } });
  return agent?.id ?? null;
}

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
      pipeline: await getAgentOrderPipeline(a.id),
    }))
  );
}

export interface AgentOrderPipeline {
  /** Owns the order, still NOUVELLE (rare — a manual pre-confirmation assignment). */
  pending: number;
  /** Owns the order, confirmed but not yet delivered/returned/cancelled. */
  confirmed: number;
  delivered: number;
  returned: number;
  cancelled: number;
  total: number;
}

const PIPELINE_BUCKET: Record<OrderStatus, keyof Omit<AgentOrderPipeline, "total">> = {
  NOUVELLE: "pending",
  CONFIRMEE: "confirmed",
  EN_PREPARATION: "confirmed",
  EXPEDIEE: "confirmed",
  LIVREE: "delivered",
  RETOUR: "returned",
  REMBOURSEE: "returned",
  ANNULEE: "cancelled",
  ECHEC: "cancelled",
};

export interface DateRange {
  from?: Date;
  to?: Date;
}

/**
 * Per-agent order counts by pipeline stage — shows confirmed→delivered
 * conversion instead of a raw confirmation count. Read-only aggregate over
 * `Order.confirmationAgentId`; does not touch the commission ledger.
 *
 * An optional `range` scopes this to orders *confirmed* within that window
 * (filters `Order.confirmedAt`, the ADR-0029 confirmation timestamp — not
 * `createdAt`). This makes a ranged call a confirmation cohort: an order
 * confirmed inside the range but returned after it is still counted, under
 * its current status. Omitted ⇒ identical to the pre-existing behavior.
 */
export async function getAgentOrderPipeline(agentId: string, range?: DateRange): Promise<AgentOrderPipeline> {
  const rows = await prisma.order.groupBy({
    by: ["status"],
    where: {
      confirmationAgentId: agentId,
      ...(range?.from || range?.to
        ? { confirmedAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {}),
    },
    _count: true,
  });
  const result: AgentOrderPipeline = { pending: 0, confirmed: 0, delivered: 0, returned: 0, cancelled: 0, total: 0 };
  for (const row of rows) {
    const bucket = PIPELINE_BUCKET[row.status];
    result[bucket] += row._count;
    result.total += row._count;
  }
  return result;
}

export interface AgentCommissionBreakdown {
  earnedAmount: number;
  earnedCount: number;
  reversedAmount: number;
  reversedCount: number;
  netAmount: number;
}

/**
 * Gross EARNED/REVERSED split for one agent, regardless of settlement —
 * distinct from `getAgentCommissionTotals` (unsettled/paid).
 *
 * An optional `range` scopes this to ledger entries *created* within that
 * window (filters `CommissionEntry.createdAt` — the same field
 * `getCommissionDashboardSummary`'s "earned this month" already uses).
 * Event-based, unlike `getAgentOrderPipeline`'s cohort semantics. Omitted
 * ⇒ identical to the pre-existing (lifetime) behavior.
 */
export async function getAgentCommissionBreakdown(agentId: string, range?: DateRange): Promise<AgentCommissionBreakdown> {
  const rows = await prisma.commissionEntry.groupBy({
    by: ["type"],
    where: {
      agentId,
      ...(range?.from || range?.to
        ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) } }
        : {}),
    },
    _sum: { amount: true },
    _count: true,
  });
  const earned = rows.find((r) => r.type === "EARNED");
  const reversed = rows.find((r) => r.type === "REVERSED");
  const earnedAmount = Number(earned?._sum.amount ?? 0);
  const reversedAmount = Number(reversed?._sum.amount ?? 0);
  return {
    earnedAmount,
    earnedCount: earned?._count ?? 0,
    reversedAmount,
    reversedCount: reversed?._count ?? 0,
    netAmount: earnedAmount + reversedAmount,
  };
}

export interface CommissionDashboardSummary {
  earnedThisMonth: number;
  remainingTotal: number;
  currency: string;
}

/** Compact Dashboard tiles: this month's gross earned + aggregate remaining. */
export async function getCommissionDashboardSummary(): Promise<CommissionDashboardSummary> {
  const now = new Date();
  const { start, end } = monthBounds(now.getFullYear(), now.getMonth() + 1);
  const [earned, agents] = await Promise.all([
    prisma.commissionEntry.aggregate({
      where: { type: "EARNED", createdAt: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.commissionAgent.findMany({ where: { isActive: true }, select: { id: true, currency: true } }),
  ]);
  const totals = await Promise.all(agents.map((a) => getAgentCommissionTotals(a.id)));
  return {
    earnedThisMonth: Number(earned._sum.amount ?? 0),
    remainingTotal: totals.reduce((sum, t) => sum + t.remaining, 0),
    currency: agents[0]?.currency ?? "MAD",
  };
}

export interface AgentPerformanceRow {
  id: string;
  userName: string;
  isActive: boolean;
  currency: string;
  pipeline: AgentOrderPipeline;
  breakdown: AgentCommissionBreakdown;
  /** pipeline.total − pipeline.pending — orders that reached CONFIRMEE at least once, per docs/adr/0029-order-confirmation-workflow.md. */
  confirmedTotal: number;
  /** delivered / confirmedTotal, or null when confirmedTotal is 0 (never 0% — a real division-by-zero case). */
  conversion: number | null;
}

/**
 * The /confirmation/performance table: every agent's pipeline + gross
 * commission breakdown for an optional period, plus the derived
 * confirmed→delivered conversion. Pure composition of
 * `getAgentOrderPipeline`/`getAgentCommissionBreakdown` — no new
 * aggregation logic, no ledger writes.
 */
export async function listAgentPerformance(range?: DateRange): Promise<AgentPerformanceRow[]> {
  const agents = await prisma.commissionAgent.findMany({
    include: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return Promise.all(
    agents.map(async (a) => {
      const [pipeline, breakdown] = await Promise.all([
        getAgentOrderPipeline(a.id, range),
        getAgentCommissionBreakdown(a.id, range),
      ]);
      const confirmedTotal = pipeline.total - pipeline.pending;
      return {
        id: a.id,
        userName: a.user.name,
        isActive: a.isActive,
        currency: a.currency,
        pipeline,
        breakdown,
        confirmedTotal,
        conversion: confirmedTotal > 0 ? pipeline.delivered / confirmedTotal : null,
      };
    })
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
      include: {
        order: { select: { orderNumber: true, displayNumber: true, source: true, externalNumber: true, status: true } },
      },
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
    pipeline: await getAgentOrderPipeline(agentId),
    breakdown: await getAgentCommissionBreakdown(agentId),
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
      orderDisplayNumber: e.order.displayNumber,
      orderSource: e.order.source,
      orderExternalNumber: e.order.externalNumber,
      orderStatus: e.order.status,
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
