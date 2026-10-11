import "server-only";

import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import { DASHBOARD_HIDDEN_AUDIT_ACTIONS } from "@/lib/audit-classification";
import {
  getFinanceSummary,
  currentDayRange,
  yesterdayRange,
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
  type PeriodRange,
} from "@/lib/queries/finance";
import { getLowStockCount, getLowStockCountForViewer } from "@/lib/queries/inventory";
import { getDeliveryStats } from "@/lib/queries/delivery";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { zonedInstant, zonedParts } from "@/lib/time/zoned";
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
  // `customerScope`: the viewer's customer visibility (customerVisibilityWhere).
  opts: {
    auditScope?: Prisma.AuditEventWhereInput;
    viewer?: Parameters<typeof getLowStockCountForViewer>[0];
    customerScope?: Prisma.CustomerWhereInput;
  } = {}
) {
  // Calendar periods of the business time zone (src/lib/time/zoned.ts).
  const timeZone = await getBusinessTimeZone();
  const period =
    periodKey === "jour"
      ? currentDayRange(timeZone)
      : periodKey === "hier"
        ? yesterdayRange(timeZone)
        : periodKey === "trimestre"
          ? currentQuarterRange(timeZone)
          : periodKey === "annee"
            ? currentYearRange(timeZone)
            : currentMonthRange(timeZone);
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
    ordersPlaced,
  ] = await Promise.all([
    getFinanceSummary(period, source),
    getFinanceSummary(previousPeriod, source),
    opts.viewer ? getLowStockCountForViewer(opts.viewer) : getLowStockCount(),
    // Same period as every other dashboard figure (was all-time).
    getDeliveryStats(period.from, period.to),
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
    // « Nouveaux clients » — the one rule of /rapports/clients: a buyer of
    // the period whose FIRST-EVER order falls in it (never the date the
    // customer record was created or imported).
    countNewBuyers(period, source, opts.customerScope),
    // « Activité récente »: business / configuration / security activity only —
    // technical and routine events stay in the journal but never crowd the
    // dashboard (src/lib/audit-classification.ts).
    prisma.auditEvent.findMany({
      where: { AND: [opts.auditScope ?? {}, { action: { notIn: [...DASHBOARD_HIDDEN_AUDIT_ACTIONS] } }] },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { actorUser: { select: { name: true } } },
    }),
    // « Commandes » — every order placed in the period, any status (the same
    // count as /analyses and /rapports/ventes); the revenue-order count stays
    // in finance.ordersCount for the average basket.
    prisma.order.count({ where: { placedAt: { gte: period.from, lte: period.to }, ...(source ? { source } : {}) } }),
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
    ordersPlaced,
  };
}

/** Buyers of the period (a revenue order in it) whose first-ever order is in the period. */
async function countNewBuyers(period: PeriodRange, source: RecordSource | undefined, customerScope: Prisma.CustomerWhereInput | undefined) {
  const scope: Prisma.OrderWhereInput = { ...(source ? { source } : {}), ...(customerScope ? { customer: customerScope } : {}) };
  const firstInPeriod = await prisma.order.groupBy({
    by: ["customerId"],
    where: scope,
    _min: { placedAt: true },
    having: { placedAt: { _min: { gte: period.from, lte: period.to } } },
  });
  if (firstInPeriod.length === 0) return 0;
  const buyers = await prisma.order.groupBy({
    by: ["customerId"],
    where: {
      ...scope,
      customerId: { in: firstInPeriod.map((f) => f.customerId) },
      placedAt: { gte: period.from, lte: period.to },
      status: { notIn: REVENUE_EXCLUDED_STATUSES },
    },
  });
  return buyers.length;
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
 * matching the dashboard's own source filter. Revenue is the net
 * « Chiffre d'affaires » (src/lib/metrics/formulas.ts): order totals of
 * realised orders (not `REVENUE_EXCLUDED_STATUSES`) minus their completed
 * refunds, by placedAt — the same figure as the headline above it.
 */
export async function getRevenueTrend(
  range: RevenueTrendRange = "annee",
  source?: RecordSource
): Promise<TrendBucket[]> {
  const now = new Date();
  // Months of the business time zone (src/lib/time/zoned.ts).
  const timeZone = await getBusinessTimeZone();
  const thisYear = zonedParts(now, timeZone).year;
  const year = range === "annee-derniere" ? thisYear - 1 : thisYear;
  const from = zonedInstant(timeZone, year, 1, 1);
  const to = range === "annee-derniere" ? new Date(zonedInstant(timeZone, year + 1, 1, 1).getTime() - 1) : now;

  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: from, lte: to },
      status: { notIn: REVENUE_EXCLUDED_STATUSES },
      ...(source ? { source } : {}),
    },
    select: { placedAt: true, total: true, refunds: { where: { status: "COMPLETE" }, select: { amount: true } } },
  });

  const buckets: TrendBucket[] = [];
  for (let month = 0; month < 12; month++) {
    if (zonedInstant(timeZone, year, month + 1, 1) > to) break;
    buckets.push({
      key: `${year}-${month}`,
      // Mid-month UTC noon: the month's name whatever the zone.
      label: new Date(Date.UTC(year, month, 15, 12)).toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" }).replace(".", ""),
      revenue: 0,
    });
  }

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const o of orders) {
    const placed = zonedParts(o.placedAt, timeZone);
    const key = `${placed.year}-${placed.month - 1}`;
    const bucket = byKey.get(key);
    // Net, like the headline « Chiffre d'affaires » it sits under.
    if (bucket) bucket.revenue += Number(o.total) - o.refunds.reduce((n, r) => n + Number(r.amount), 0);
  }
  return buckets;
}
