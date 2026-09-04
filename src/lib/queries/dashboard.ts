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

export type RevenueTrendRange = "annee" | "annee-derniere";

export const REVENUE_TREND_LABELS: Record<RevenueTrendRange, string> = {
  annee: "Cette année",
  "annee-derniere": "Année dernière",
};

interface TrendBucket {
  key: string;
  label: string;
  revenue: number;
}

/**
 * Monthly revenue trend for the dashboard chart, for the current year or
 * the previous one — a `RecordSource` narrows it to one sales channel,
 * matching the dashboard's own source filter. Revenue is gross order total
 * of non-cancelled/failed orders, by placedAt.
 */
export async function getRevenueTrend(
  range: RevenueTrendRange = "annee",
  source?: RecordSource
): Promise<TrendBucket[]> {
  const now = new Date();
  const year = range === "annee-derniere" ? now.getFullYear() - 1 : now.getFullYear();
  const from = new Date(year, 0, 1);
  const to = range === "annee-derniere" ? new Date(year, 11, 31, 23, 59, 59) : now;

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: from, lte: to },
      status: { notIn: ["ANNULEE", "ECHEC"] },
      ...(source ? { source } : {}),
    },
    select: { placedAt: true, total: true },
  });

  const buckets: TrendBucket[] = [];
  for (let month = 0; month < 12; month++) {
    const d = new Date(year, month, 1);
    if (d > to) break;
    buckets.push({
      key: `${year}-${month}`,
      label: d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", ""),
      revenue: 0,
    });
  }

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const o of orders) {
    const key = `${o.placedAt.getFullYear()}-${o.placedAt.getMonth()}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.revenue += Number(o.total);
  }
  return buckets;
}
