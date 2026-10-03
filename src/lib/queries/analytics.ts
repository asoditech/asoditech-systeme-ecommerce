import "server-only";

import { prisma } from "@/lib/prisma";
import { variantLabel } from "@/lib/catalog/lookup";

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
