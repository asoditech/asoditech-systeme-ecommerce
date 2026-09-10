import "server-only";

import { prisma } from "@/lib/prisma";
import { computePeriodProfitability } from "@/lib/profitability";

export interface PeriodRange {
  from: Date;
  to: Date;
}

/**
 * The period P&L — CA, refunds, COGS (from `OrderItem.costSnapshot` only,
 * `cogsComplete` false when any is missing), delivery cost, expenses
 * (advertising broken out), gross/net profit and their margins.
 *
 * Now a thin wrapper over `computePeriodProfitability` in
 * `src/lib/profitability.ts` — the same Decimal-safe engine the order
 * detail, product detail and Analytics use, so the four surfaces can't
 * drift. Cancelled / failed / returned / refunded orders contribute
 * neither revenue nor COGS; a partial refund on an order still counted
 * nets out via its `refunds` relation, attributed to the ORDER's period
 * (not the refund's own date). See docs/adr/0007-finance-and-profit.md.
 */
export async function getFinanceSummary(period: PeriodRange, source?: Parameters<typeof computePeriodProfitability>[1]) {
  return computePeriodProfitability(period, source);
}

export type ExpenseSort = "recent" | "amount-desc" | "amount-asc";

function parseExpenseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const d = new Date(endOfDay ? `${value}T23:59:59` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function listExpenses(params: {
  q?: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: ExpenseSort;
  page?: number;
}) {
  const PAGE_SIZE = 25;
  const page = Math.max(1, params.page ?? 1);
  const dateFrom = parseExpenseDate(params.dateFrom);
  const dateTo = parseExpenseDate(params.dateTo, true);
  const where = {
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.q
      ? {
          OR: [
            { description: { contains: params.q, mode: "insensitive" as const } },
            { vendor: { contains: params.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(dateFrom || dateTo
      ? {
          date: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
  };
  const orderBy =
    params.sort === "amount-desc"
      ? { amount: "desc" as const }
      : params.sort === "amount-asc"
        ? { amount: "asc" as const }
        : { date: "desc" as const };

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy,
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

export function currentDayRange(): PeriodRange {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  return { from, to };
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
