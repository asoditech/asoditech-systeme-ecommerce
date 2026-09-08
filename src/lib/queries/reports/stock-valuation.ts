import "server-only";

import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";

/**
 * Stock valuation & rotation — what the on-hand inventory is worth and
 * how fast it moves.
 *
 * Value at cost uses `Product.cost` / `ProductVariation.cost` (the
 * current standard cost, NOT the frozen sale-time `costSnapshot` — this
 * is a "what do I own right now" figure, not a realised-profit one).
 * Value at retail uses `salePrice ?? price`. A line whose product has no
 * cost set is counted in `linesMissingCost` and contributes 0 to the
 * at-cost total — the total is flagged incomplete rather than guessed.
 *
 * "Dormant" = an InventoryItem with stock on hand that has sold zero
 * units in the last `dormantDays` days (across non-excluded orders).
 */

export interface StockValuationRow {
  warehouseName: string;
  productName: string;
  sku: string;
  variantLabel: string | null;
  quantityOnHand: number;
  unitCost: number | null;
  unitRetail: number;
  valueAtCost: number | null;
  valueAtRetail: number;
  unitsSoldInWindow: number;
  dormant: boolean;
}

export interface StockValuationReport {
  rows: StockValuationRow[];
  totals: {
    skuCount: number;
    unitsOnHand: number;
    valueAtCost: number | null;
    valueAtRetail: number;
    potentialMargin: number | null;
    linesMissingCost: number;
    dormantSkuCount: number;
    dormantValueAtCost: number | null;
  };
  dormantDays: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function variantLabel(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const parts = Object.values(attributes as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  return parts.length > 0 ? parts.join(" / ") : null;
}

export async function getStockValuationReport(
  opts: { warehouseId?: string; dormantDays?: number } = {}
): Promise<StockValuationReport> {
  const dormantDays = opts.dormantDays ?? 60;
  const dormantSince = new Date();
  dormantSince.setDate(dormantSince.getDate() - dormantDays);

  const items = await prisma.inventoryItem.findMany({
    where: {
      ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}),
      quantityOnHand: { gt: 0 },
    },
    select: {
      quantityOnHand: true,
      warehouse: { select: { name: true } },
      product: { select: { id: true, name: true, sku: true, cost: true, price: true, salePrice: true } },
      variation: {
        select: {
          id: true,
          sku: true,
          attributes: true,
          cost: true,
          price: true,
          product: { select: { name: true, cost: true, price: true, salePrice: true } },
        },
      },
    },
  });

  // One grouped query for units sold per product/variation in the window,
  // rather than a query per row.
  const soldLines = await prisma.orderItem.groupBy({
    by: ["productId", "variationId"],
    where: {
      order: { placedAt: { gte: dormantSince }, status: { notIn: REVENUE_EXCLUDED_STATUSES } },
    },
    _sum: { quantity: true },
  });
  const soldByProduct = new Map<string, number>();
  const soldByVariation = new Map<string, number>();
  for (const l of soldLines) {
    if (l.variationId) soldByVariation.set(l.variationId, (soldByVariation.get(l.variationId) ?? 0) + (l._sum.quantity ?? 0));
    else if (l.productId) soldByProduct.set(l.productId, (soldByProduct.get(l.productId) ?? 0) + (l._sum.quantity ?? 0));
  }

  const rows: StockValuationRow[] = [];
  for (const item of items) {
    const qty = item.quantityOnHand;
    let productName: string;
    let sku: string;
    let vLabel: string | null = null;
    let unitCost: number | null;
    let unitRetail: number;
    let unitsSold: number;

    if (item.variation) {
      productName = item.variation.product.name;
      sku = item.variation.sku;
      vLabel = variantLabel(item.variation.attributes);
      const cost = item.variation.cost ?? item.variation.product.cost;
      unitCost = cost != null ? Number(cost) : null;
      unitRetail = Number(item.variation.price ?? item.variation.product.salePrice ?? item.variation.product.price ?? 0);
      unitsSold = soldByVariation.get(item.variation.id) ?? 0;
    } else if (item.product) {
      productName = item.product.name;
      sku = item.product.sku;
      unitCost = item.product.cost != null ? Number(item.product.cost) : null;
      unitRetail = Number(item.product.salePrice ?? item.product.price ?? 0);
      unitsSold = soldByProduct.get(item.product.id) ?? 0;
    } else {
      continue; // orphan inventory row (product + variation both deleted)
    }

    rows.push({
      warehouseName: item.warehouse.name,
      productName,
      sku,
      variantLabel: vLabel,
      quantityOnHand: qty,
      unitCost,
      unitRetail: round2(unitRetail),
      valueAtCost: unitCost != null ? round2(unitCost * qty) : null,
      valueAtRetail: round2(unitRetail * qty),
      unitsSoldInWindow: unitsSold,
      dormant: unitsSold === 0,
    });
  }

  rows.sort((a, b) => (b.valueAtCost ?? 0) - (a.valueAtCost ?? 0) || b.valueAtRetail - a.valueAtRetail);

  let valueAtCost = 0;
  let valueAtRetail = 0;
  let linesMissingCost = 0;
  let unitsOnHand = 0;
  let dormantSkuCount = 0;
  let dormantValueAtCost = 0;
  let anyCost = false;
  for (const r of rows) {
    unitsOnHand += r.quantityOnHand;
    valueAtRetail += r.valueAtRetail;
    if (r.valueAtCost != null) {
      valueAtCost += r.valueAtCost;
      anyCost = true;
    } else {
      linesMissingCost += 1;
    }
    if (r.dormant) {
      dormantSkuCount += 1;
      if (r.valueAtCost != null) dormantValueAtCost += r.valueAtCost;
    }
  }

  return {
    rows,
    totals: {
      skuCount: rows.length,
      unitsOnHand,
      // A partial at-cost total (some lines have no cost) is still useful —
      // shown with `linesMissingCost` as the caveat. Null only when NO
      // line has a cost at all.
      valueAtCost: anyCost ? round2(valueAtCost) : null,
      valueAtRetail: round2(valueAtRetail),
      potentialMargin: anyCost ? round2(valueAtRetail - valueAtCost) : null,
      linesMissingCost,
      dormantSkuCount,
      dormantValueAtCost: anyCost ? round2(dormantValueAtCost) : null,
    },
    dormantDays,
  };
}
