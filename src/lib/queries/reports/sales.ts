import "server-only";

import { prisma } from "@/lib/prisma";
import { displayOrderChannel } from "@/lib/format";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";
import { deltaPct } from "@/lib/reports/range";
import type { OrderStatus, OrderPaymentStatus } from "@prisma/client";

/**
 * Sales report — the headline "how did we sell this period" view.
 *
 * Revenue counts every order PLACED in the window whose status is not
 * cancelled/failed/returned/refunded (the same exclusion set Finance and
 * Analytics use — `REVENUE_EXCLUDED_STATUSES` — so the three surfaces
 * agree). `confirmationRate` / `deliveryRate` are computed over ALL
 * orders placed in the window (excluded ones included in the denominator)
 * because "how many of everything we took actually converted" is the
 * operational question. A comparison period of the same length is always
 * computed so every KPI can show its delta.
 */

export interface SalesKpi {
  ordersCount: number;
  revenue: number;
  avgOrderValue: number | null;
  unitsSold: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
  returnRate: number | null;
}

export interface SalesReport {
  current: SalesKpi;
  previous: SalesKpi;
  deltas: { [K in keyof SalesKpi]: number | null };
  daily: { date: string; revenue: number; orders: number }[];
  byStatus: { status: OrderStatus; count: number; revenue: number }[];
  byChannel: { channel: string; count: number; revenue: number }[];
  byPayment: { paymentStatus: OrderPaymentStatus; count: number; amount: number }[];
}

type OrderRow = Awaited<ReturnType<typeof fetchOrders>>[number];

function fetchOrders(range: PeriodRange) {
  return prisma.order.findMany({
    where: { placedAt: { gte: range.from, lte: range.to } },
    select: {
      status: true,
      paymentStatus: true,
      total: true,
      placedAt: true,
      source: true,
      channel: true,
      items: { select: { quantity: true } },
    },
  });
}

function isRevenue(status: OrderStatus): boolean {
  return !REVENUE_EXCLUDED_STATUSES.includes(status);
}

function kpiFrom(orders: OrderRow[]): SalesKpi {
  const revenueOrders = orders.filter((o) => isRevenue(o.status));
  const revenue = revenueOrders.reduce((s, o) => s + Number(o.total), 0);
  const unitsSold = revenueOrders.reduce((s, o) => s + o.items.reduce((n, i) => n + i.quantity, 0), 0);
  const confirmed = orders.filter((o) =>
    ["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE", "LIVREE"].includes(o.status)
  ).length;
  const delivered = orders.filter((o) => o.status === "LIVREE").length;
  const returned = orders.filter((o) => ["RETOUR", "REMBOURSEE"].includes(o.status)).length;
  return {
    ordersCount: orders.length,
    revenue: round2(revenue),
    avgOrderValue: revenueOrders.length > 0 ? round2(revenue / revenueOrders.length) : null,
    unitsSold,
    confirmationRate: orders.length > 0 ? round1((confirmed / orders.length) * 100) : null,
    deliveryRate: orders.length > 0 ? round1((delivered / orders.length) * 100) : null,
    returnRate: orders.length > 0 ? round1((returned / orders.length) * 100) : null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function getSalesReport(range: PeriodRange, previous: PeriodRange): Promise<SalesReport> {
  const [orders, prevOrders] = await Promise.all([fetchOrders(range), fetchOrders(previous)]);

  const current = kpiFrom(orders);
  const prev = kpiFrom(prevOrders);

  const dayKeys = new Map<string, { revenue: number; orders: number }>();
  const cursor = new Date(range.from);
  while (cursor <= range.to) {
    dayKeys.set(cursor.toLocaleDateString("en-CA"), { revenue: 0, orders: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const o of orders) {
    const key = o.placedAt.toLocaleDateString("en-CA");
    const bucket = dayKeys.get(key) ?? { revenue: 0, orders: 0 };
    bucket.orders += 1;
    if (isRevenue(o.status)) bucket.revenue += Number(o.total);
    dayKeys.set(key, bucket);
  }

  const byStatusMap = new Map<OrderStatus, { count: number; revenue: number }>();
  for (const o of orders) {
    const b = byStatusMap.get(o.status) ?? { count: 0, revenue: 0 };
    b.count += 1;
    b.revenue += Number(o.total);
    byStatusMap.set(o.status, b);
  }

  const byChannelMap = new Map<string, { count: number; revenue: number }>();
  for (const o of orders) {
    const label = displayOrderChannel({ source: o.source, channel: o.channel });
    const b = byChannelMap.get(label) ?? { count: 0, revenue: 0 };
    b.count += 1;
    if (isRevenue(o.status)) b.revenue += Number(o.total);
    byChannelMap.set(label, b);
  }

  const byPaymentMap = new Map<OrderPaymentStatus, { count: number; amount: number }>();
  for (const o of orders) {
    const b = byPaymentMap.get(o.paymentStatus) ?? { count: 0, amount: 0 };
    b.count += 1;
    b.amount += Number(o.total);
    byPaymentMap.set(o.paymentStatus, b);
  }

  return {
    current,
    previous: prev,
    deltas: {
      ordersCount: deltaPct(current.ordersCount, prev.ordersCount),
      revenue: deltaPct(current.revenue, prev.revenue),
      avgOrderValue: deltaPct(current.avgOrderValue, prev.avgOrderValue),
      unitsSold: deltaPct(current.unitsSold, prev.unitsSold),
      confirmationRate: deltaPct(current.confirmationRate, prev.confirmationRate),
      deliveryRate: deltaPct(current.deliveryRate, prev.deliveryRate),
      returnRate: deltaPct(current.returnRate, prev.returnRate),
    },
    daily: [...dayKeys.entries()].map(([date, v]) => ({ date, revenue: round2(v.revenue), orders: v.orders })),
    byStatus: [...byStatusMap.entries()]
      .map(([status, v]) => ({ status, count: v.count, revenue: round2(v.revenue) }))
      .sort((a, b) => b.count - a.count),
    byChannel: [...byChannelMap.entries()]
      .map(([channel, v]) => ({ channel, count: v.count, revenue: round2(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue),
    byPayment: [...byPaymentMap.entries()]
      .map(([paymentStatus, v]) => ({ paymentStatus, count: v.count, amount: round2(v.amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
}
