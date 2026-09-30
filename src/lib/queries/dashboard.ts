import "server-only";

import { prisma } from "@/lib/prisma";
import {
  getFinanceSummary,
  currentDayRange,
  yesterdayRange,
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
} from "@/lib/queries/finance";
import { getLowStockCount, getLowStockCountForViewer } from "@/lib/queries/inventory";
import { getDeliveryStats } from "@/lib/queries/delivery";
import type { Prisma, RecordSource } from "@prisma/client";

export type DashboardPeriod = "jour" | "hier" | "mois" | "trimestre" | "annee";

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, string> = {
  jour: "Aujourd'hui",
  hier: "Hier",
  mois: "Ce mois",
  trimestre: "Ce trimestre",
  annee: "Cette année",
};

export function isDashboardPeriod(value: string | undefined): value is DashboardPeriod {
  return value != null && value in DASHBOARD_PERIOD_LABELS;
}

// An order that has sat NOUVELLE for longer than this is treated as history
// (e.g. a fulfilled store order imported from WooCommerce), not something
// still waiting on the operator.
const ACTION_WINDOW_DAYS = 21;

export async function getDashboardData(
  periodKey: DashboardPeriod = "mois",
  source?: RecordSource,
  // Channel read scope (docs/adr/0039): the viewer's audit-event restriction.
  // `viewer` (Phase 4A, G5 — docs/adr/0042): scopes the low-stock count to
  // the viewer's locations; omitted, the count stays tenant-wide.
  opts: { auditScope?: Prisma.AuditEventWhereInput; viewer?: Parameters<typeof getLowStockCountForViewer>[0] } = {}
) {
  const period =
    periodKey === "jour"
      ? currentDayRange()
      : periodKey === "hier"
        ? yesterdayRange()
        : periodKey === "trimestre"
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
  ] = await Promise.all([
    getFinanceSummary(period, source),
    getFinanceSummary(previousPeriod, source),
    opts.viewer ? getLowStockCountForViewer(opts.viewer) : getLowStockCount(),
    getDeliveryStats(),
    prisma.order.findMany({
      where: {
        // UI refinement pass (2026-09): NOUVELLE only — "needs initial
        // action" means nobody has acted on it yet. A CONFIRMEE order has
        // already been acted on (it moved past NOUVELLE); it belongs to
        // the confirmation/delivery pipeline, not this list.
        status: "NOUVELLE",
        placedAt: { gte: actionCutoff },
        ...(source ? { source } : {}),
      },
      orderBy: { placedAt: "asc" },
      take: 6,
      // Only the fallback name is needed — the dashboard shows each order's
      // own `shippingName` snapshot via `displayOrderRecipient` (ADR 0030);
      // narrowing the select keeps a future edit from reintroducing the
      // "wrong customer name" bug by reaching for another customer field.
      include: { customer: { select: { fullName: true } } },
    }),
    prisma.order.findMany({
      where: source ? { source } : {},
      orderBy: { placedAt: "desc" },
      take: 6,
      include: { customer: { select: { fullName: true } } },
    }),
    prisma.customer.count({
      where: { createdAt: { gte: period.from, lte: period.to }, ...(source ? { source } : {}) },
    }),
    prisma.auditEvent.findMany({
      where: opts.auditScope ?? {},
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { actorUser: { select: { name: true } } },
    }),
  ]);

  return {
    periodKey,
    // The resolved date range for `periodKey` (Batch 8, Area 4) — exposed so
    // a caller that needs the SAME period for a second, non-Order source
    // (e.g. the dashboard's in-store sales KPI) reuses this instead of
    // re-deriving the periodKey → range mapping a second time.
    period,
    source,
    finance,
    previousFinance,
    lowStockCount,
    deliveryStats,
    ordersRequiringAction,
    recentOrders,
    newCustomersThisPeriod,
    recentAuditEvents,
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
