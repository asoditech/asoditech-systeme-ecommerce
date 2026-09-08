import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * Product & category profitability for the window — realised, from the
 * frozen `OrderItem.costSnapshot` (so it never shifts when `Product.cost`
 * is edited later), across non-excluded orders. Mirrors
 * `computeProductProfitability` in profitability.ts but returns the FULL
 * list (no `limit`) plus a category rollup, for the dedicated report.
 * A group with any cost-less line is marked `cogsComplete: false` and its
 * profit/margin reported as null rather than guessed.
 */

const D = (v: Prisma.Decimal | number | string | null): Prisma.Decimal =>
  v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v ?? 0);
const money = (d: Prisma.Decimal) => Number(d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString());
const marginPct = (profit: Prisma.Decimal, revenue: Prisma.Decimal) =>
  revenue.isZero() ? null : Number(profit.div(revenue).mul(100).toDecimalPlaces(1).toString());

export interface ProfitRow {
  key: string;
  name: string;
  unitsSold: number;
  revenue: number;
  cogs: number | null;
  cogsComplete: boolean;
  grossProfit: number | null;
  marginPct: number | null;
  linesMissingCost: number;
}

export interface ProductProfitReport {
  products: ProfitRow[];
  categories: ProfitRow[];
  totals: { revenue: number; cogs: number | null; grossProfit: number | null; marginPct: number | null; cogsComplete: boolean };
}

export async function getProductProfitReport(range: PeriodRange): Promise<ProductProfitReport> {
  const lines = await prisma.orderItem.findMany({
    where: {
      order: { placedAt: { gte: range.from, lte: range.to }, status: { notIn: REVENUE_EXCLUDED_STATUSES } },
    },
    select: {
      productId: true,
      nameSnapshot: true,
      quantity: true,
      total: true,
      costSnapshot: true,
      product: { select: { name: true, category: { select: { id: true, name: true } } } },
    },
  });

  const acc = () => ({ units: 0, revenue: D(0), cogs: D(0), missing: 0 });
  type Acc = ReturnType<typeof acc>;
  const byProduct = new Map<string, Acc & { name: string }>();
  const byCategory = new Map<string, Acc & { name: string }>();

  for (const l of lines) {
    const pKey = l.productId ?? "__deleted__";
    const p = byProduct.get(pKey) ?? { ...acc(), name: l.product?.name ?? l.nameSnapshot };
    const cKey = l.product?.category?.id ?? "__none__";
    const c = byCategory.get(cKey) ?? { ...acc(), name: l.product?.category?.name ?? "Sans catégorie" };

    for (const g of [p, c]) {
      g.units += l.quantity;
      g.revenue = g.revenue.plus(D(l.total));
      if (l.costSnapshot === null) g.missing += 1;
      else g.cogs = g.cogs.plus(D(l.costSnapshot).mul(l.quantity));
    }
    byProduct.set(pKey, p);
    byCategory.set(cKey, c);
  }

  const toRow = (key: string, g: Acc & { name: string }): ProfitRow => {
    const complete = g.missing === 0;
    const gp = complete ? g.revenue.minus(g.cogs) : null;
    return {
      key,
      name: g.name,
      unitsSold: g.units,
      revenue: money(g.revenue),
      cogs: complete ? money(g.cogs) : null,
      cogsComplete: complete,
      grossProfit: gp === null ? null : money(gp),
      marginPct: gp === null ? null : marginPct(gp, g.revenue),
      linesMissingCost: g.missing,
    };
  };

  const products = [...byProduct.entries()]
    .map(([k, g]) => toRow(k, g))
    .sort((a, b) => (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity) || b.revenue - a.revenue);
  const categories = [...byCategory.entries()]
    .map(([k, g]) => toRow(k, g))
    .sort((a, b) => (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity) || b.revenue - a.revenue);

  let revenue = D(0);
  let cogs = D(0);
  let anyMissing = false;
  for (const g of byProduct.values()) {
    revenue = revenue.plus(g.revenue);
    cogs = cogs.plus(g.cogs);
    if (g.missing > 0) anyMissing = true;
  }
  const gp = anyMissing ? null : revenue.minus(cogs);

  return {
    products,
    categories,
    totals: {
      revenue: money(revenue),
      cogs: anyMissing ? null : money(cogs),
      grossProfit: gp === null ? null : money(gp),
      marginPct: gp === null ? null : marginPct(gp, revenue),
      cogsComplete: !anyMissing,
    },
  };
}
