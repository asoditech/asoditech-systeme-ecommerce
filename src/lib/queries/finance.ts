import "server-only";

import { prisma } from "@/lib/prisma";
import { computePeriodProfitability } from "@/lib/profitability";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { parseZonedDay, zonedDayStartOffset, zonedInstant, zonedParts } from "@/lib/time/zoned";

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
  // Whole days of the business time zone, both ends inclusive.
  const timeZone = await getBusinessTimeZone();
  const dateFrom = parseZonedDay(params.dateFrom, timeZone);
  const dateTo = parseZonedDay(params.dateTo, timeZone, true);
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

// Period helpers — calendar periods of the BUSINESS time zone when
// `timeZone` is given (src/lib/time/zoned.ts; server callers pass
// getBusinessTimeZone()), server-local otherwise. A period ends at its last
// millisecond: the next period's start minus 1 ms.
const lastMsBefore = (d: Date) => new Date(d.getTime() - 1);

export function currentDayRange(timeZone?: string, now: Date = new Date()): PeriodRange {
  return { from: zonedDayStartOffset(now, 0, timeZone), to: lastMsBefore(zonedDayStartOffset(now, 1, timeZone)) };
}

export function yesterdayRange(timeZone?: string, now: Date = new Date()): PeriodRange {
  return { from: zonedDayStartOffset(now, -1, timeZone), to: lastMsBefore(zonedDayStartOffset(now, 0, timeZone)) };
}

export function currentMonthRange(timeZone?: string, now: Date = new Date()): PeriodRange {
  const p = zonedParts(now, timeZone);
  return { from: zonedInstant(timeZone, p.year, p.month, 1), to: lastMsBefore(zonedInstant(timeZone, p.year, p.month + 1, 1)) };
}

export function currentQuarterRange(timeZone?: string, now: Date = new Date()): PeriodRange {
  const p = zonedParts(now, timeZone);
  const quarterStartMonth = Math.floor((p.month - 1) / 3) * 3 + 1;
  return {
    from: zonedInstant(timeZone, p.year, quarterStartMonth, 1),
    to: lastMsBefore(zonedInstant(timeZone, p.year, quarterStartMonth + 3, 1)),
  };
}

export function currentYearRange(timeZone?: string, now: Date = new Date()): PeriodRange {
  const p = zonedParts(now, timeZone);
  return { from: zonedInstant(timeZone, p.year, 1, 1), to: lastMsBefore(zonedInstant(timeZone, p.year + 1, 1, 1)) };
}

export function previousPeriodOfSameLength(period: PeriodRange): PeriodRange {
  const lengthMs = period.to.getTime() - period.from.getTime();
  return {
    from: new Date(period.from.getTime() - lengthMs - 1),
    to: new Date(period.from.getTime() - 1),
  };
}
