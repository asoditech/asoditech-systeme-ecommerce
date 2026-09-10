import "server-only";

import { Prisma } from "@prisma/client";
import type { OrderStatus, RecordSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * The single source of truth for "how much did I really make" — used by
 * Finance, Analytics, the order detail and the product detail so those
 * four surfaces can never drift. See docs/adr/0007-finance-and-profit.md.
 *
 * All money math is done with `Prisma.Decimal` (never JS floats), rounded
 * to 2 decimals only at the boundary. COGS comes exclusively from
 * `OrderItem.costSnapshot` — the cost frozen at sale time — so editing
 * `Product.cost` later never rewrites historical profit. When a snapshot
 * is missing the figure is reported as incomplete rather than guessed.
 */

const D = (v: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v ?? 0);

/** Decimal → number rounded to cents, for JSON/display. */
const money = (d: Prisma.Decimal): number => Number(d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString());

/** profit / revenue × 100, one decimal — null when revenue is zero. */
function marginPct(profit: Prisma.Decimal, revenue: Prisma.Decimal): number | null {
  if (revenue.isZero()) return null;
  return Number(profit.div(revenue).mul(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString());
}

/**
 * Orders that contribute no revenue and no COGS: cancelled, failed, and —
 * the goods came back — returned or refunded. A partial refund on an order
 * that is still counted nets out through its `refunds` relation. Aligning
 * COGS with revenue this way is what prevents double-counting a return.
 */
export const REVENUE_EXCLUDED_STATUSES: OrderStatus[] = ["ANNULEE", "ECHEC", "RETOUR", "REMBOURSEE"];

export function isRevenueOrder(status: OrderStatus): boolean {
  return !REVENUE_EXCLUDED_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Per-order profit
// ---------------------------------------------------------------------------

export interface OrderProfit {
  counted: boolean;
  grossOrderTotal: number;
  refundsTotal: number;
  revenue: number;
  cogs: number | null;
  cogsComplete: boolean;
  itemsMissingCost: number;
  grossProfit: number | null;
  grossMarginPct: number | null;
  deliveryCost: number;
  profitAfterDelivery: number | null;
}

interface OrderProfitInput {
  status: OrderStatus;
  total: Prisma.Decimal | number | string;
  items: { costSnapshot: Prisma.Decimal | number | string | null; quantity: number }[];
  refunds?: { amount: Prisma.Decimal | number | string; status: string }[];
  shipments?: { cost: Prisma.Decimal | number | string | null; status?: string }[];
}

/**
 * A parcel that never completed a delivery service — the order was
 * cancelled before it reached the customer, or the shipment itself was
 * cancelled. No delivery deduction applies (client feedback #3). The
 * return- and failure-rule charges for RETOUR / ECHEC orders are a
 * separate concern, carried by their own `costSource` (RETURN_RULE /
 * FAILURE_RULE) and untouched by this rule — see docs/adr/0032.
 */
export function shipmentIncursDeliveryCost(
  orderStatus: OrderStatus | string | null | undefined,
  shipmentStatus?: string | null,
): boolean {
  return orderStatus !== "ANNULEE" && shipmentStatus !== "ANNULE";
}

export function computeOrderProfit(order: OrderProfitInput): OrderProfit {
  const counted = isRevenueOrder(order.status);
  const grossTotal = D(order.total);
  const refundsTotal = (order.refunds ?? [])
    .filter((r) => r.status === "COMPLETE")
    .reduce((s, r) => s.plus(D(r.amount)), D(0));
  const revenue = counted ? grossTotal.minus(refundsTotal) : D(0);

  let cogs = D(0);
  let cogsComplete = true;
  let itemsMissingCost = 0;
  for (const it of order.items) {
    if (it.costSnapshot === null || it.costSnapshot === undefined) {
      cogsComplete = false;
      itemsMissingCost++;
      continue;
    }
    cogs = cogs.plus(D(it.costSnapshot).mul(it.quantity));
  }

  const deliveryCost = (order.shipments ?? [])
    .filter((sh) => shipmentIncursDeliveryCost(order.status, sh.status))
    .reduce((s, sh) => s.plus(D(sh.cost)), D(0));
  const grossProfit: Prisma.Decimal | null = counted && cogsComplete ? revenue.minus(cogs) : null;

  return {
    counted,
    grossOrderTotal: money(grossTotal),
    refundsTotal: money(refundsTotal),
    revenue: money(revenue),
    cogs: counted && cogsComplete ? money(cogs) : null,
    cogsComplete: counted ? cogsComplete : true,
    itemsMissingCost,
    grossProfit: grossProfit === null ? null : money(grossProfit),
    grossMarginPct: grossProfit === null ? null : marginPct(grossProfit, revenue),
    deliveryCost: money(deliveryCost),
    profitAfterDelivery: grossProfit === null ? null : money(grossProfit.minus(deliveryCost)),
  };
}

// ---------------------------------------------------------------------------
// Per-period P&L
// ---------------------------------------------------------------------------

const ADVERTISING_CATEGORY_RE = /pub|publicit|marketing|\bads?\b/i;

export interface PeriodProfitability {
  ordersCount: number;
  grossRevenue: number;
  refundsTotal: number;
  revenue: number;
  cogs: number | null;
  cogsComplete: boolean;
  itemsMissingCost: number;
  grossProfit: number | null;
  grossMarginPct: number | null;
  expensesTotal: number;
  advertisingCost: number;
  otherExpensesTotal: number;
  deliveryCostTotal: number;
  /** `deliveryCostTotal` broken out by outcome (docs/adr/0032). Sum ==
   * `deliveryCostTotal`. */
  carrierDeliveryCost: number;
  returnCostTotal: number;
  failureCostTotal: number;
  costOverrideTotal: number;
  netProfit: number | null;
  netMarginPct: number | null;
  avgOrderValue: number | null;
  chargesTotal: number;
}

export async function computePeriodProfitability(
  period: PeriodRange,
  source?: RecordSource
): Promise<PeriodProfitability> {
  const orders = await prisma.order.findMany({
    where: {
      placedAt: { gte: period.from, lte: period.to },
      status: { notIn: REVENUE_EXCLUDED_STATUSES },
      ...(source ? { source } : {}),
    },
    include: {
      items: { select: { costSnapshot: true, quantity: true } },
      refunds: { where: { status: "COMPLETE" }, select: { amount: true } },
    },
  });

  let grossRevenue = D(0);
  let refundsTotal = D(0);
  let cogs = D(0);
  let cogsComplete = true;
  let itemCount = 0;
  let itemsMissingCost = 0;
  for (const order of orders) {
    grossRevenue = grossRevenue.plus(D(order.total));
    for (const r of order.refunds) refundsTotal = refundsTotal.plus(D(r.amount));
    for (const it of order.items) {
      itemCount++;
      if (it.costSnapshot === null) {
        cogsComplete = false;
        itemsMissingCost++;
        continue;
      }
      cogs = cogs.plus(D(it.costSnapshot).mul(it.quantity));
    }
  }
  if (itemCount === 0) cogsComplete = false;

  // Delivery cost broken down by where it came from (docs/adr/0032): a
  // successful delivery's carrier price, a return-rule charge, a
  // failure-rule charge, or a manual accounting correction. Reads the
  // recorded per-shipment cost — never today's provider settings.
  const deliveryBySource = await prisma.shipment.groupBy({
    by: ["costSource"],
    where: {
      createdAt: { gte: period.from, lte: period.to },
      cost: { not: null },
      // Client feedback #3: a cancelled order's parcel never reached the
      // customer, and a cancelled shipment completed no delivery service —
      // neither is a delivery deduction. Return / failure charges live on
      // their own `costSource` for RETOUR / ECHEC orders and are unaffected.
      status: { not: "ANNULE" },
      order: { status: { not: "ANNULEE" } },
    },
    _sum: { cost: true },
  });
  let carrierDeliveryCost = D(0);
  let returnCostTotal = D(0);
  let failureCostTotal = D(0);
  let overrideCostTotal = D(0);
  for (const g of deliveryBySource) {
    const amt = D(g._sum.cost);
    if (g.costSource === "RETURN_RULE") returnCostTotal = returnCostTotal.plus(amt);
    else if (g.costSource === "FAILURE_RULE") failureCostTotal = failureCostTotal.plus(amt);
    else if (g.costSource === "MANUAL_OVERRIDE") overrideCostTotal = overrideCostTotal.plus(amt);
    // CARRIER_API + null (in-flight carrier estimate / manual provider).
    else carrierDeliveryCost = carrierDeliveryCost.plus(amt);
  }
  const deliveryCost = carrierDeliveryCost
    .plus(returnCostTotal)
    .plus(failureCostTotal)
    .plus(overrideCostTotal);

  const expenses = await prisma.expense.findMany({
    where: { date: { gte: period.from, lte: period.to } },
    select: { amount: true, category: { select: { name: true } } },
  });
  let expensesTotal = D(0);
  let advertisingCost = D(0);
  for (const e of expenses) {
    const amt = D(e.amount);
    expensesTotal = expensesTotal.plus(amt);
    if (ADVERTISING_CATEGORY_RE.test(e.category.name)) advertisingCost = advertisingCost.plus(amt);
  }

  const revenue = grossRevenue.minus(refundsTotal);
  const grossProfit: Prisma.Decimal | null = cogsComplete ? revenue.minus(cogs) : null;
  const netProfit: Prisma.Decimal | null =
    grossProfit === null ? null : grossProfit.minus(expensesTotal).minus(deliveryCost);

  return {
    ordersCount: orders.length,
    grossRevenue: money(grossRevenue),
    refundsTotal: money(refundsTotal),
    revenue: money(revenue),
    cogs: cogsComplete ? money(cogs) : null,
    cogsComplete,
    itemsMissingCost,
    grossProfit: grossProfit === null ? null : money(grossProfit),
    grossMarginPct: grossProfit === null ? null : marginPct(grossProfit, revenue),
    expensesTotal: money(expensesTotal),
    advertisingCost: money(advertisingCost),
    otherExpensesTotal: money(expensesTotal.minus(advertisingCost)),
    deliveryCostTotal: money(deliveryCost),
    carrierDeliveryCost: money(carrierDeliveryCost),
    returnCostTotal: money(returnCostTotal),
    failureCostTotal: money(failureCostTotal),
    costOverrideTotal: money(overrideCostTotal),
    netProfit: netProfit === null ? null : money(netProfit),
    netMarginPct: netProfit === null ? null : marginPct(netProfit, revenue),
    avgOrderValue: orders.length > 0 ? money(grossRevenue.div(orders.length)) : null,
    chargesTotal: money(expensesTotal.plus(deliveryCost)),
  };
}

// ---------------------------------------------------------------------------
// Per-product profitability
// ---------------------------------------------------------------------------

export interface ProductProfitRow {
  productId: string | null;
  name: string;
  unitsSold: number;
  revenue: number;
  cogs: number | null;
  cogsComplete: boolean;
  grossProfit: number | null;
  marginPct: number | null;
}

export async function computeProductProfitability(
  period: PeriodRange,
  opts: { source?: RecordSource; limit?: number } = {}
): Promise<ProductProfitRow[]> {
  const lines = await prisma.orderItem.findMany({
    where: {
      order: {
        placedAt: { gte: period.from, lte: period.to },
        status: { notIn: REVENUE_EXCLUDED_STATUSES },
        ...(opts.source ? { source: opts.source } : {}),
      },
    },
    select: {
      productId: true,
      nameSnapshot: true,
      quantity: true,
      total: true,
      costSnapshot: true,
      product: { select: { name: true } },
    },
  });

  const groups = new Map<
    string,
    { productId: string | null; name: string; units: number; revenue: Prisma.Decimal; cogs: Prisma.Decimal; missing: number }
  >();
  for (const l of lines) {
    const key = l.productId ?? "__deleted__";
    const g =
      groups.get(key) ??
      { productId: l.productId, name: l.product?.name ?? l.nameSnapshot, units: 0, revenue: D(0), cogs: D(0), missing: 0 };
    g.units += l.quantity;
    g.revenue = g.revenue.plus(D(l.total));
    if (l.costSnapshot === null) g.missing++;
    else g.cogs = g.cogs.plus(D(l.costSnapshot).mul(l.quantity));
    groups.set(key, g);
  }

  const rows: ProductProfitRow[] = [...groups.values()].map((g) => {
    const complete = g.missing === 0;
    const grossProfit: Prisma.Decimal | null = complete ? g.revenue.minus(g.cogs) : null;
    return {
      productId: g.productId,
      name: g.name,
      unitsSold: g.units,
      revenue: money(g.revenue),
      cogs: complete ? money(g.cogs) : null,
      cogsComplete: complete,
      grossProfit: grossProfit === null ? null : money(grossProfit),
      marginPct: grossProfit === null ? null : marginPct(grossProfit, g.revenue),
    };
  });

  rows.sort(
    (a, b) => (b.grossProfit ?? Number.NEGATIVE_INFINITY) - (a.grossProfit ?? Number.NEGATIVE_INFINITY) || b.revenue - a.revenue
  );
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

/** Current-catalogue unit economics for one product/variation — the
 * forward-looking margin at today's price and cost (distinct from realised
 * profit on past sales, which uses costSnapshot). */
export function unitEconomics(price: Prisma.Decimal | number | string, cost: Prisma.Decimal | number | string | null) {
  const p = D(price);
  if (cost === null || cost === undefined) {
    return { unitCost: null, unitMargin: null, unitMarginPct: null };
  }
  const c = D(cost);
  const margin = p.minus(c);
  return { unitCost: money(c), unitMargin: money(margin), unitMarginPct: marginPct(margin, p) };
}
