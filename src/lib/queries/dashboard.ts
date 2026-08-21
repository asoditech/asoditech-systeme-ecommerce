import "server-only";

import { prisma } from "@/lib/prisma";
import { getFinanceSummary, currentMonthRange, previousPeriodOfSameLength } from "@/lib/queries/finance";
import { getLowStockCount } from "@/lib/queries/inventory";
import { getDeliveryStats } from "@/lib/queries/delivery";

export async function getDashboardData() {
  const period = currentMonthRange();
  const previousPeriod = previousPeriodOfSameLength(period);

  const [
    finance,
    previousFinance,
    lowStockCount,
    deliveryStats,
    ordersRequiringAction,
    recentOrders,
    newCustomersThisMonth,
    recentAuditEvents,
    failedShipments,
  ] = await Promise.all([
    getFinanceSummary(period),
    getFinanceSummary(previousPeriod),
    getLowStockCount(),
    getDeliveryStats(),
    prisma.order.findMany({
      where: { status: { in: ["NOUVELLE", "CONFIRMEE"] } },
      orderBy: { createdAt: "asc" },
      take: 6,
      include: { customer: true },
    }),
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { customer: true } }),
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
    finance,
    previousFinance,
    lowStockCount,
    deliveryStats,
    ordersRequiringAction,
    recentOrders,
    newCustomersThisMonth,
    recentAuditEvents,
    failedShipments,
  };
}
