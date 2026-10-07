import "server-only";

import { prisma } from "@/lib/prisma";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import { warehouseReadWhere } from "@/lib/auth/location-access";
import { variationIdsMatchingOptionValue } from "@/lib/catalog/variation-search";
import type { CurrentUser } from "@/lib/auth/session";
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

/**
 * The ONE product-search predicate (docs/adr/0038): name, SKU, model
 * reference, and — variant-aware — every variation's SKU and every barcode
 * (the product's own or a variation's). Shared by the product list, the
 * order form's picker and the global search so all three find the same
 * things; a scanned barcode or a variant SKU must find its parent product.
 */
export function productSearchWhere(q: string): Prisma.ProductWhereInput[] {
  const contains = { contains: q, mode: "insensitive" as const };
  return [
    { name: contains },
    { sku: contains },
    { reference: contains },
    { variations: { some: { sku: contains } } },
    { barcodes: { some: { code: contains } } },
    { variations: { some: { barcodes: { some: { code: contains } } } } },
  ];
}

/**
 * `productSearchWhere` + variation OPTION VALUES ("Rouge", "XL" —
 * src/lib/catalog/variation-search.ts). Returns the matching variation ids too,
 * so a caller can show only those variations for an option-only match.
 */
export async function productSearchWhereWithOptions(
  q: string
): Promise<{ or: Prisma.ProductWhereInput[]; optionVariationIds: ReadonlySet<string> }> {
  const ids = await variationIdsMatchingOptionValue(q);
  return {
    or: ids.length > 0 ? [...productSearchWhere(q), { variations: { some: { id: { in: ids } } } }] : productSearchWhere(q),
    optionVariationIds: new Set(ids),
  };
}

export async function listProducts(params: ProductListFilters, viewer?: Pick<CurrentUser, "locations">) {
  const page = Math.max(1, params.page ?? 1);
  // Stock figures cover only the viewer's own locations (docs/adr/0050);
  // omitted = tenant-wide (non-page callers).
  const stockScope = viewer ? warehouseReadWhere(viewer) : {};
  const where: Prisma.ProductWhereInput = {
    ...(params.q ? { OR: (await productSearchWhereWithOptions(params.q)).or } : {}),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.type === "variable"
      ? { variations: { some: {} } }
      : params.type === "simple"
        ? { variations: { none: {} } }
        : {}),
  };

  // "recent" (the default) = newest-created first. `platformCreatedAt` is
  // the merchant-facing creation date (the store's `date_created` for an
  // imported product, `now()` for one made here) — `createdAt` is only the
  // local insert time, which reshuffles on every re-import. Fall back to
  // `createdAt` for any row a sync hasn't populated yet.
  const orderBy: Prisma.ProductOrderByWithRelationInput[] =
    params.sort === "name"
      ? [{ name: "asc" }]
      : params.sort === "price-asc"
        ? [{ price: "asc" }]
        : params.sort === "price-desc"
          ? [{ price: "desc" }]
          : [{ platformCreatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }];

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: true,
        inventoryItems: { where: stockScope, select: { quantityOnHand: true, quantityReserved: true } },
        // Just the lead photo, for the hover preview on the product name —
        // never a full gallery here, this is a list, not a detail page.
        images: { take: 1, orderBy: { position: "asc" } },
        // Variation price + stock so the list can show a real price range
        // and aggregate stock for a variable product, instead of the
        // parent's own always-empty price/stock (WooCommerce keeps neither
        // on a variable parent — both live on the variations).
        variations: {
          select: {
            id: true,
            price: true,
            // Purchase cost so an authorised viewer can see a variable
            // product's cost range in the list — the caller gates this
            // on `finance.view` before rendering it (client feedback #8).
            cost: true,
            inventoryItems: { where: stockScope, select: { quantityOnHand: true } },
          },
        },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return { products, total, page, pageSize: PAGE_SIZE };
}

export async function getProductDetail(id: string, viewer?: Pick<CurrentUser, "locations">) {
  // Per-location stock only for the viewer's own locations (docs/adr/0050).
  const stockScope = viewer ? warehouseReadWhere(viewer) : {};
  return prisma.product.findUnique({
    where: { id },
    include: {
      category: true,
      images: { orderBy: { position: "asc" } },
      // Identity + availability (docs/adr/0038).
      barcodes: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      salesChannels: { select: { salesChannelId: true } },
      variations: {
        include: {
          inventoryItems: { where: stockScope, include: { warehouse: { select: { name: true } } } },
          barcodes: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        },
        orderBy: { createdAt: "asc" },
      },
      inventoryItems: { where: stockScope, include: { warehouse: true } },
      // Batch 13 (Product Publishing) — which external channels this
      // product has already been explicitly published to.
      publications: { select: { provider: true, externalId: true } },
      _count: { select: { orderItems: true } },
    },
  });
}

export async function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
}

export interface CategoryWithStats {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  parentName: string | null;
  source: RecordSource;
  productCount: number;
  variantCount: number;
  /** Σ InventoryItem.quantityOnHand across every product/variation in this category. */
  stockOnHand: number;
  createdAt: Date;
}

/**
 * Category list for the /catalogue/categories management page (Batch 3,
 * Task 1). Product count comes straight off the `Category.products` relation
 * (`_count`, same as `listCategories`); variant count and stock-on-hand have
 * no direct Category relation to `_count` (Category → Product →
 * ProductVariation/InventoryItem is two hops), so each is one additional
 * whole-table read reduced to a per-category map in JS — three queries
 * total, none of them per-category (no N+1), sized to the catalogue rather
 * than to how many categories exist.
 */
export async function listCategoriesWithStats(): Promise<CategoryWithStats[]> {
  const [categories, products, inventoryItems] = await Promise.all([
    prisma.category.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } }, parent: { select: { name: true } } },
    }),
    prisma.product.findMany({
      where: { categoryId: { not: null } },
      select: { categoryId: true, _count: { select: { variations: true } } },
    }),
    prisma.inventoryItem.findMany({
      select: {
        quantityOnHand: true,
        product: { select: { categoryId: true } },
        variation: { select: { product: { select: { categoryId: true } } } },
      },
    }),
  ]);

  const variantsByCategory = new Map<string, number>();
  for (const p of products) {
    if (!p.categoryId) continue;
    variantsByCategory.set(p.categoryId, (variantsByCategory.get(p.categoryId) ?? 0) + p._count.variations);
  }

  const stockByCategory = new Map<string, number>();
  for (const item of inventoryItems) {
    const categoryId = item.product?.categoryId ?? item.variation?.product.categoryId ?? null;
    if (!categoryId) continue;
    stockByCategory.set(categoryId, (stockByCategory.get(categoryId) ?? 0) + item.quantityOnHand);
  }

  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    parentId: c.parentId,
    parentName: c.parent?.name ?? null,
    source: c.source,
    productCount: c._count.products,
    variantCount: variantsByCategory.get(c.id) ?? 0,
    stockOnHand: stockByCategory.get(c.id) ?? 0,
    createdAt: c.createdAt,
  }));
}

export async function getProductSalesStats(productId: string) {
  const stats = await prisma.orderItem.aggregate({
    where: { productId, order: { status: { notIn: REVENUE_EXCLUDED_STATUSES } } },
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
