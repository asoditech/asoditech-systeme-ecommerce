import "server-only";

import { prisma } from "@/lib/prisma";
import {
  getFinanceSummary,
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
} from "@/lib/queries/finance";
import { getLowStockCount } from "@/lib/queries/inventory";
import { getDeliveryStats } from "@/lib/queries/delivery";
import type { RecordSource } from "@prisma/client";

export type DashboardPeriod = "mois" | "trimestre" | "annee";

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  mois: "Ce mois",
  trimestre: "Ce trimestre",
  annee: "Cette année",
};

export const DASHBOARD_SOURCE_LABELS: Record<RecordSource, string> = {
  INTERNE: "Interne",
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
};

// An order that has sat NOUVELLE/CONFIRMEE for longer than this is treated
// as history (e.g. a fulfilled store order imported from WooCommerce), not
// something still waiting on the operator.
const ACTION_WINDOW_DAYS = 21;

export async function getDashboardData(periodKey: DashboardPeriod = "mois", source?: RecordSource) {
  const period =
    periodKey === "trimestre"
      ? currentQuarterRange()
      : periodKey === "annee"
        ? currentYearRange()
        : currentMonthRange();
  const previousPeriod = previousPeriodOfSameLength(period);
  const actionCutoff = new Date(Date.now() - ACTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    finance,
    previousFinance,
    lowStockCount,
    deliveryStats,
    ordersRequiringAction,
    recentOrders,
    newCustomersThisPeriod,
    recentAuditEvents,
    failedShipments,
  ] = await Promise.all([
    getFinanceSummary(period, source),
    getFinanceSummary(previousPeriod, source),
    getLowStockCount(),
    getDeliveryStats(),
    prisma.order.findMany({
      where: {
        status: { in: ["NOUVELLE", "CONFIRMEE"] },
        placedAt: { gte: actionCutoff },
        ...(source ? { source } : {}),
      },
      orderBy: { placedAt: "asc" },
      take: 6,
      include: { customer: true },
    }),
    prisma.order.findMany({
      where: source ? { source } : {},
      orderBy: { placedAt: "desc" },
      take: 6,
      include: { customer: true },
    }),
    prisma.customer.count({
      where: { createdAt: { gte: period.from, lte: period.to }, ...(source ? { source } : {}) },
    }),
    prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { actorUser: { select: { name: true } } },
    }),
    prisma.shipment.findMany({
      where: { status: "ECHEC" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: { order: { include: { customer: true } } },
    }),
  ]);

  return {
    periodKey,
    source,
    finance,
    previousFinance,
    lowStockCount,
    deliveryStats,
    ordersRequiringAction,
    recentOrders,
    newCustomersThisPeriod,
    recentAuditEvents,
    failedShipments,
  };
}

export type RevenueTrendRange = "mois" | "mois-dernier" | "3mois" | "annee" | "annee-derniere";

export const REVENUE_TREND_LABELS: Record<RevenueTrendRange, string> = {
  mois: "Ce mois",
  "mois-dernier": "Mois dernier",
  "3mois": "3 derniers mois",
  annee: "Cette année",
  "annee-derniere": "Année dernière",
};

interface TrendBucket {
  key: string;
  label: string;
  revenue: number;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Monday of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = copy.getDay();
  copy.setDate(copy.getDate() + ((day === 0 ? -6 : 1) - day));
  return copy;
}

/**
 * Revenue trend for the dashboard chart, bucketed at whatever granularity
 * fits the requested range (days within a month, weeks across a quarter,
 * months across a year) — a `RecordSource` narrows it to one sales
 * channel, matching the dashboard's own source filter. Revenue is gross
 * order total of non-cancelled/failed orders, by placedAt.
 */
export async function getRevenueTrend(
  range: RevenueTrendRange = "3mois",
  source?: RecordSource
): Promise<TrendBucket[]> {
  const now = new Date();
  let from: Date;
  let to: Date;
  let granularity: "day" | "week" | "month";

  if (range === "mois") {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = now;
    granularity = "day";
  } else if (range === "mois-dernier") {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    granularity = "day";
  } else if (range === "annee") {
    from = new Date(now.getFullYear(), 0, 1);
    to = now;
    granularity = "month";
  } else if (range === "annee-derniere") {
    from = new Date(now.getFullYear() - 1, 0, 1);
    to = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
    granularity = "month";
  } else {
    from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    to = now;
    granularity = "week";
  }

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: from, lte: to },
      status: { notIn: ["ANNULEE", "ECHEC"] },
      ...(source ? { source } : {}),
    },
    select: { placedAt: true, total: true },
  });

  const buckets: TrendBucket[] = [];
  if (granularity === "day") {
    for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      buckets.push({ key: dayKey(d), label: String(d.getDate()), revenue: 0 });
    }
  } else if (granularity === "week") {
    for (const d = startOfWeek(from); d <= to; d.setDate(d.getDate() + 7)) {
      buckets.push({ key: dayKey(d), label: `${d.getDate()}/${d.getMonth() + 1}`, revenue: 0 });
    }
  } else {
    for (const d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d.setMonth(d.getMonth() + 1)) {
      buckets.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        label: d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", ""),
        revenue: 0,
      });
    }
  }

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const o of orders) {
    const key =
      granularity === "day"
        ? dayKey(o.placedAt)
        : granularity === "week"
          ? dayKey(startOfWeek(o.placedAt))
          : `${o.placedAt.getFullYear()}-${o.placedAt.getMonth()}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.revenue += Number(o.total);
  }
  return buckets;
}
