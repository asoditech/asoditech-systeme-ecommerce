import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const PAGE_SIZE = 25;

const INVENTORY_INCLUDE = {
  product: true,
  variation: { include: { product: true } },
  warehouse: true,
} satisfies Prisma.InventoryItemInclude;

/**
 * Low-stock is `quantityOnHand <= Product.lowStockThreshold`, but the
 * threshold lives on `Product` and the quantity on `InventoryItem` (and a
 * variation row's threshold comes from its parent product), so this is a
 * column-to-column comparison across a join that Prisma's query builder
 * can't express. Done as one raw SELECT of matching ids (paginated
 * DB-side), then hydrated with the normal typed `include`. Read-only.
 */
function lowStockFrom(q?: string): Prisma.Sql {
  // Escape LIKE metacharacters so a SKU search for "SKU_ABC" matches
  // literally (underscores are common in SKUs) — Prisma's `contains` does
  // the same for the non-low-stock path.
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const qFilter = like
    ? Prisma.sql`AND (p.name ILIKE ${like} OR p.sku ILIKE ${like} OR pv.sku ILIKE ${like})`
    : Prisma.empty;
  return Prisma.sql`
    FROM inventory_items ii
    LEFT JOIN products p ON p.id = ii."productId"
    LEFT JOIN product_variations pv ON pv.id = ii."variationId"
    LEFT JOIN products vp ON vp.id = pv."productId"
    WHERE ii."quantityOnHand" <= COALESCE(p."lowStockThreshold", vp."lowStockThreshold", 0)
    ${qFilter}
  `;
}

export type StockStatusFilter = "all" | "low" | "out";
export type InventorySort = "recent" | "quantity-asc" | "quantity-desc";

/**
 * Same cross-table-threshold problem as `lowStockFrom` (and, for "out",
 * a plain on-hand-vs-reserved comparison the query builder also can't do
 * column-to-column) — one raw WHERE clause shared by "low" and "out",
 * with the warehouse/category/search filters layered on top of whichever
 * stock-status condition applies.
 */
function stockStatusFrom(status: "low" | "out", filters: { q?: string; warehouseId?: string; categoryId?: string }): Prisma.Sql {
  const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const qFilter = like
    ? Prisma.sql`AND (p.name ILIKE ${like} OR p.sku ILIKE ${like} OR pv.sku ILIKE ${like})`
    : Prisma.empty;
  const warehouseFilter = filters.warehouseId ? Prisma.sql`AND ii."warehouseId" = ${filters.warehouseId}` : Prisma.empty;
  const categoryFilter = filters.categoryId
    ? Prisma.sql`AND COALESCE(p."categoryId", vp."categoryId") = ${filters.categoryId}`
    : Prisma.empty;
  const statusFilter =
    status === "out"
      ? Prisma.sql`AND (ii."quantityOnHand" - ii."quantityReserved") <= 0`
      : Prisma.sql`AND ii."quantityOnHand" <= COALESCE(p."lowStockThreshold", vp."lowStockThreshold", 0)`;
  return Prisma.sql`
    FROM inventory_items ii
    LEFT JOIN products p ON p.id = ii."productId"
    LEFT JOIN product_variations pv ON pv.id = ii."variationId"
    LEFT JOIN products vp ON vp.id = pv."productId"
    WHERE 1=1
    ${statusFilter}
    ${qFilter}
    ${warehouseFilter}
    ${categoryFilter}
  `;
}

function sortClause(sort: InventorySort | undefined): Prisma.Sql {
  if (sort === "quantity-asc") return Prisma.sql`ORDER BY ii."quantityOnHand" ASC`;
  if (sort === "quantity-desc") return Prisma.sql`ORDER BY ii."quantityOnHand" DESC`;
  return Prisma.sql`ORDER BY ii."updatedAt" DESC`;
}

export async function listInventoryItems(params: {
  q?: string;
  warehouseId?: string;
  categoryId?: string;
  stockStatus?: StockStatusFilter;
  sort?: InventorySort;
  page?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const q = params.q?.trim() || undefined;
  const stockStatus = params.stockStatus ?? "all";

  if (stockStatus === "low" || stockStatus === "out") {
    const from = stockStatusFrom(stockStatus, { q, warehouseId: params.warehouseId, categoryId: params.categoryId });
    const [idRows, countRows] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT ii.id ${from} ${sortClause(params.sort)} OFFSET ${skip} LIMIT ${PAGE_SIZE}`
      ),
      prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${from}`),
    ]);
    const ids = idRows.map((r) => r.id);
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, include: INVENTORY_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The raw query already carries the intended order — re-sort the
    // hydrated rows to match it rather than trusting findMany's own order.
    const items = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r));
    return { items, total: Number(countRows[0]?.count ?? 0), page, pageSize: PAGE_SIZE };
  }

  // Built as an AND-list of independent conditions rather than spreading
  // each into one object — `q` and `categoryId` each need their own `OR`
  // clause, and a plain object spread would let the second `OR` key
  // silently overwrite the first instead of combining them.
  const conditions: Prisma.InventoryItemWhereInput[] = [];
  if (q) {
    conditions.push({
      OR: [
        { product: { name: { contains: q, mode: "insensitive" } } },
        { product: { sku: { contains: q, mode: "insensitive" } } },
        { variation: { sku: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  if (params.warehouseId) {
    conditions.push({ warehouseId: params.warehouseId });
  }
  if (params.categoryId) {
    conditions.push({
      OR: [{ product: { categoryId: params.categoryId } }, { variation: { product: { categoryId: params.categoryId } } }],
    });
  }
  const where: Prisma.InventoryItemWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const orderBy: Prisma.InventoryItemOrderByWithRelationInput =
    params.sort === "quantity-asc"
      ? { quantityOnHand: "asc" }
      : params.sort === "quantity-desc"
        ? { quantityOnHand: "desc" }
        : { updatedAt: "desc" };

  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      include: INVENTORY_INCLUDE,
      orderBy,
      skip,
      take: PAGE_SIZE,
    }),
    prisma.inventoryItem.count({ where }),
  ]);

  return { items, total, page, pageSize: PAGE_SIZE };
}

export async function getLowStockCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count ${lowStockFrom()}`
  );
  return Number(rows[0]?.count ?? 0);
}

/** Stock locations for the /entrepots management surface, default first,
 * with a count of the InventoryItem rows each holds. */
export async function listWarehousesWithStats() {
  return prisma.warehouse.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { _count: { select: { inventoryItems: true } } },
  });
}

export async function getInventoryMovements(inventoryItemId: string, take = 20) {
  return prisma.inventoryMovement.findMany({
    where: { inventoryItemId },
    orderBy: { createdAt: "desc" },
    take,
    include: { performedBy: { select: { name: true } } },
  });
}
