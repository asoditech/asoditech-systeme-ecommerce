import "server-only";

import { prisma } from "@/lib/prisma";
import { displayOrderChannel } from "@/lib/format";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";
import { deltaPct } from "@/lib/reports/range";
import type { OrderStatus, OrderPaymentStatus } from "@prisma/client";
import { bucketKey, bucketKeys } from "@/lib/analytics/period";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { asPct, averageBasket, confirmationRatePct, countOutcomes, deliveryOutcomeRate, netRevenue, orderDeliveryOutcome } from "@/lib/metrics/formulas";

/**
 * Sales report — the headline "how did we sell this period" view.
 *
 * Every KPI uses the ONE definition of its label (src/lib/metrics/
 * formulas.ts — the same as the dashboard, Finance and /analyses):
 * « Chiffre d'affaires » = totals of the orders PLACED in the window that
 * are not cancelled/failed/returned/refunded, minus the COMPLETE refunds on
 * them; « Taux de confirmation » = confirmed ÷ went through confirmation;
 * « Taux de livraison » / « Taux de retour » = final delivery outcomes of
 * the window's shipped orders. « Commandes » counts every order placed. A
 * comparison period of the same length is always computed so every KPI can
 * show its delta.
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

export interface SalesSeriesPoint {
  /** ISO key: `YYYY-MM-DD` for day granularity, `YYYY-MM` for month. */
  key: string;
  /** Human label already formatted for display ("15 janv." / "janv. 2026"). */
  label: string;
  revenue: number;
  orders: number;
}

export interface SalesReport {
  current: SalesKpi;
  previous: SalesKpi;
  deltas: { [K in keyof SalesKpi]: number | null };
  /** Daily for windows ≤ 62 days, monthly beyond — so "Cette année" is 12
   * rows, not 365. */
  granularity: "day" | "month";
  series: SalesSeriesPoint[];
  byStatus: { status: OrderStatus; count: number; revenue: number }[];
  byChannel: { channel: string; count: number; revenue: number }[];
  byPayment: { paymentStatus: OrderPaymentStatus; count: number; amount: number }[];
}

const MONTH_LABELS = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
];

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
      confirmedAt: true,
      shippedAt: true,
      items: { select: { quantity: true } },
      refunds: { where: { status: "COMPLETE" }, select: { amount: true } },
      shipments: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, externalId: true, provider: { select: { type: true } } },
      },
      _count: { select: { confirmationAttempts: true } },
    },
  });
}

/** The order's net contribution to « Chiffre d'affaires » (0 when it isn't a revenue order). */
function netContribution(o: { status: OrderStatus; total: unknown; refunds: { amount: unknown }[] }): number {
  if (!isRevenue(o.status)) return 0;
  return Number(o.total) - o.refunds.reduce((n, r) => n + Number(r.amount), 0);
}

function isRevenue(status: OrderStatus): boolean {
  return !REVENUE_EXCLUDED_STATUSES.includes(status);
}

function kpiFrom(orders: OrderRow[]): SalesKpi {
  const revenueOrders = orders.filter((o) => isRevenue(o.status));
  const gross = revenueOrders.reduce((s, o) => s + Number(o.total), 0);
  const unitsSold = revenueOrders.reduce((s, o) => s + o.items.reduce((n, i) => n + i.quantity, 0), 0);
  const confirmed = orders.filter((o) => o.confirmedAt !== null).length;
  const wentThrough = orders.filter((o) => o.confirmedAt !== null || o._count.confirmationAttempts > 0).length;
  const outcomes = countOutcomes(
    orders
      .filter((o) => o.shippedAt !== null || ["EXPEDIEE", "LIVREE", "ECHEC", "RETOUR", "REMBOURSEE"].includes(o.status))
      .map((o) => {
        const current = o.shipments.find((x) => !(x.status === "ECHEC" && x.externalId === null && x.provider.type === "API"));
        return orderDeliveryOutcome(o.status, current?.status ?? null);
      })
  );
  const finished = outcomes.delivered + outcomes.failed + outcomes.returned;
  return {
    ordersCount: orders.length,
    revenue: netRevenue(gross, revenueOrders.reduce((s, o) => s + o.refunds.reduce((n, r) => n + Number(r.amount), 0), 0)),
    avgOrderValue: averageBasket(gross, revenueOrders.length),
    unitsSold,
    confirmationRate: confirmationRatePct(confirmed, wentThrough),
    deliveryRate: asPct(deliveryOutcomeRate(outcomes)),
    returnRate: finished > 0 ? round1((outcomes.returned / finished) * 100) : null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function getSalesReport(range: PeriodRange, previous: PeriodRange): Promise<SalesReport> {
  const [orders, prevOrders] = await Promise.all([fetchOrders(range), fetchOrders(previous)]);

  const current = kpiFrom(orders);
  const prev = kpiFrom(prevOrders);

  const spanDays = Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000);
  const granularity: "day" | "month" = spanDays > 62 ? "month" : "day";

  // Days / months of the business time zone — the same buckets as /analyses.
  const timeZone = await getBusinessTimeZone();
  const keyOf = (d: Date) => bucketKey(d, granularity, timeZone);
  const labelOf = (key: string) => {
    if (granularity === "month") {
      const [y, m] = key.split("-");
      return `${MONTH_LABELS[Number(m) - 1]} ${y}`;
    }
    const [, m, day] = key.split("-");
    return `${Number(day)} ${MONTH_LABELS[Number(m) - 1]}`;
  };

  const buckets = new Map<string, { revenue: number; orders: number }>();
  for (const key of bucketKeys(range, granularity, timeZone)) buckets.set(key, { revenue: 0, orders: 0 });
  for (const o of orders) {
    const b = buckets.get(keyOf(o.placedAt)) ?? { revenue: 0, orders: 0 };
    b.orders += 1;
    b.revenue += netContribution(o);
    buckets.set(keyOf(o.placedAt), b);
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
    b.revenue += netContribution(o);
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
    granularity,
    series: [...buckets.entries()].map(([key, v]) => ({
      key,
      label: labelOf(key),
      revenue: round2(v.revenue),
      orders: v.orders,
    })),
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
