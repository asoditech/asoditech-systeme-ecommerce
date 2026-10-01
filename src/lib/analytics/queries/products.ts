import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import { variantLabel } from "@/lib/catalog/lookup";
import type { CurrentUser } from "@/lib/auth/session";
import type { PeriodRange } from "@/lib/queries/finance";
import { placedCohortWhere } from "@/lib/analytics/queries/online";
import { storeSaleWhere } from "@/lib/analytics/queries/store";
import { orderFilterWhere, type AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * Product performance — docs/adr/0051.
 *
 * Online: order lines of orders PLACED in the period that count as revenue
 * (not cancelled / failed / returned / refunded — the same exclusion as
 * Finance and the sales report). Store: sale lines of POS sales SOLD in the
 * period, channel- AND location-scoped (`storeSaleWhere` → `saleChannelWhere`). The two are
 * separate tables — an in-store sale is never an Online order.
 *
 * Returned quantities are the PHYSICAL returns received in the period
 * (`OrderReturn.receivedAt` / `SaleReturn.receivedAt`) — their own date, so a
 * return can concern a sale from an earlier period; labelled as such.
 *
 * Cost of goods / gross profit exist ONLY when `withFinance` is true: the
 * `costSnapshot` column is not even selected otherwise (docs/adr/0050).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()));

export interface ProductRow {
  key: string;
  productId: string | null;
  variationId: string | null;
  name: string;
  variant: string | null;
  categoryId: string | null;
  category: string | null;
  units: number;
  /** Distinct orders (Online) or sales (store) containing the unit. */
  orders: number;
  revenue: number;
  returnedUnits: number;
  /** Present only with finance access; null = at least one line has no cost snapshot. */
  cogs?: number | null;
  grossProfit?: number | null;
}

export interface CategoryRow {
  categoryId: string | null;
  name: string;
  units: number;
  orders: number;
  revenue: number;
  returnedUnits: number;
  cogs?: number | null;
  grossProfit?: number | null;
}

export interface ProductPerformance {
  rows: ProductRow[];
  categories: CategoryRow[];
  totals: { units: number; revenue: number; returnedUnits: number };
}

type Line = { productId: string | null; variationId: string | null; parentId: string; nameSnapshot: string; quantity: number; total: unknown; costSnapshot?: unknown };
type ReturnLine = { productId: string | null; variationId: string | null; nameSnapshot: string; quantity: number };

const keyOf = (l: { productId: string | null; variationId: string | null; nameSnapshot: string }) =>
  l.productId || l.variationId ? `${l.productId ?? "-"}:${l.variationId ?? "-"}` : `name:${l.nameSnapshot}`;

async function build(lines: Line[], returns: ReturnLine[], withFinance: boolean): Promise<ProductPerformance> {
  const productIds = [...new Set([...lines, ...returns].map((l) => l.productId).filter((x): x is string => x !== null))];
  const variationIds = [...new Set([...lines, ...returns].map((l) => l.variationId).filter((x): x is string => x !== null))];
  const [products, variations] = await Promise.all([
    productIds.length
      ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, categoryId: true, category: { select: { name: true } } } })
      : Promise.resolve([]),
    variationIds.length ? prisma.productVariation.findMany({ where: { id: { in: variationIds } }, select: { id: true, attributes: true } }) : Promise.resolve([]),
  ]);

  const rows = new Map<string, ProductRow & { parents: Set<string>; costMissing: boolean; cost: number }>();
  const rowFor = (l: { productId: string | null; variationId: string | null; nameSnapshot: string }) => {
    const k = keyOf(l);
    let r = rows.get(k);
    if (!r) {
      const p = products.find((x) => x.id === l.productId);
      const v = variations.find((x) => x.id === l.variationId);
      r = {
        key: k,
        productId: l.productId,
        variationId: l.variationId,
        name: p?.name ?? l.nameSnapshot,
        variant: v ? variantLabel(v.attributes) : null,
        categoryId: p?.categoryId ?? null,
        category: p?.category?.name ?? null,
        units: 0,
        orders: 0,
        revenue: 0,
        returnedUnits: 0,
        parents: new Set(),
        costMissing: false,
        cost: 0,
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const l of lines) {
    const r = rowFor(l);
    r.units += l.quantity;
    r.revenue += num(l.total as never);
    r.parents.add(l.parentId);
    if (withFinance) {
      if (l.costSnapshot == null) r.costMissing = true;
      else r.cost += num(l.costSnapshot as never) * l.quantity;
    }
  }
  for (const l of returns) rowFor(l).returnedUnits += l.quantity;

  const finance = (revenue: number, cost: number, missing: boolean) =>
    withFinance ? { cogs: missing ? null : round2(cost), grossProfit: missing ? null : round2(revenue - cost) } : {};

  const productRows: ProductRow[] = [...rows.values()].map(({ parents, costMissing, cost, ...r }) => ({
    ...r,
    orders: parents.size,
    revenue: round2(r.revenue),
    ...finance(r.revenue, cost, costMissing),
  }));

  const cats = new Map<string, CategoryRow & { parents: Set<string>; costMissing: boolean; cost: number }>();
  for (const r of rows.values()) {
    const k = r.categoryId ?? "none";
    const c = cats.get(k) ?? { categoryId: r.categoryId, name: r.category ?? "Sans catégorie", units: 0, orders: 0, revenue: 0, returnedUnits: 0, parents: new Set<string>(), costMissing: false, cost: 0 };
    c.units += r.units;
    c.revenue += r.revenue;
    c.returnedUnits += r.returnedUnits;
    for (const p of r.parents) c.parents.add(p);
    c.costMissing ||= r.costMissing;
    c.cost += r.cost;
    cats.set(k, c);
  }
  const categories: CategoryRow[] = [...cats.values()]
    .map(({ parents, costMissing, cost, ...c }) => ({ ...c, orders: parents.size, revenue: round2(c.revenue), ...finance(c.revenue, cost, costMissing) }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    rows: productRows.sort((a, b) => b.units - a.units),
    categories,
    totals: {
      units: productRows.reduce((n, r) => n + r.units, 0),
      revenue: round2(productRows.reduce((n, r) => n + r.revenue, 0)),
      returnedUnits: productRows.reduce((n, r) => n + r.returnedUnits, 0),
    },
  };
}

const categoryWhere = (f: AnalyticsFilters) => (f.categoryId ? { product: { categoryId: f.categoryId } } : {});

export async function getOnlineProductPerformance(range: PeriodRange, filters: AnalyticsFilters, opts: { withFinance: boolean }): Promise<ProductPerformance> {
  const where: Prisma.OrderItemWhereInput = {
    order: { AND: [placedCohortWhere(range, filters), { status: { notIn: REVENUE_EXCLUDED_STATUSES } }] },
    ...categoryWhere(filters),
  };
  const [items, returns] = await Promise.all([
    prisma.orderItem.findMany({
      where,
      select: { productId: true, variationId: true, orderId: true, nameSnapshot: true, quantity: true, total: true, ...(opts.withFinance ? { costSnapshot: true } : {}) },
    }),
    prisma.orderReturnLine.findMany({
      where: {
        orderReturn: { receivedAt: { gte: range.from, lte: range.to }, order: orderFilterWhere(filters) },
        ...(filters.categoryId ? { orderItem: { product: { categoryId: filters.categoryId } } } : {}),
      },
      select: { nameSnapshot: true, quantitySellable: true, quantityDamaged: true, orderItem: { select: { productId: true, variationId: true } } },
    }),
  ]);
  return build(
    items.map((i) => ({ ...i, parentId: i.orderId })),
    returns.map((r) => ({ productId: r.orderItem?.productId ?? null, variationId: r.orderItem?.variationId ?? null, nameSnapshot: r.nameSnapshot, quantity: r.quantitySellable + r.quantityDamaged })),
    opts.withFinance
  );
}

export async function getStoreProductPerformance(
  viewer: Pick<CurrentUser, "channels" | "locations">,
  range: PeriodRange,
  filters: AnalyticsFilters,
  opts: { withFinance: boolean }
): Promise<ProductPerformance> {
  const scope = storeSaleWhere(viewer, filters);
  const [lines, returns] = await Promise.all([
    prisma.saleLine.findMany({
      where: { sale: { AND: [scope, { soldAt: { gte: range.from, lte: range.to } }] }, ...categoryWhere(filters) },
      select: { productId: true, variationId: true, saleId: true, nameSnapshot: true, quantity: true, total: true, ...(opts.withFinance ? { costSnapshot: true } : {}) },
    }),
    prisma.saleReturnLine.findMany({
      where: {
        saleReturn: { receivedAt: { gte: range.from, lte: range.to }, sale: scope },
        ...(filters.categoryId ? { saleLine: { product: { categoryId: filters.categoryId } } } : {}),
      },
      select: { nameSnapshot: true, quantitySellable: true, quantityDamaged: true, saleLine: { select: { productId: true, variationId: true } } },
    }),
  ]);
  return build(
    lines.map((l) => ({ ...l, parentId: l.saleId })),
    returns.map((r) => ({ productId: r.saleLine?.productId ?? null, variationId: r.saleLine?.variationId ?? null, nameSnapshot: r.nameSnapshot, quantity: r.quantitySellable + r.quantityDamaged })),
    opts.withFinance
  );
}
