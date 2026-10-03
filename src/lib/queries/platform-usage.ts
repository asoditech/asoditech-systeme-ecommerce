import "server-only";

import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";

/**
 * Per-customer usage for `/platform/utilisation` (docs/adr/0053). Platform
 * pages only — callers are behind `requirePlatformAdmin`.
 *
 * Cost: ONE `GROUP BY tenantId` per table (never a per-tenant loop), each on
 * an indexed `tenantId`, plus three 30-day growth counts and one catalog
 * query for real table sizes. The result is memoised in-process for
 * CACHE_TTL_MS, so reloading the page does not re-scan every table; `fresh`
 * forces a recompute.
 *
 * DB footprint: Postgres can report the REAL size of each table and of the
 * whole database (`pg_total_relation_size`, `pg_database_size`), but not a
 * real per-tenant byte count. So sizes are shown per table / for the whole
 * database, and per-tenant usage is shown as row counts — never as an
 * invented per-tenant size.
 */

export const USAGE_METRICS = [
  { key: "users", label: "Utilisateurs actifs", module: "Équipe" },
  { key: "products", label: "Produits", module: "Catalogue" },
  { key: "variations", label: "Variations", module: "Catalogue" },
  { key: "warehouses", label: "Emplacements", module: "Stock" },
  { key: "inventoryItems", label: "Articles en stock", module: "Stock" },
  { key: "orders", label: "Commandes", module: "Commandes en ligne" },
  { key: "sales", label: "Ventes magasin", module: "Magasin" },
  { key: "customers", label: "Clients", module: "Clients" },
  { key: "suppliers", label: "Fournisseurs", module: "Achats" },
  { key: "receptions", label: "Réceptions", module: "Achats" },
  { key: "shipments", label: "Expéditions", module: "Livraison" },
  { key: "returns", label: "Retours", module: "Retours" },
] as const;
export type UsageMetricKey = (typeof USAGE_METRICS)[number]["key"];

export interface TenantUsageRow {
  tenantId: string;
  counts: Record<UsageMetricKey, number>;
  /** Rows created in the last 30 days — what is growing. */
  last30d: { orders: number; sales: number; movements: number };
  totalRows: number;
}

export interface PlatformUsageSnapshot {
  computedAt: Date;
  rows: Map<string, TenantUsageRow>;
  /** Sum per metric across tenants — which modules are used most. */
  moduleTotals: { key: UsageMetricKey; label: string; module: string; total: number; tenantsUsing: number }[];
  /** Real sizes from the Postgres catalog; null when the role may not read them. */
  database: { totalBytes: number; tables: { table: string; bytes: number }[] } | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: PlatformUsageSnapshot | null = null;

type Groups = { tenantId: string; _count: number }[];
const toMap = (groups: Groups) => new Map(groups.map((g) => [g.tenantId, g._count]));

async function computeSnapshot(): Promise<PlatformUsageSnapshot> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const g = (p: Promise<unknown>) => p as Promise<Groups>;
  const [
    users, products, variations, warehouses, inventoryItems, orders, sales, customers, suppliers, receptions, shipments,
    orderReturns, saleReturns, orders30, sales30, movements30,
  ] = await runUnscoped("platform:usage", () =>
    Promise.all([
      g(prismaBase.user.groupBy({ by: ["tenantId"], where: { status: "ACTIVE" }, _count: true })),
      g(prismaBase.product.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.productVariation.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.warehouse.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.inventoryItem.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.order.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.sale.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.customer.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.supplier.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.reception.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.shipment.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.orderReturn.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.saleReturn.groupBy({ by: ["tenantId"], _count: true })),
      g(prismaBase.order.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _count: true })),
      g(prismaBase.sale.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _count: true })),
      g(prismaBase.inventoryMovement.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _count: true })),
    ])
  );

  const maps: Record<UsageMetricKey, Map<string, number>> = {
    users: toMap(users),
    products: toMap(products),
    variations: toMap(variations),
    warehouses: toMap(warehouses),
    inventoryItems: toMap(inventoryItems),
    orders: toMap(orders),
    sales: toMap(sales),
    customers: toMap(customers),
    suppliers: toMap(suppliers),
    receptions: toMap(receptions),
    shipments: toMap(shipments),
    returns: new Map(),
  };
  for (const r of [...orderReturns, ...saleReturns]) maps.returns.set(r.tenantId, (maps.returns.get(r.tenantId) ?? 0) + r._count);
  const o30 = toMap(orders30);
  const s30 = toMap(sales30);
  const m30 = toMap(movements30);

  const tenantIds = new Set<string>();
  for (const m of Object.values(maps)) for (const id of m.keys()) tenantIds.add(id);
  const rows = new Map<string, TenantUsageRow>();
  for (const tenantId of tenantIds) {
    const counts = Object.fromEntries(USAGE_METRICS.map((m) => [m.key, maps[m.key].get(tenantId) ?? 0])) as Record<UsageMetricKey, number>;
    rows.set(tenantId, {
      tenantId,
      counts,
      last30d: { orders: o30.get(tenantId) ?? 0, sales: s30.get(tenantId) ?? 0, movements: m30.get(tenantId) ?? 0 },
      totalRows: Object.values(counts).reduce((n, v) => n + v, 0),
    });
  }

  const moduleTotals = USAGE_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    module: m.module,
    total: [...maps[m.key].values()].reduce((n, v) => n + v, 0),
    tenantsUsing: [...maps[m.key].values()].filter((v) => v > 0).length,
  })).sort((a, b) => b.total - a.total);

  let database: PlatformUsageSnapshot["database"] = null;
  try {
    // Catalog functions only — no tenant table rows are read here.
    const [size] = await prismaBase.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database())::bigint AS bytes`;
    const tables = await prismaBase.$queryRaw<{ table: string; bytes: bigint }[]>`
      SELECT c.relname AS "table", pg_total_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY bytes DESC LIMIT 10`;
    database = { totalBytes: Number(size.bytes), tables: tables.map((t) => ({ table: t.table, bytes: Number(t.bytes) })) };
  } catch {
    database = null;
  }

  return { computedAt: new Date(), rows, moduleTotals, database };
}

export async function getPlatformUsage(opts: { fresh?: boolean } = {}): Promise<PlatformUsageSnapshot> {
  if (!opts.fresh && cached && Date.now() - cached.computedAt.getTime() < CACHE_TTL_MS) return cached;
  cached = await computeSnapshot();
  return cached;
}

/** One tenant's users for the platform owner (no password data, ever). */
export async function listTenantUsersForPlatform(tenantId: string) {
  return runUnscoped("platform:tenant-users", () =>
    prismaBase.user.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, isPlatformAdmin: true },
      orderBy: [{ status: "asc" }, { role: "asc" }, { email: "asc" }],
    })
  );
}
