import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isRevenueOrder, shipmentIncursDeliveryCost } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * Profitability by product and by campaign/source — the report deferred in
 * docs/adr/0007-finance-and-profit.md ("the data exists … but the
 * aggregation queries aren't built"). Entirely read-only: it never writes
 * an Order/OrderItem/Shipment/CommissionEntry row, and it never reads
 * `Product.cost` — COGS comes exclusively from the frozen
 * `OrderItem.costSnapshot`, exactly like `product-profit.ts` and
 * `profitability.ts`'s `computeProductProfitability`.
 *
 * Revenue/COGS inclusion mirrors every other report: an order counts
 * towards revenue only when `isRevenueOrder(status)` — i.e. not
 * ANNULEE/ECHEC/RETOUR/REMBOURSEE (see `REVENUE_EXCLUDED_STATUSES`). Unlike
 * those reports, this one does NOT filter excluded orders out of the base
 * query, because delivery cost must still be attributed correctly for them:
 * `shipmentIncursDeliveryCost` (reused verbatim, not reimplemented) already
 * encodes that an ANNULEE order incurs zero delivery cost while a
 * RETOUR/ECHEC order preserves its configured return/failure-rule charge
 * even though it contributes no revenue. So a returned or failed order can
 * show up in a product's/campaign's "Frais de livraison" with zero
 * "CA"/"Coût produits" — a real cost with no matching sale, which is the
 * correct picture, not a bug.
 *
 * Loads only the OrderItems/Shipments inside the requested period (never
 * the whole order history) and aggregates in application code — the same
 * trade-off `getProductProfitReport` already makes, because the needed
 * figures (qty × costSnapshot, and a per-order delivery cost split
 * proportionally across that order's lines) aren't expressible as a plain
 * Prisma `groupBy` sum.
 */

const D = (v: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v ?? 0);
const money = (d: Prisma.Decimal) => Number(d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString());
const marginPct = (profit: Prisma.Decimal, revenue: Prisma.Decimal) =>
  revenue.isZero() ? null : Number(profit.div(revenue).mul(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString());

export const DELETED_PRODUCT_KEY = "__deleted__";
export const NO_CAMPAIGN_KEY = "__none__";

export interface ProductProfitabilityRow {
  productId: string | null;
  key: string;
  name: string;
  unitsSold: number;
  revenue: number;
  productCost: number | null;
  deliveryCost: number;
  profit: number | null;
  marginPct: number | null;
  dataComplete: boolean;
  linesMissingCost: number;
}

export interface CampaignProfitabilityRow {
  campaignId: string | null;
  key: string;
  name: string;
  ordersCount: number;
  revenue: number;
  productCost: number | null;
  deliveryCost: number;
  profit: number | null;
  marginPct: number | null;
  dataComplete: boolean;
  linesMissingCost: number;
}

export interface ProfitabilityTotals {
  revenue: number;
  productCost: number | null;
  deliveryCost: number;
  profit: number | null;
  marginPct: number | null;
  dataComplete: boolean;
  linesMissingCost: number;
  ordersMissingCost: number;
}

export interface ProfitabilityReport {
  totals: ProfitabilityTotals;
  byProduct: ProductProfitabilityRow[];
  byCampaign: CampaignProfitabilityRow[];
}

function fetchOrders(range: PeriodRange) {
  return prisma.order.findMany({
    where: { placedAt: { gte: range.from, lte: range.to } },
    select: {
      id: true,
      status: true,
      campaignId: true,
      campaign: { select: { name: true } },
      items: {
        select: {
          productId: true,
          nameSnapshot: true,
          quantity: true,
          total: true,
          costSnapshot: true,
          product: { select: { name: true } },
        },
      },
      shipments: { select: { cost: true, status: true } },
    },
  });
}

type OrderRow = Awaited<ReturnType<typeof fetchOrders>>[number];

/** Total delivery cost this order incurs, reusing the existing rule
 * verbatim — never a second implementation. */
function orderDeliveryCost(order: Pick<OrderRow, "status" | "shipments">): Prisma.Decimal {
  return order.shipments
    .filter((sh) => shipmentIncursDeliveryCost(order.status, sh.status))
    .reduce((s, sh) => s.plus(D(sh.cost)), D(0));
}

interface Acc {
  units: number;
  revenue: Prisma.Decimal;
  cost: Prisma.Decimal;
  delivery: Prisma.Decimal;
  missing: number;
  orderIds: Set<string>;
}
const newAcc = (): Acc => ({ units: 0, revenue: D(0), cost: D(0), delivery: D(0), missing: 0, orderIds: new Set() });

export async function getProfitabilityReport(range: PeriodRange): Promise<ProfitabilityReport> {
  const orders = await fetchOrders(range);

  const byProduct = new Map<string, Acc & { productId: string | null; name: string }>();
  const byCampaign = new Map<string, Acc & { campaignId: string | null; name: string }>();
  const ordersMissingCost = new Set<string>();

  for (const order of orders) {
    const counted = isRevenueOrder(order.status);
    const delivery = orderDeliveryCost(order);
    const lineTotalSum = order.items.reduce((s, l) => s.plus(D(l.total)), D(0));
    const itemCount = order.items.length;

    const campaignKey = order.campaignId ?? NO_CAMPAIGN_KEY;
    const campaignAcc =
      byCampaign.get(campaignKey) ??
      { ...newAcc(), campaignId: order.campaignId, name: order.campaign?.name ?? "Sans campagne" };
    campaignAcc.orderIds.add(order.id);
    campaignAcc.delivery = campaignAcc.delivery.plus(delivery);

    for (const l of order.items) {
      const share = lineTotalSum.isZero() ? (itemCount > 0 ? D(1).div(itemCount) : D(0)) : D(l.total).div(lineTotalSum);
      const lineDelivery = delivery.mul(share);

      const productKey = l.productId ?? DELETED_PRODUCT_KEY;
      const productAcc =
        byProduct.get(productKey) ??
        { ...newAcc(), productId: l.productId, name: l.product?.name ?? l.nameSnapshot };
      productAcc.orderIds.add(order.id);
      productAcc.delivery = productAcc.delivery.plus(lineDelivery);

      if (counted) {
        productAcc.units += l.quantity;
        productAcc.revenue = productAcc.revenue.plus(D(l.total));
        campaignAcc.revenue = campaignAcc.revenue.plus(D(l.total));
        if (l.costSnapshot === null) {
          productAcc.missing += 1;
          campaignAcc.missing += 1;
          ordersMissingCost.add(order.id);
        } else {
          const lineCost = D(l.costSnapshot).mul(l.quantity);
          productAcc.cost = productAcc.cost.plus(lineCost);
          campaignAcc.cost = campaignAcc.cost.plus(lineCost);
        }
      }

      byProduct.set(productKey, productAcc);
    }
    byCampaign.set(campaignKey, campaignAcc);
  }

  const toProductRow = (key: string, g: Acc & { productId: string | null; name: string }): ProductProfitabilityRow => {
    const complete = g.missing === 0;
    const profit = complete ? g.revenue.minus(g.cost).minus(g.delivery) : null;
    return {
      productId: g.productId,
      key,
      name: g.name,
      unitsSold: g.units,
      revenue: money(g.revenue),
      productCost: complete ? money(g.cost) : null,
      deliveryCost: money(g.delivery),
      profit: profit === null ? null : money(profit),
      marginPct: profit === null ? null : marginPct(profit, g.revenue),
      dataComplete: complete,
      linesMissingCost: g.missing,
    };
  };

  const toCampaignRow = (key: string, g: Acc & { campaignId: string | null; name: string }): CampaignProfitabilityRow => {
    const complete = g.missing === 0;
    const profit = complete ? g.revenue.minus(g.cost).minus(g.delivery) : null;
    return {
      campaignId: g.campaignId,
      key,
      name: g.name,
      ordersCount: g.orderIds.size,
      revenue: money(g.revenue),
      productCost: complete ? money(g.cost) : null,
      deliveryCost: money(g.delivery),
      profit: profit === null ? null : money(profit),
      marginPct: profit === null ? null : marginPct(profit, g.revenue),
      dataComplete: complete,
      linesMissingCost: g.missing,
    };
  };

  const byProductRows = [...byProduct.entries()]
    .map(([k, g]) => toProductRow(k, g))
    .sort((a, b) => (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY) || b.revenue - a.revenue);
  const byCampaignRows = [...byCampaign.entries()]
    .map(([k, g]) => toCampaignRow(k, g))
    .sort((a, b) => (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY) || b.revenue - a.revenue);

  let revenue = D(0);
  let cost = D(0);
  let delivery = D(0);
  let linesMissingCost = 0;
  for (const g of byProduct.values()) {
    revenue = revenue.plus(g.revenue);
    cost = cost.plus(g.cost);
    delivery = delivery.plus(g.delivery);
    linesMissingCost += g.missing;
  }
  const dataComplete = linesMissingCost === 0;
  const profit = dataComplete ? revenue.minus(cost).minus(delivery) : null;

  return {
    byProduct: byProductRows,
    byCampaign: byCampaignRows,
    totals: {
      revenue: money(revenue),
      productCost: dataComplete ? money(cost) : null,
      deliveryCost: money(delivery),
      profit: profit === null ? null : money(profit),
      marginPct: profit === null ? null : marginPct(profit, revenue),
      dataComplete,
      linesMissingCost,
      ordersMissingCost: ordersMissingCost.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Drill-down: contributing orders for one product or one campaign/source.
// ---------------------------------------------------------------------------

export interface ProfitabilityOrderRow {
  orderId: string;
  displayNumber: number;
  customerName: string;
  status: string;
  placedAt: Date;
  quantity: number | null;
  revenue: number;
  productCost: number | null;
  deliveryCost: number;
  profit: number | null;
}

export interface ProfitabilityOrdersPage {
  rows: ProfitabilityOrderRow[];
  total: number;
}

const ORDER_DETAIL_SELECT = {
  id: true,
  status: true,
  campaignId: true,
  campaign: { select: { name: true } },
  displayNumber: true,
  orderNumber: true,
  placedAt: true,
  customer: { select: { fullName: true } },
  items: {
    select: {
      productId: true,
      nameSnapshot: true,
      quantity: true,
      total: true,
      costSnapshot: true,
      product: { select: { name: true } },
    },
  },
  shipments: { select: { cost: true, status: true } },
} satisfies Prisma.OrderSelect;

type OrderDetailRow = Prisma.OrderGetPayload<{ select: typeof ORDER_DETAIL_SELECT }>;

function toOrderRow(order: OrderDetailRow, opts: { productId?: string | null }): ProfitabilityOrderRow {
  const counted = isRevenueOrder(order.status);
  const delivery = orderDeliveryCost(order);
  const lineTotalSum = order.items.reduce((s, l) => s.plus(D(l.total)), D(0));
  const itemCount = order.items.length;

  const relevant = "productId" in opts ? order.items.filter((l) => (l.productId ?? DELETED_PRODUCT_KEY) === (opts.productId ?? DELETED_PRODUCT_KEY)) : order.items;

  let revenue = D(0);
  let cost = D(0);
  let cogsComplete = true;
  let quantity = 0;
  let lineDelivery = D(0);
  for (const l of relevant) {
    quantity += l.quantity;
    const share = lineTotalSum.isZero() ? (itemCount > 0 ? D(1).div(itemCount) : D(0)) : D(l.total).div(lineTotalSum);
    lineDelivery = lineDelivery.plus(delivery.mul(share));
    if (counted) {
      revenue = revenue.plus(D(l.total));
      if (l.costSnapshot === null) cogsComplete = false;
      else cost = cost.plus(D(l.costSnapshot).mul(l.quantity));
    }
  }
  const profit = cogsComplete ? revenue.minus(cost).minus(lineDelivery) : null;

  return {
    orderId: order.id,
    displayNumber: order.displayNumber ?? order.orderNumber,
    customerName: order.customer.fullName,
    status: order.status,
    placedAt: order.placedAt,
    quantity: "productId" in opts ? quantity : null,
    revenue: money(revenue),
    productCost: cogsComplete ? money(cost) : null,
    deliveryCost: money(lineDelivery),
    profit: profit === null ? null : money(profit),
  };
}

export async function listOrdersForProduct(
  productId: string | null,
  range: PeriodRange,
  page: number,
  pageSize: number
): Promise<ProfitabilityOrdersPage> {
  const where = {
    placedAt: { gte: range.from, lte: range.to },
    items: { some: { productId } },
  };
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: ORDER_DETAIL_SELECT,
      orderBy: { placedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return { rows: orders.map((o) => toOrderRow(o, { productId })), total };
}

export async function listOrdersForCampaign(
  campaignId: string | null,
  range: PeriodRange,
  page: number,
  pageSize: number
): Promise<ProfitabilityOrdersPage> {
  const where = { placedAt: { gte: range.from, lte: range.to }, campaignId };
  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: ORDER_DETAIL_SELECT,
      orderBy: { placedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return { rows: orders.map((o) => toOrderRow(o, {})), total };
}
