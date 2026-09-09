import "server-only";

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { ProductStatus, RecordSource } from "@prisma/client";

const PAGE_SIZE = 20;

export type ProductSort = "recent" | "name" | "price-asc" | "price-desc";

/** No `type` column exists on Product — "variable" is derived from having
 * at least one variation, "simple" from having none. */
export type ProductTypeFilter = "simple" | "variable";

export interface ProductListFilters {
  q?: string;
  categoryId?: string;
  status?: ProductStatus;
  source?: RecordSource;
  type?: ProductTypeFilter;
  sort?: ProductSort;
  page?: number;
}

export async function listProducts(params: ProductListFilters) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ProductWhereInput = {
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { sku: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.type === "variable"
      ? { variations: { some: {} } }
      : params.type === "simple"
        ? { variations: { none: {} } }
        : {}),
  };

  const orderBy: Prisma.ProductOrderByWithRelationInput =
    params.sort === "name"
      ? { name: "asc" }
      : params.sort === "price-asc"
        ? { price: "asc" }
        : params.sort === "price-desc"
          ? { price: "desc" }
          : { createdAt: "desc" };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: true,
        inventoryItems: { select: { quantityOnHand: true, quantityReserved: true } },
        // Variation price + stock so the list can show a real price range
        // and aggregate stock for a variable product, instead of the
        // parent's own always-empty price/stock (WooCommerce keeps neither
        // on a variable parent — both live on the variations).
        variations: {
          select: {
            id: true,
            price: true,
            inventoryItems: { select: { quantityOnHand: true } },
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return { products, total, page, pageSize: PAGE_SIZE };
}

export async function getProductDetail(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      category: true,
      images: { orderBy: { position: "asc" } },
      variations: {
        include: { inventoryItems: { include: { warehouse: { select: { name: true } } } } },
        orderBy: { createdAt: "asc" },
      },
      inventoryItems: { include: { warehouse: true } },
      _count: { select: { orderItems: true } },
    },
  });
}

export async function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
}

export async function getProductSalesStats(productId: string) {
  const stats = await prisma.orderItem.aggregate({
    where: { productId, order: { status: { notIn: ["ANNULEE", "ECHEC"] } } },
    _sum: { quantity: true, total: true },
  });
  return {
    unitsSold: stats._sum.quantity ?? 0,
    revenue: stats._sum.total ?? null,
  };
}

/**
 * Realised, all-time profitability for one product — revenue and COGS from
 * the frozen `costSnapshot` on each sold line (so it never shifts when
 * `Product.cost` changes), across every non-cancelled/failed/returned
 * order. `cogsComplete` is false when any sold line is missing its cost.
 */
export async function getProductProfitStats(productId: string): Promise<{
  unitsSold: number;
  revenue: number;
  cogs: number | null;
  cogsComplete: boolean;
  linesMissingCost: number;
  grossProfit: number | null;
  marginPct: number | null;
}> {
  const { REVENUE_EXCLUDED_STATUSES } = await import("@/lib/profitability");
  const lines = await prisma.orderItem.findMany({
    where: { productId, order: { status: { notIn: REVENUE_EXCLUDED_STATUSES } } },
    select: { quantity: true, total: true, costSnapshot: true },
  });
  let units = 0;
  let revenue = new Prisma.Decimal(0);
  let cogs = new Prisma.Decimal(0);
  let complete = true;
  let linesMissingCost = 0;
  for (const l of lines) {
    units += l.quantity;
    revenue = revenue.plus(l.total);
    if (l.costSnapshot === null) {
      complete = false;
      linesMissingCost++;
    } else cogs = cogs.plus(new Prisma.Decimal(l.costSnapshot).mul(l.quantity));
  }
  const grossProfit = complete ? revenue.minus(cogs) : null;
  const round = (d: Prisma.Decimal) => Number(d.toDecimalPlaces(2).toString());
  return {
    unitsSold: units,
    revenue: round(revenue),
    cogs: complete ? round(cogs) : null,
    cogsComplete: complete,
    linesMissingCost,
    grossProfit: grossProfit === null ? null : round(grossProfit),
    marginPct:
      grossProfit === null || revenue.isZero()
        ? null
        : Number(grossProfit.div(revenue).mul(100).toDecimalPlaces(1).toString()),
  };
}
