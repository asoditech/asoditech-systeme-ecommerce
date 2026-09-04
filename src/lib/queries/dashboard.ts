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

export async function getDashboardData(periodKey: DashboardPeriod = "mois") {
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
    getFinanceSummary(period),
    getFinanceSummary(previousPeriod),
    getLowStockCount(),
    getDeliveryStats(),
    prisma.order.findMany({
      where: { status: { in: ["NOUVELLE", "CONFIRMEE"] }, placedAt: { gte: actionCutoff } },
      orderBy: { placedAt: "asc" },
      take: 6,
      include: { customer: true },
    }),
    prisma.order.findMany({ orderBy: { placedAt: "desc" }, take: 6, include: { customer: true } }),
    prisma.customer.count({ where: { createdAt: { gte: period.from, lte: period.to } } }),
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
