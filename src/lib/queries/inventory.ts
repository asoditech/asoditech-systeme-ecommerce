import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveActiveTenantIdForRawSql } from "@/lib/tenant/resolve";
import { runRawBatchWithTenant } from "@/lib/tenant/rls";
import { availableStock } from "@/lib/inventory";
import { variantLabel } from "@/lib/catalog/lookup";
import { hasGlobalLocationAccess, listAccessibleActiveWarehouses } from "@/lib/auth/location-access";

const PAGE_SIZE = 25;

const INVENTORY_INCLUDE = {
  product: { include: { images: { take: 1, orderBy: { position: "asc" } } } },
  variation: { include: { product: { include: { images: { take: 1, orderBy: { position: "asc" } } } } } },
  warehouse: true,
} satisfies Prisma.InventoryItemInclude;

/** Extra columns the CSV export needs that the on-screen table doesn't
 * (category, reference, barcode) — same rows, richer projection. */
const INVENTORY_EXPORT_INCLUDE = {
  product: { include: { category: { select: { name: true } }, barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 } } },
  variation: {
    include: {
      product: { include: { category: { select: { name: true } } } },
      barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
    },
  },
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
function lowStockFrom(tenantId: string, q?: string): Prisma.Sql {
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
    WHERE ii."tenantId" = ${tenantId}
    AND ii."quantityOnHand" <= COALESCE(p."lowStockThreshold", vp."lowStockThreshold", 0)
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
function stockStatusFrom(
  tenantId: string,
  status: "low" | "out",
  filters: { q?: string; warehouseId?: string; categoryId?: string; allowedWarehouseIds?: string[] | null }
): Prisma.Sql {
  const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const qFilter = like
    ? Prisma.sql`AND (p.name ILIKE ${like} OR p.sku ILIKE ${like} OR pv.sku ILIKE ${like})`
    : Prisma.empty;
  const warehouseFilter = filters.warehouseId ? Prisma.sql`AND ii."warehouseId" = ${filters.warehouseId}` : Prisma.empty;
  // Location Access Management v1 (docs/adr/0037): a scoped user's set of
  // authorized warehouses, applied even with no explicit `warehouseId`
  // filter — never "every warehouse in the tenant" for a location-scoped
  // role. `null`/omitted means unrestricted (OWNER/ADMIN).
  const allowedFilter = !filters.allowedWarehouseIds
    ? Prisma.empty
    : filters.allowedWarehouseIds.length === 0
      ? Prisma.sql`AND false`
      : Prisma.sql`AND ii."warehouseId" IN (${Prisma.join(filters.allowedWarehouseIds)})`;
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
    WHERE ii."tenantId" = ${tenantId}
    ${statusFilter}
    ${qFilter}
    ${warehouseFilter}
    ${allowedFilter}
    ${categoryFilter}
  `;
}

function sortClause(sort: InventorySort | undefined): Prisma.Sql {
  if (sort === "quantity-asc") return Prisma.sql`ORDER BY ii."quantityOnHand" ASC`;
  if (sort === "quantity-desc") return Prisma.sql`ORDER BY ii."quantityOnHand" DESC`;
  return Prisma.sql`ORDER BY ii."updatedAt" DESC`;
}

/** The "all"-status filter set shared by `listInventoryItems` and the CSV
 * export (`listInventoryItemsForExport`) — kept in one place so the two
 * never drift apart (docs/adr — Batch 3, Task 4: the export must show
 * exactly what the page shows, for the SAME filters). */
function buildInventoryWhere(params: {
  q?: string;
  warehouseId?: string;
  categoryId?: string;
  allowedWarehouseIds?: string[] | null;
}): Prisma.InventoryItemWhereInput {
  const conditions: Prisma.InventoryItemWhereInput[] = [];
  if (params.q) {
    conditions.push({
      OR: [
        { product: { name: { contains: params.q, mode: "insensitive" } } },
        { product: { sku: { contains: params.q, mode: "insensitive" } } },
        { variation: { sku: { contains: params.q, mode: "insensitive" } } },
      ],
    });
  }
  if (params.warehouseId) {
    conditions.push({ warehouseId: params.warehouseId });
  }
  // Location Access Management v1 (docs/adr/0037) — applied even with no
  // explicit `warehouseId` filter, so a location-scoped role never sees (or
  // exports) stock from a warehouse outside its own authorized set.
  if (params.allowedWarehouseIds) {
    conditions.push({ warehouseId: { in: params.allowedWarehouseIds } });
  }
  if (params.categoryId) {
    conditions.push({
      OR: [{ product: { categoryId: params.categoryId } }, { variation: { product: { categoryId: params.categoryId } } }],
    });
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}

export async function listInventoryItems(params: {
  q?: string;
  warehouseId?: string;
  categoryId?: string;
  stockStatus?: StockStatusFilter;
  sort?: InventorySort;
  page?: number;
  /** Location Access Management v1 (docs/adr/0037) — the caller's own
   * authorized warehouse set, or `null`/omitted for an unrestricted (OWNER/
   * ADMIN) viewer. Always resolved by the CALLER (page/route), never here. */
  allowedWarehouseIds?: string[] | null;
}) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const q = params.q?.trim() || undefined;
  const stockStatus = params.stockStatus ?? "all";

  if (stockStatus === "low" || stockStatus === "out") {
    // Raw cross-join SELECT — cannot go through the tenant extension, so
    // it carries its own `ii."tenantId"` predicate instead (Phase 3 —
    // docs/adr/0025, closing the ADR 0024 "Known bypass").
    const tenantId = await resolveActiveTenantIdForRawSql("queries/inventory.listInventoryItems(low|out)");
    const from = stockStatusFrom(tenantId, stockStatus, {
      q,
      warehouseId: params.warehouseId,
      categoryId: params.categoryId,
      allowedWarehouseIds: params.allowedWarehouseIds,
    });
    // Phase 4 (docs/adr/0026): a raw query bypasses every Prisma extension,
    // so it never picks up the RLS `app.tenant_id` GUC on its own —
    // `runRawBatchWithTenant` runs both statements in one transaction with
    // that GUC set first, on top of the app-level predicate above.
    const [idRows, countRows] = (await runRawBatchWithTenant(tenantId, [
      prisma.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT ii.id ${from} ${sortClause(params.sort)} OFFSET ${skip} LIMIT ${PAGE_SIZE}`
      ),
      prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`SELECT COUNT(*)::bigint AS count ${from}`),
    ])) as [{ id: string }[], { count: bigint }[]];
    const ids = idRows.map((r) => r.id);
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, include: INVENTORY_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The raw query already carries the intended order — re-sort the
    // hydrated rows to match it rather than trusting findMany's own order.
    const items = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => Boolean(r));
    return { items, total: Number(countRows[0]?.count ?? 0), page, pageSize: PAGE_SIZE };
  }

  const where = buildInventoryWhere({
    q,
    warehouseId: params.warehouseId,
    categoryId: params.categoryId,
    allowedWarehouseIds: params.allowedWarehouseIds,
  });

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

export type StockStatusLabel = "Rupture" | "Stock faible" | "OK";

export interface InventoryExportRow {
  productName: string;
  variantLabel: string | null;
  reference: string | null;
  sku: string;
  barcode: string | null;
  categoryName: string | null;
  warehouseName: string;
  quantityOnHand: number;
  quantityReserved: number;
  available: number;
  quantityDamaged: number;
  /** Same thresholds as `/stock`'s own on-screen badges (Batch 15) — "Rupture"
   * wins over "Stock faible" when both would apply, matching the page. */
  stockStatus: StockStatusLabel;
}

/**
 * The General Stock CSV export (Batch 3, Task 4) — the exact same filters
 * (`buildInventoryWhere`/`stockStatusFrom`, so tenant scope and the caller's
 * chosen q/warehouse/category/status are identical to what `/stock` shows),
 * unpaginated, with a few extra display columns the page doesn't need
 * (`INVENTORY_EXPORT_INCLUDE`). Authorization is the caller's job — see the
 * `/stock/export` route, which resolves the exact same `inventory.view`
 * permission gate as the page before calling this.
 */
export async function listInventoryItemsForExport(params: {
  q?: string;
  warehouseId?: string;
  categoryId?: string;
  stockStatus?: StockStatusFilter;
  sort?: InventorySort;
  /** Same authorization contract as `listInventoryItems` above. */
  allowedWarehouseIds?: string[] | null;
}): Promise<InventoryExportRow[]> {
  const q = params.q?.trim() || undefined;
  const stockStatus = params.stockStatus ?? "all";

  type ExportRow = Prisma.InventoryItemGetPayload<{ include: typeof INVENTORY_EXPORT_INCLUDE }>;
  let items: ExportRow[];

  if (stockStatus === "low" || stockStatus === "out") {
    const tenantId = await resolveActiveTenantIdForRawSql("queries/inventory.listInventoryItemsForExport(low|out)");
    const from = stockStatusFrom(tenantId, stockStatus, {
      q,
      warehouseId: params.warehouseId,
      categoryId: params.categoryId,
      allowedWarehouseIds: params.allowedWarehouseIds,
    });
    const [idRows] = (await runRawBatchWithTenant(tenantId, [
      prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT ii.id ${from} ${sortClause(params.sort)}`),
    ])) as [{ id: string }[]];
    const ids = idRows.map((r) => r.id);
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, include: INVENTORY_EXPORT_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    items = ids.map((id) => byId.get(id)).filter((r): r is ExportRow => Boolean(r));
  } else {
    const where = buildInventoryWhere({
      q,
      warehouseId: params.warehouseId,
      categoryId: params.categoryId,
      allowedWarehouseIds: params.allowedWarehouseIds,
    });
    const orderBy: Prisma.InventoryItemOrderByWithRelationInput =
      params.sort === "quantity-asc" ? { quantityOnHand: "asc" } : params.sort === "quantity-desc" ? { quantityOnHand: "desc" } : { updatedAt: "desc" };
    items = await prisma.inventoryItem.findMany({ where, include: INVENTORY_EXPORT_INCLUDE, orderBy });
  }

  return items.map((i) => {
    const product = i.product ?? i.variation?.product ?? null;
    const category = i.product?.category ?? i.variation?.product.category ?? null;
    const threshold = product?.lowStockThreshold ?? 0;
    const available = availableStock(i);
    const status: StockStatusLabel = available <= 0 ? "Rupture" : i.quantityOnHand <= threshold ? "Stock faible" : "OK";
    const barcode = i.product?.barcodes[0]?.code ?? i.variation?.barcodes[0]?.code ?? null;
    return {
      productName: product?.name ?? "—",
      variantLabel: i.variation ? variantLabel(i.variation.attributes) : null,
      reference: product?.reference ?? null,
      sku: i.variation?.sku ?? product?.sku ?? "—",
      barcode,
      categoryName: category?.name ?? null,
      warehouseName: i.warehouse.name,
      quantityOnHand: i.quantityOnHand,
      quantityReserved: i.quantityReserved,
      available,
      quantityDamaged: i.quantityDamaged,
      stockStatus: status,
    };
  });
}

/**
 * `warehouseIds` restricts the count to those locations (an empty list counts
 * nothing — default-deny, never "all"); omitted, the count is tenant-wide
 * exactly as before. Callers holding a viewer should use
 * `getLowStockCountForViewer` below rather than building the list themselves.
 */
export async function getLowStockCount(opts: { warehouseIds?: readonly string[] } = {}): Promise<number> {
  if (opts.warehouseIds && opts.warehouseIds.length === 0) return 0;
  // Raw cross-join count — cannot go through the tenant extension, so it
  // carries its own `ii."tenantId"` predicate instead (Phase 3 —
  // docs/adr/0025, closing the ADR 0024 "Known bypass").
  const tenantId = await resolveActiveTenantIdForRawSql("queries/inventory.getLowStockCount");
  const locationFilter = opts.warehouseIds
    ? Prisma.sql`AND ii."warehouseId" IN (${Prisma.join([...opts.warehouseIds])})`
    : Prisma.empty;
  const [rows] = (await runRawBatchWithTenant(tenantId, [
    prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*)::bigint AS count ${lowStockFrom(tenantId)} ${locationFilter}`
    ),
  ])) as [{ count: bigint }[]];
  return Number(rows[0]?.count ?? 0);
}

/**
 * Dashboard low-stock KPI, location-aware (Phase 4A, G5 — docs/adr/0042).
 * OWNER/ADMIN: tenant-wide, unchanged. Everyone else: only their assigned
 * ACTIVE locations (`listAccessibleActiveWarehouses`, the same primitive as
 * `getStockOverview` just below) — zero assignments means 0, never "all".
 */
export async function getLowStockCountForViewer(user: Parameters<typeof listAccessibleActiveWarehouses>[0]): Promise<number> {
  if (hasGlobalLocationAccess(user.role)) return getLowStockCount();
  const warehouses = await listAccessibleActiveWarehouses(user);
  return getLowStockCount({ warehouseIds: warehouses.map((w) => w.id) });
}

export interface StockOverview {
  onHand: number;
  reserved: number;
  available: number;
}

/**
 * Dashboard "Stock physique / Réservé / Disponible" KPI (Batch 9, Group 10).
 * Purely operational quantities — no monetary valuation (costing/COGS/FIFO
 * are deferred, unchanged by this). Scoped through the SAME authorization
 * primitive every other location-scoped surface already uses
 * (`listAccessibleActiveWarehouses`, docs/adr/0037): OWNER/ADMIN see every
 * active warehouse, anyone else sees only their own assigned set, and zero
 * assignments means zero stock shown — never "all", matching the existing
 * default-deny posture. No new query architecture, just this one aggregate
 * restricted to the same warehouse id list.
 */
export async function getStockOverview(user: Parameters<typeof listAccessibleActiveWarehouses>[0]): Promise<StockOverview> {
  const warehouses = await listAccessibleActiveWarehouses(user);
  if (warehouses.length === 0) return { onHand: 0, reserved: 0, available: 0 };
  const sums = await prisma.inventoryItem.aggregate({
    where: { warehouseId: { in: warehouses.map((w) => w.id) } },
    _sum: { quantityOnHand: true, quantityReserved: true },
  });
  const onHand = sums._sum.quantityOnHand ?? 0;
  const reserved = sums._sum.quantityReserved ?? 0;
  return { onHand, reserved, available: Math.max(0, onHand - reserved) };
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
