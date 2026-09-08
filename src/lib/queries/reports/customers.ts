import "server-only";

import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * Customer report — acquisition and repeat behaviour over orders PLACED
 * in the window.
 *
 * "New" = the customer's first-ever order (anywhere in history) falls in
 * the window; "returning" = they had at least one earlier order. Repeat
 * rate is returning ÷ distinct buyers this window. `topCustomers` and
 * `byCity` rank by revenue over non-excluded orders in the window.
 */

export interface CustomerReportRow {
  customerId: string;
  name: string;
  city: string | null;
  orders: number;
  revenue: number;
  firstOrderAt: string;
  isNew: boolean;
}

export interface CustomerReport {
  totals: {
    distinctBuyers: number;
    newCustomers: number;
    returningCustomers: number;
    repeatRatePct: number | null;
    revenueFromNew: number;
    revenueFromReturning: number;
    avgOrdersPerBuyer: number | null;
    avgRevenuePerBuyer: number | null;
  };
  topCustomers: CustomerReportRow[];
  byCity: { city: string; buyers: number; orders: number; revenue: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function getCustomerReport(range: PeriodRange): Promise<CustomerReport> {
  const windowOrders = await prisma.order.findMany({
    where: { placedAt: { gte: range.from, lte: range.to }, status: { notIn: REVENUE_EXCLUDED_STATUSES } },
    select: {
      customerId: true,
      total: true,
      placedAt: true,
      customer: { select: { fullName: true, city: true } },
    },
  });

  const buyerIds = [...new Set(windowOrders.map((o) => o.customerId))];

  // Earliest order per buyer, across ALL history — to classify new vs returning.
  const firstOrders = await prisma.order.groupBy({
    by: ["customerId"],
    where: { customerId: { in: buyerIds } },
    _min: { placedAt: true },
  });
  const firstOrderAt = new Map(firstOrders.map((f) => [f.customerId, f._min.placedAt]));

  const byCustomer = new Map<
    string,
    { name: string; city: string | null; orders: number; revenue: number }
  >();
  for (const o of windowOrders) {
    const g =
      byCustomer.get(o.customerId) ??
      { name: o.customer.fullName, city: o.customer.city, orders: 0, revenue: 0 };
    g.orders += 1;
    g.revenue += Number(o.total);
    byCustomer.set(o.customerId, g);
  }

  let newCustomers = 0;
  let returningCustomers = 0;
  let revenueFromNew = 0;
  let revenueFromReturning = 0;
  const rows: CustomerReportRow[] = [];
  for (const [customerId, g] of byCustomer) {
    const first = firstOrderAt.get(customerId) ?? null;
    const isNew = first != null && first >= range.from && first <= range.to;
    if (isNew) {
      newCustomers += 1;
      revenueFromNew += g.revenue;
    } else {
      returningCustomers += 1;
      revenueFromReturning += g.revenue;
    }
    rows.push({
      customerId,
      name: g.name,
      city: g.city,
      orders: g.orders,
      revenue: round2(g.revenue),
      firstOrderAt: first ? first.toLocaleDateString("en-CA") : "—",
      isNew,
    });
  }
  rows.sort((a, b) => b.revenue - a.revenue);

  const byCityMap = new Map<string, { buyers: Set<string>; orders: number; revenue: number }>();
  for (const o of windowOrders) {
    const city = o.customer.city?.trim() || "Ville inconnue";
    const g = byCityMap.get(city) ?? { buyers: new Set<string>(), orders: 0, revenue: 0 };
    g.buyers.add(o.customerId);
    g.orders += 1;
    g.revenue += Number(o.total);
    byCityMap.set(city, g);
  }

  const totalRevenue = revenueFromNew + revenueFromReturning;
  const totalOrders = windowOrders.length;

  return {
    totals: {
      distinctBuyers: buyerIds.length,
      newCustomers,
      returningCustomers,
      repeatRatePct: buyerIds.length > 0 ? round1((returningCustomers / buyerIds.length) * 100) : null,
      revenueFromNew: round2(revenueFromNew),
      revenueFromReturning: round2(revenueFromReturning),
      avgOrdersPerBuyer: buyerIds.length > 0 ? round1(totalOrders / buyerIds.length) : null,
      avgRevenuePerBuyer: buyerIds.length > 0 ? round2(totalRevenue / buyerIds.length) : null,
    },
    topCustomers: rows.slice(0, 50),
    byCity: [...byCityMap.entries()]
      .map(([city, g]) => ({ city, buyers: g.buyers.size, orders: g.orders, revenue: round2(g.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
  };
}
