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

export async function listInventoryItems(params: { lowStockOnly?: boolean; q?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const q = params.q?.trim() || undefined;

  if (params.lowStockOnly) {
    const from = lowStockFrom(q);
    const [idRows, countRows] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT ii.id ${from} ORDER BY ii."updatedAt" DESC OFFSET ${skip} LIMIT ${PAGE_SIZE}`
      ),
      prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${from}`),
    ]);
    const ids = idRows.map((r) => r.id);
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, include: INVENTORY_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r));
    return { items, total: Number(countRows[0]?.count ?? 0), page, pageSize: PAGE_SIZE };
  }

  const where: Prisma.InventoryItemWhereInput = q
    ? {
        OR: [
          { product: { name: { contains: q, mode: "insensitive" } } },
          { product: { sku: { contains: q, mode: "insensitive" } } },
          { variation: { sku: { contains: q, mode: "insensitive" } } },
        ],
      }
    : {};

  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      include: INVENTORY_INCLUDE,
      orderBy: { updatedAt: "desc" },
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
