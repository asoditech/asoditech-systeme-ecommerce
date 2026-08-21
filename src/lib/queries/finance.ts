import "server-only";

import { prisma } from "@/lib/prisma";
import type { OrderStatus } from "@prisma/client";

const NON_REVENUE_STATUSES: OrderStatus[] = ["ANNULEE", "ECHEC"];

export interface PeriodRange {
  from: Date;
  to: Date;
}

/**
 * Revenue = total of orders that weren't cancelled/failed, minus completed
 * refunds, in the period. COGS is summed only from order items that have a
 * costSnapshot — if any are missing, `cogsComplete` is false and the caller
 * must show that the figure is partial rather than presenting it as exact.
 * Net profit is never computed here as a single fabricated number when the
 * inputs are incomplete — see docs/adr/0007-finance-and-profit.md.
 */
export async function getFinanceSummary(period: PeriodRange) {
  const orders = await prisma.order.findMany({
    where: {
      createdAt: { gte: period.from, lte: period.to },
      status: { notIn: NON_REVENUE_STATUSES },
    },
    include: { items: true },
  });

  const revenue = orders.reduce((sum, o) => sum + Number(o.total), 0);

  let cogs = 0;
  let cogsComplete = true;
  let itemCount = 0;
  for (const order of orders) {
    for (const item of order.items) {
      itemCount++;
      if (item.costSnapshot === null) {
        cogsComplete = false;
        continue;
      }
      cogs += Number(item.costSnapshot) * item.quantity;
    }
  }
  if (itemCount === 0) cogsComplete = false;

  const refunds = await prisma.refund.aggregate({
    where: { createdAt: { gte: period.from, lte: period.to }, status: "COMPLETE" },
    _sum: { amount: true },
  });
  const refundsTotal = Number(refunds._sum.amount ?? 0);

  const expenses = await prisma.expense.aggregate({
    where: { date: { gte: period.from, lte: period.to } },
    _sum: { amount: true },
  });
  const expensesTotal = Number(expenses._sum.amount ?? 0);

  const deliveryCost = await prisma.shipment.aggregate({
    where: { createdAt: { gte: period.from, lte: period.to }, cost: { not: null } },
    _sum: { cost: true },
  });
  const deliveryCostTotal = Number(deliveryCost._sum.cost ?? 0);

  const netRevenue = revenue - refundsTotal;
  const grossProfit = cogsComplete ? netRevenue - cogs : null;
  const netProfit = cogsComplete ? grossProfit! - expensesTotal - deliveryCostTotal : null;

  return {
    ordersCount: orders.length,
    revenue: netRevenue,
    cogs: cogsComplete ? cogs : null,
    cogsComplete,
    grossProfit,
    expensesTotal,
    deliveryCostTotal,
    refundsTotal,
    netProfit,
  };
}

export async function listExpenses(params: { categoryId?: string; dateFrom?: string; dateTo?: string; page?: number }) {
  const PAGE_SIZE = 25;
  const page = Math.max(1, params.page ?? 1);
  const where = {
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          date: {
            ...(params.dateFrom ? { gte: new Date(params.dateFrom) } : {}),
            ...(params.dateTo ? { lte: new Date(params.dateTo + "T23:59:59") } : {}),
          },
        }
      : {}),
  };

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { category: true, recordedBy: { select: { name: true } } },
    }),
    prisma.expense.count({ where }),
  ]);

  return { expenses, total, page, pageSize: PAGE_SIZE };
}

export async function listExpenseCategories() {
  return prisma.expenseCategory.findMany({ orderBy: { name: "asc" } });
}

export function currentMonthRange(): PeriodRange {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { from, to };
}

export function currentQuarterRange(): PeriodRange {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
  const from = new Date(now.getFullYear(), quarterStartMonth, 1);
  const to = new Date(now.getFullYear(), quarterStartMonth + 3, 0, 23, 59, 59);
  return { from, to };
}

export function currentYearRange(): PeriodRange {
  const now = new Date();
  return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear(), 11, 31, 23, 59, 59) };
}

export function previousPeriodOfSameLength(period: PeriodRange): PeriodRange {
  const lengthMs = period.to.getTime() - period.from.getTime();
  return {
    from: new Date(period.from.getTime() - lengthMs - 1),
    to: new Date(period.from.getTime() - 1),
  };
}
