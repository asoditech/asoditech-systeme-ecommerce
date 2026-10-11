import "server-only";

import type { OrderConfirmationOutcome, OrderStatus, Prisma, ShipmentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";
import { bucketKey, bucketKeys, bucketLabel, type AnalyticsPeriod } from "@/lib/analytics/period";
import { orderFilterWhere, sourceKeyOf, sourceLabel, type AnalyticsFilters, type SourceKey } from "@/lib/analytics/filters";
import {
  asPct,
  averageBasket,
  confirmationRatePct,
  countOutcomes,
  deliveryOutcomeRate,
  netRevenue,
  orderDeliveryOutcome,
  type OutcomeCounts,
} from "@/lib/metrics/formulas";

/**
 * Online order analytics — docs/adr/0051 and docs/analytics/metric-definitions.md.
 *
 * Callers must already hold `AnalyticsAccess.online` (an ONLINE channel —
 * docs/adr/0039: the Online business is scoped by channel kind, and Online
 * orders have no location model, ADR 0050). Tenant isolation is the
 * tenant-scoped `prisma` client + RLS. Offline POS sales are NEVER read here.
 *
 * Every figure names its own population and date field; nothing is derived
 * from `updatedAt`, and a missing timestamp is excluded from a duration —
 * never guessed. Aggregation happens in SQL (count / groupBy / aggregate)
 * wherever Prisma allows; rows are fetched only for per-day buckets and
 * durations, with the minimum columns.
 */

/** Statuses that can only be reached through confirmation (ECHEC/RETOUR/REMBOURSEE come after EXPEDIEE). */
export const CONFIRMED_REACHED: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE", "LIVREE", "ECHEC", "RETOUR", "REMBOURSEE"];
/** Statuses that can only be reached after shipping. */
export const SHIPPED_REACHED: OrderStatus[] = ["EXPEDIEE", "LIVREE", "ECHEC", "RETOUR", "REMBOURSEE"];
export const RETURNED_STATUSES: OrderStatus[] = ["RETOUR", "REMBOURSEE"];
const ALL_STATUSES: OrderStatus[] = ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "EXPEDIEE", "LIVREE", "ANNULEE", "RETOUR", "REMBOURSEE", "ECHEC"];

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : null);
const num = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()));

export interface Duration {
  /** Mean, in hours. Null when no order carries both timestamps. */
  avgHours: number | null;
  medianHours: number | null;
  /** How many orders the figure is computed over. */
  sample: number;
}

export function durationOf(valuesMs: number[]): Duration {
  const v = valuesMs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return { avgHours: null, medianHours: null, sample: 0 };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { avgHours: round1(v.reduce((s, x) => s + x, 0) / v.length / HOUR), medianHours: round1(median / HOUR), sample: v.length };
}

/** Orders PLACED in the range (the cohort every "commandes" figure uses). */
export function placedCohortWhere(range: PeriodRange, filters: AnalyticsFilters): Prisma.OrderWhereInput {
  return { AND: [{ placedAt: { gte: range.from, lte: range.to } }, orderFilterWhere(filters)] };
}

/** Confirmed = the order's confirmation stands (src/lib/metrics/formulas.ts — confirmationRatePct). */
const confirmedWhere: Prisma.OrderWhereInput = { confirmedAt: { not: null } };
/** Went through confirmation: at least one attempt recorded, or confirmed (e.g. on import). */
const wentThroughConfirmationWhere: Prisma.OrderWhereInput = { OR: [{ confirmedAt: { not: null } }, { confirmationAttempts: { some: {} } }] };
const shippedWhere: Prisma.OrderWhereInput = { OR: [{ status: { in: SHIPPED_REACHED } }, { shippedAt: { not: null } }] };

/** The order's shipments, newest first, for its CURRENT one (failed API creation attempts are never parcels). */
const shipmentsForOutcome = {
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  select: { status: true, externalId: true, provider: { select: { type: true } } },
} satisfies Prisma.Order$shipmentsArgs;

export function currentShipmentStatus(
  shipments: { status: ShipmentStatus; externalId: string | null; provider: { type: string } }[]
): ShipmentStatus | null {
  return shipments.find((x) => !(x.status === "ECHEC" && x.externalId === null && x.provider.type === "API"))?.status ?? null;
}

// ---------------------------------------------------------------------------
// Overview — operational + commercial KPIs over the placed cohort
// ---------------------------------------------------------------------------

export interface OnlineOverview {
  orders: number;
  pending: number;
  confirmed: number;
  /** Orders that went through confirmation (the rate's denominator). */
  wentThroughConfirmation: number;
  confirmationRate: number | null;
  shipped: number;
  delivered: number;
  deliveryRate: number | null;
  cancelled: number;
  failed: number;
  returned: number;
  /** Gross — total of placed orders not cancelled/failed/returned/refunded. */
  placedRevenue: number;
  /** « Chiffre d'affaires » — placedRevenue − COMPLETE refunds on those orders (same as Finance / dashboard). */
  netRevenue: number;
  revenueOrders: number;
  averageOrderValue: number | null;
  unitsSold: number;
  /** « CA livré » — total of the cohort's orders currently LIVREE. */
  deliveredRevenue: number;
  /** Total of the cohort's orders currently RETOUR / REMBOURSEE. */
  returnedValue: number;
  /** COMPLETE refunds recorded on the cohort's orders (finance's attribution rule). */
  refundedAmount: number;
}

export async function getOnlineOverview(range: PeriodRange, filters: AnalyticsFilters): Promise<OnlineOverview> {
  const cohort = placedCohortWhere(range, filters);
  const revenueCohort: Prisma.OrderWhereInput = { AND: [cohort, { status: { notIn: REVENUE_EXCLUDED_STATUSES } }] };
  const [byStatus, confirmed, wentThrough, shipped, units, refunds, revenueRefunds, outcomeRows] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: cohort, _count: true, _sum: { total: true } }),
    prisma.order.count({ where: { AND: [cohort, confirmedWhere] } }),
    prisma.order.count({ where: { AND: [cohort, wentThroughConfirmationWhere] } }),
    prisma.order.count({ where: { AND: [cohort, shippedWhere] } }),
    prisma.orderItem.aggregate({ where: { order: revenueCohort }, _sum: { quantity: true } }),
    prisma.refund.aggregate({ where: { status: "COMPLETE", order: cohort }, _sum: { amount: true } }),
    prisma.refund.aggregate({ where: { status: "COMPLETE", order: revenueCohort }, _sum: { amount: true } }),
    prisma.order.findMany({ where: { AND: [cohort, shippedWhere] }, select: { status: true, shipments: shipmentsForOutcome } }),
  ]);
  const outcomes = countOutcomes(outcomeRows.map((o) => orderDeliveryOutcome(o.status, currentShipmentStatus(o.shipments))));
  const count = (s: OrderStatus[]) => byStatus.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count, 0);
  const sum = (s: OrderStatus[]) => round2(byStatus.filter((g) => s.includes(g.status)).reduce((n, g) => n + num(g._sum.total), 0));
  const orders = byStatus.reduce((n, g) => n + g._count, 0);
  const revenueStatuses = ALL_STATUSES.filter((s) => !REVENUE_EXCLUDED_STATUSES.includes(s));
  const placedRevenue = sum(revenueStatuses);
  const revenueOrders = count(revenueStatuses);
  return {
    orders,
    pending: count(["NOUVELLE"]),
    confirmed,
    wentThroughConfirmation: wentThrough,
    confirmationRate: confirmationRatePct(confirmed, wentThrough),
    shipped,
    // Final outcome per order (its current parcel) — src/lib/metrics/formulas.ts.
    delivered: outcomes.delivered,
    deliveryRate: asPct(deliveryOutcomeRate(outcomes)),
    cancelled: count(["ANNULEE"]),
    failed: outcomes.failed,
    returned: outcomes.returned,
    placedRevenue,
    netRevenue: netRevenue(placedRevenue, num(revenueRefunds._sum.amount)),
    revenueOrders,
    averageOrderValue: averageBasket(placedRevenue, revenueOrders),
    unitsSold: units._sum.quantity ?? 0,
    deliveredRevenue: sum(["LIVREE"]),
    returnedValue: sum(RETURNED_STATUSES),
    refundedAmount: round2(num(refunds._sum.amount)),
  };
}

export interface RevenuePoint {
  key: string;
  label: string;
  /** « Chiffre d'affaires » (net of completed refunds) of orders placed that day/month. */
  revenue: number;
  /** Orders placed that day/month (all statuses). */
  orders: number;
  /** « CA livré » — of those orders, the ones currently LIVREE. */
  deliveredRevenue: number;
}

export async function getOnlineRevenueSeries(period: AnalyticsPeriod, filters: AnalyticsFilters): Promise<RevenuePoint[]> {
  const rows = await prisma.order.findMany({
    where: placedCohortWhere(period.range, filters),
    select: { placedAt: true, status: true, total: true, refunds: { where: { status: "COMPLETE" }, select: { amount: true } } },
  });
  const buckets = new Map(bucketKeys(period.range, period.granularity, period.timeZone).map((k) => [k, { revenue: 0, orders: 0, deliveredRevenue: 0 }]));
  for (const o of rows) {
    const b = buckets.get(bucketKey(o.placedAt, period.granularity, period.timeZone));
    if (!b) continue;
    b.orders += 1;
    // Net, like the headline figure: completed refunds come off the order's own day.
    if (!REVENUE_EXCLUDED_STATUSES.includes(o.status)) b.revenue += num(o.total) - o.refunds.reduce((n, r) => n + num(r.amount), 0);
    if (o.status === "LIVREE") b.deliveredRevenue += num(o.total);
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key,
    label: bucketLabel(key, period.granularity),
    revenue: round2(b.revenue),
    orders: b.orders,
    deliveredRevenue: round2(b.deliveredRevenue),
  }));
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmerRow {
  /** The user who recorded the attempts (`OrderConfirmationAttempt.agentUserId`) — never the order creator or the commission agent. */
  userId: string | null;
  name: string;
  active: boolean;
  attempts: number;
  confirmations: number;
  cancellations: number;
  /** Mean placed → confirmation time over THIS user's CONFIRME attempts in the period. */
  avgConfirmationHours: number | null;
  sample: number;
}

export interface ConfirmationAnalytics {
  entered: number;
  confirmed: number;
  /** Orders of the cohort that went through confirmation (the rate's denominator). */
  wentThroughConfirmation: number;
  pending: number;
  cancelledBeforeConfirmation: number;
  confirmationRate: number | null;
  attempts: number;
  attemptsPerConfirmedOrder: number | null;
  outcomes: { outcome: OrderConfirmationOutcome; count: number }[];
  /** placed → confirmedAt, over orders CONFIRMED in the period. */
  confirmationTime: Duration;
  /** Orders confirmed in the period with no CONFIRME attempt on record (imported / pre-ADR-0045 history) — not attributed to anyone. */
  confirmedWithoutConfirmer: number;
  byConfirmer: ConfirmerRow[];
  bySource: { key: SourceKey; label: string; entered: number; confirmed: number; rate: number | null }[];
  series: { key: string; label: string; entered: number; confirmed: number; attempts: number }[];
}

export async function getConfirmationAnalytics(period: AnalyticsPeriod, filters: AnalyticsFilters): Promise<ConfirmationAnalytics> {
  const { range } = period;
  const cohort = placedCohortWhere(range, filters);
  const orderFilter = orderFilterWhere(filters);
  const attemptWhere: Prisma.OrderConfirmationAttemptWhereInput = {
    createdAt: { gte: range.from, lte: range.to },
    order: orderFilter,
    ...(filters.confirmerId ? { agentUserId: filters.confirmerId } : {}),
  };
  const confirmedInRange: Prisma.OrderWhereInput = { AND: [{ confirmedAt: { gte: range.from, lte: range.to } }, orderFilter] };

  const [cohortRows, attemptGroups, confirmAttempts, attemptDays, confirmedOrders, withoutConfirmer] = await Promise.all([
    prisma.order.findMany({
      where: cohort,
      select: { placedAt: true, status: true, confirmedAt: true, source: true, channel: true, _count: { select: { confirmationAttempts: true } } },
    }),
    prisma.orderConfirmationAttempt.groupBy({ by: ["agentUserId", "outcome"], where: attemptWhere, _count: true }),
    prisma.orderConfirmationAttempt.findMany({
      where: { ...attemptWhere, outcome: "CONFIRME" },
      select: { agentUserId: true, createdAt: true, order: { select: { placedAt: true } } },
    }),
    prisma.orderConfirmationAttempt.findMany({ where: attemptWhere, select: { createdAt: true } }),
    prisma.order.findMany({
      where: filters.confirmerId
        ? { AND: [confirmedInRange, { confirmationAttempts: { some: { outcome: "CONFIRME", agentUserId: filters.confirmerId } } }] }
        : confirmedInRange,
      select: { placedAt: true, confirmedAt: true },
    }),
    filters.confirmerId ? Promise.resolve(0) : prisma.order.count({ where: { AND: [confirmedInRange, { confirmationAttempts: { none: { outcome: "CONFIRME" } } }] } }),
  ]);

  // src/lib/metrics/formulas.ts — confirmationRatePct: confirmed (confirmedAt
  // set) ÷ went through confirmation (an attempt recorded, or confirmed).
  const isConfirmed = (o: { confirmedAt: Date | null }) => o.confirmedAt !== null;
  const wentThrough = (o: { confirmedAt: Date | null; _count: { confirmationAttempts: number } }) =>
    o.confirmedAt !== null || o._count.confirmationAttempts > 0;
  const entered = cohortRows.length;
  const confirmed = cohortRows.filter(isConfirmed).length;
  const wentThroughConfirmation = cohortRows.filter(wentThrough).length;

  // Per confirmer — attempts by outcome, plus their own confirmation times.
  const userIds = [...new Set(attemptGroups.map((g) => g.agentUserId).filter((x): x is string => x !== null))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, status: true } }) : [];
  const rows = new Map<string, ConfirmerRow & { times: number[] }>();
  const rowFor = (userId: string | null) => {
    const k = userId ?? "∅";
    let r = rows.get(k);
    if (!r) {
      const u = users.find((x) => x.id === userId);
      r = { userId, name: u?.name ?? "Utilisateur supprimé", active: u?.status === "ACTIVE", attempts: 0, confirmations: 0, cancellations: 0, avgConfirmationHours: null, sample: 0, times: [] };
      rows.set(k, r);
    }
    return r;
  };
  const outcomes = new Map<OrderConfirmationOutcome, number>();
  let attempts = 0;
  for (const g of attemptGroups) {
    const r = rowFor(g.agentUserId);
    r.attempts += g._count;
    if (g.outcome === "CONFIRME") r.confirmations += g._count;
    if (g.outcome === "ANNULE") r.cancellations += g._count;
    outcomes.set(g.outcome, (outcomes.get(g.outcome) ?? 0) + g._count);
    attempts += g._count;
  }
  for (const a of confirmAttempts) rowFor(a.agentUserId).times.push(a.createdAt.getTime() - a.order.placedAt.getTime());
  const byConfirmer = [...rows.values()].map(({ times, ...r }) => {
    const d = durationOf(times);
    return { ...r, avgConfirmationHours: d.avgHours, sample: d.sample };
  });

  // By origin — same cohort, same "reached confirmation" rule.
  const src = new Map<SourceKey, { entered: number; confirmed: number; wentThrough: number }>();
  for (const o of cohortRows) {
    const k = sourceKeyOf(o);
    const b = src.get(k) ?? { entered: 0, confirmed: 0, wentThrough: 0 };
    b.entered += 1;
    if (isConfirmed(o)) b.confirmed += 1;
    if (wentThrough(o)) b.wentThrough += 1;
    src.set(k, b);
  }

  // Per day/month: cohort entered/confirmed by placedAt; attempts by their own date.
  const buckets = new Map(bucketKeys(range, period.granularity, period.timeZone).map((k) => [k, { entered: 0, confirmed: 0, attempts: 0 }]));
  for (const o of cohortRows) {
    const b = buckets.get(bucketKey(o.placedAt, period.granularity, period.timeZone));
    if (!b) continue;
    b.entered += 1;
    if (isConfirmed(o)) b.confirmed += 1;
  }
  for (const a of attemptDays) {
    const b = buckets.get(bucketKey(a.createdAt, period.granularity, period.timeZone));
    if (b) b.attempts += 1;
  }

  return {
    entered,
    confirmed,
    pending: cohortRows.filter((o) => o.status === "NOUVELLE").length,
    cancelledBeforeConfirmation: cohortRows.filter((o) => o.status === "ANNULEE" && o.confirmedAt === null).length,
    wentThroughConfirmation,
    confirmationRate: confirmationRatePct(confirmed, wentThroughConfirmation),
    attempts,
    attemptsPerConfirmedOrder: confirmAttempts.length > 0 ? round1(attempts / confirmAttempts.length) : null,
    outcomes: [...outcomes.entries()].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count),
    confirmationTime: durationOf(confirmedOrders.map((o) => o.confirmedAt!.getTime() - o.placedAt.getTime())),
    confirmedWithoutConfirmer: withoutConfirmer,
    byConfirmer,
    bySource: [...src.entries()]
      .map(([key, b]) => ({ key, label: sourceLabel(key), entered: b.entered, confirmed: b.confirmed, rate: confirmationRatePct(b.confirmed, b.wentThrough) }))
      .sort((a, b) => b.entered - a.entered),
    series: [...buckets.entries()].map(([key, b]) => ({ key, label: bucketLabel(key, period.granularity), ...b })),
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryOutcome = "delivered" | "failed" | "returned" | "inProgress";

/** A shipped order's final outcome (src/lib/metrics/formulas.ts — orderDeliveryOutcome), « en cours » when none yet. */
export function deliveryOutcomeOf(status: OrderStatus, currentShipment: ShipmentStatus | null = null): DeliveryOutcome {
  return orderDeliveryOutcome(status, currentShipment) ?? "inProgress";
}

export interface DeliveryRow {
  key: string;
  label: string;
  shipped: number;
  delivered: number;
  failed: number;
  returned: number;
  inProgress: number;
  deliveryRate: number | null;
  failureRate: number | null;
  returnRate: number | null;
  shippedToDelivered: Duration;
}

export interface DeliveryAnalytics {
  overall: DeliveryRow;
  confirmedToShipped: Duration;
  shippedToDelivered: Duration;
  confirmedToDelivered: Duration;
  byProvider: DeliveryRow[];
  bySource: DeliveryRow[];
  series: { key: string; label: string; shipped: number; delivered: number; failed: number; returned: number }[];
}

type ShippedOrder = {
  status: OrderStatus;
  outcome: DeliveryOutcome;
  source: string;
  channel: string | null;
  confirmedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  provider: { id: string; name: string } | null;
};

function deliveryRow(key: string, label: string, rows: ShippedOrder[]): DeliveryRow {
  const c = { delivered: 0, failed: 0, returned: 0, inProgress: 0 };
  for (const o of rows) c[o.outcome] += 1;
  // Rates over orders WITH an outcome — the one « Taux de livraison réussie »
  // (src/lib/metrics/formulas.ts); « en cours » stays out of every rate.
  const finished = c.delivered + c.failed + c.returned;
  return {
    key,
    label,
    shipped: rows.length,
    ...c,
    deliveryRate: asPct(deliveryOutcomeRate(c)),
    failureRate: pct(c.failed, finished),
    returnRate: pct(c.returned, finished),
    shippedToDelivered: durationOf(
      rows.filter((o) => o.status === "LIVREE" && o.deliveredAt && o.shippedAt).map((o) => o.deliveredAt!.getTime() - o.shippedAt!.getTime())
    ),
  };
}

/**
 * Population: Online orders whose `shippedAt` is in the period (the shipping
 * event ASODITECH records — `EXPEDIEE`, or the carrier moving the parcel to
 * EN_TRANSIT). Outcome = orderDeliveryOutcome (a recorded Retour / Remboursée wins). Carrier = the provider of
 * the order's latest shipment, excluding API-creation failures that never
 * reached the carrier (same exclusion as the delivery report, ADR 0031).
 */
export async function getDeliveryAnalytics(period: AnalyticsPeriod, filters: AnalyticsFilters): Promise<DeliveryAnalytics> {
  const { range } = period;
  const raw = await prisma.order.findMany({
    where: { AND: [{ shippedAt: { gte: range.from, lte: range.to } }, orderFilterWhere(filters)] },
    select: {
      status: true,
      source: true,
      channel: true,
      confirmedAt: true,
      shippedAt: true,
      deliveredAt: true,
      shipments: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, externalId: true, provider: { select: { id: true, name: true, type: true } } },
      },
    },
  });
  let orders: ShippedOrder[] = raw.map((o) => {
    const s = o.shipments.find((x) => !(x.status === "ECHEC" && x.externalId === null && x.provider.type === "API"));
    return {
      status: o.status,
      outcome: deliveryOutcomeOf(o.status, s?.status ?? null),
      source: o.source,
      channel: o.channel,
      confirmedAt: o.confirmedAt,
      shippedAt: o.shippedAt,
      deliveredAt: o.deliveredAt,
      provider: s ? { id: s.provider.id, name: s.provider.name } : null,
    };
  });
  if (filters.providerId) orders = orders.filter((o) => o.provider?.id === filters.providerId);

  const group = (keyOf: (o: ShippedOrder) => { key: string; label: string }) => {
    const m = new Map<string, { label: string; rows: ShippedOrder[] }>();
    for (const o of orders) {
      const { key, label } = keyOf(o);
      (m.get(key) ?? m.set(key, { label, rows: [] }).get(key)!).rows.push(o);
    }
    return [...m.entries()].map(([key, v]) => deliveryRow(key, v.label, v.rows)).sort((a, b) => b.shipped - a.shipped);
  };

  const buckets = new Map(bucketKeys(range, period.granularity, period.timeZone).map((k) => [k, { shipped: 0, delivered: 0, failed: 0, returned: 0 }]));
  for (const o of orders) {
    const b = buckets.get(bucketKey(o.shippedAt!, period.granularity, period.timeZone));
    if (!b) continue;
    b.shipped += 1;
    if (o.outcome !== "inProgress") b[o.outcome] += 1;
  }

  const both = (a: keyof ShippedOrder, b: keyof ShippedOrder, only?: (o: ShippedOrder) => boolean) =>
    durationOf(
      orders
        .filter((o) => o[a] instanceof Date && o[b] instanceof Date && (!only || only(o)))
        .map((o) => (o[b] as Date).getTime() - (o[a] as Date).getTime())
    );
  const delivered = (o: ShippedOrder) => o.status === "LIVREE";

  return {
    overall: deliveryRow("all", "Toutes", orders),
    confirmedToShipped: both("confirmedAt", "shippedAt"),
    shippedToDelivered: both("shippedAt", "deliveredAt", delivered),
    confirmedToDelivered: both("confirmedAt", "deliveredAt", delivered),
    byProvider: group((o) => (o.provider ? { key: o.provider.id, label: o.provider.name } : { key: "none", label: "Sans transporteur" })),
    bySource: group((o) => {
      const k = sourceKeyOf(o);
      return { key: k, label: sourceLabel(k) };
    }),
    series: [...buckets.entries()].map(([key, b]) => ({ key, label: bucketLabel(key, period.granularity), ...b })),
  };
}

// ---------------------------------------------------------------------------
// Sources — Online funnel per origin (placed cohort)
// ---------------------------------------------------------------------------

export interface SourceFunnelRow {
  key: SourceKey;
  label: string;
  orders: number;
  confirmed: number;
  shipped: number;
  delivered: number;
  returned: number;
  cancelled: number;
  failed: number;
  revenue: number;
  confirmationRate: number | null;
  deliveryRate: number | null;
}

export async function getOnlineSourceFunnel(range: PeriodRange, filters: AnalyticsFilters): Promise<SourceFunnelRow[]> {
  const rows = await prisma.order.findMany({
    where: placedCohortWhere(range, filters),
    select: {
      source: true,
      channel: true,
      status: true,
      confirmedAt: true,
      shippedAt: true,
      total: true,
      _count: { select: { confirmationAttempts: true } },
      shipments: shipmentsForOutcome,
      refunds: { where: { status: "COMPLETE" }, select: { amount: true } },
    },
  });
  type Acc = Omit<SourceFunnelRow, "key" | "label" | "confirmationRate" | "deliveryRate"> & { wentThrough: number };
  const m = new Map<SourceKey, Acc>();
  for (const o of rows) {
    const k = sourceKeyOf(o);
    const b = m.get(k) ?? { orders: 0, confirmed: 0, wentThrough: 0, shipped: 0, delivered: 0, returned: 0, cancelled: 0, failed: 0, revenue: 0 };
    b.orders += 1;
    // Same definitions as the overview (src/lib/metrics/formulas.ts).
    if (o.confirmedAt) b.confirmed += 1;
    if (o.confirmedAt || o._count.confirmationAttempts > 0) b.wentThrough += 1;
    if (SHIPPED_REACHED.includes(o.status) || o.shippedAt) {
      b.shipped += 1;
      const outcome = orderDeliveryOutcome(o.status, currentShipmentStatus(o.shipments));
      if (outcome) b[outcome] += 1;
    }
    if (o.status === "ANNULEE") b.cancelled += 1;
    // Net « Chiffre d'affaires », as everywhere else.
    if (!REVENUE_EXCLUDED_STATUSES.includes(o.status)) b.revenue += num(o.total) - o.refunds.reduce((n, r) => n + num(r.amount), 0);
    m.set(k, b);
  }
  return [...m.entries()]
    .map(([key, { wentThrough, ...b }]) => ({
      key,
      label: sourceLabel(key),
      ...b,
      revenue: round2(b.revenue),
      confirmationRate: confirmationRatePct(b.confirmed, wentThrough),
      deliveryRate: asPct(deliveryOutcomeRate(b as OutcomeCounts)),
    }))
    .sort((a, b) => b.orders - a.orders);
}

/** Filter options — providers that exist in the tenant, confirmers who ever recorded an attempt. */
export async function getOnlineFilterOptions() {
  const [providers, confirmerIds, channels] = await Promise.all([
    prisma.shippingProvider.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.orderConfirmationAttempt.findMany({ distinct: ["agentUserId"], select: { agentUserId: true } }),
    prisma.salesChannel.findMany({ where: { kind: "ONLINE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const ids = confirmerIds.map((c) => c.agentUserId).filter((x): x is string => x !== null);
  const confirmers = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
  return { providers, confirmers, onlineChannels: channels };
}
