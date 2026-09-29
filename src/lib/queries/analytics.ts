import "server-only";

import { prisma } from "@/lib/prisma";
import { displayOrderChannel } from "@/lib/format";
import { variantLabel } from "@/lib/catalog/lookup";

export async function getRevenueTrend(days = 30) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: from }, status: { notIn: ["ANNULEE", "ECHEC"] } },
    select: { createdAt: true, total: true },
  });

  const byDay = new Map<string, number>();
  for (let i = 0; i <= days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const o of orders) {
    const key = o.createdAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(o.total));
  }

  return Array.from(byDay.entries()).map(([date, revenue]) => ({ date, revenue }));
}

export async function getOrderStatusBreakdown() {
  const grouped = await prisma.order.groupBy({ by: ["status"], _count: true });
  return grouped.map((g) => ({ status: g.status, count: g._count })).sort((a, b) => b.count - a.count);
}

/**
 * How many orders came from each channel — a WooCommerce/Shopify-imported
 * order derives its channel from `source` (the store IS the channel); a
 * manually-created order shows its own `channel` (WhatsApp, Téléphone,
 * …), same `displayOrderChannel` logic used on the orders list/detail
 * pages. Grouped by the raw (source, channel) pair in SQL, then merged
 * into display labels in JS since `source !== INTERNE` collapses several
 * distinct channel values onto one WooCommerce/Shopify label.
 */
export async function getChannelBreakdown() {
  const grouped = await prisma.order.groupBy({ by: ["source", "channel"], _count: true });

  const counts = new Map<string, number>();
  for (const g of grouped) {
    const label = displayOrderChannel({ source: g.source, channel: g.channel });
    counts.set(label, (counts.get(label) ?? 0) + g._count);
  }

  return Array.from(counts.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);
}

export async function getTopProducts(limit = 5) {
  const grouped = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: { productId: { not: null }, order: { status: { notIn: ["ANNULEE", "ECHEC"] } } },
    _sum: { quantity: true, total: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const products = await prisma.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId).filter((id): id is string => id !== null) } },
  });

  return grouped.map((g) => ({
    product: products.find((p) => p.id === g.productId),
    unitsSold: g._sum.quantity ?? 0,
    revenue: g._sum.total ?? 0,
  }));
}

export interface TopSellingUnit {
  key: string;
  productId: string | null;
  variationId: string | null;
  productName: string;
  variantLabel: string | null;
  imageUrl: string | null;
  unitsSold: number;
  revenue: number;
}

/**
 * Dashboard "Top Selling Products" ranking (UI refinement pass, 2026-09) —
 * the SAME safe metric `getTopProducts` already uses (units sold / revenue
 * from OrderItem, excluding ANNULEE/ECHEC orders, no new accounting concept),
 * just grouped one level finer: by SELLABLE UNIT (product+variation pair,
 * the same `productId ?? variationId` identity every other catalog surface
 * uses — see `ProductIdentityPanel`'s `unitKey`) instead of by product alone,
 * so "T-Shirt — S / Noir" and "T-Shirt — M / Blanc" rank separately. A
 * dedicated function rather than widening `getTopProducts` itself: that one
 * has other callers (the /analyses page, the AI assistant's "best-selling
 * product" tool) whose product-level behaviour must not change.
 */
export async function getTopSellingUnits(period: { from: Date; to: Date }, limit = 5): Promise<TopSellingUnit[]> {
  const grouped = await prisma.orderItem.groupBy({
    by: ["productId", "variationId"],
    where: {
      productId: { not: null },
      order: { status: { notIn: ["ANNULEE", "ECHEC"] }, placedAt: { gte: period.from, lte: period.to } },
    },
    _sum: { quantity: true, total: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });
  if (grouped.length === 0) return [];

  const productIds = [...new Set(grouped.map((g) => g.productId).filter((id): id is string => id !== null))];
  const variationIds = grouped.map((g) => g.variationId).filter((id): id is string => id !== null);

  const [products, variations] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { images: { orderBy: { position: "asc" }, take: 1 } },
    }),
    variationIds.length > 0 ? prisma.productVariation.findMany({ where: { id: { in: variationIds } } }) : Promise.resolve([]),
  ]);

  return grouped.map((g) => {
    const product = products.find((p) => p.id === g.productId);
    const variation = g.variationId ? variations.find((v) => v.id === g.variationId) : undefined;
    return {
      key: g.variationId ?? g.productId ?? "",
      productId: g.productId,
      variationId: g.variationId,
      productName: product?.name ?? "Produit supprimé",
      variantLabel: variation ? variantLabel(variation.attributes as Record<string, string>) : null,
      imageUrl: variation?.imageUrl ?? product?.images[0]?.url ?? null,
      unitsSold: g._sum.quantity ?? 0,
      revenue: Number(g._sum.total ?? 0),
    };
  });
}
