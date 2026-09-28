import "server-only";

import { Prisma, type ReceptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSupplierBalance } from "@/lib/receptions";
import { variantLabel } from "@/lib/catalog/lookup";

/** Suppliers & receptions reads — docs/adr/0040. Permission-gated by the pages (`suppliers.view` / `purchases.view`). */

const PAGE_SIZE = 20;
const zero = () => new Prisma.Decimal(0);

export async function listSuppliers(params: { q?: string; page?: number } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.SupplierWhereInput = params.q
    ? { OR: [{ name: { contains: params.q, mode: "insensitive" } }, { phone: { contains: params.q } }] }
    : {};
  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.supplier.count({ where }),
  ]);
  const ids = suppliers.map((s) => s.id);
  // Balances DERIVED in two grouped queries — never a query per row.
  const [received, paid, activity] = await Promise.all([
    prisma.reception.groupBy({ by: ["supplierId"], where: { supplierId: { in: ids }, status: "VALIDEE" }, _sum: { totalCost: true } }),
    prisma.supplierPayment.groupBy({ by: ["supplierId"], where: { supplierId: { in: ids } }, _sum: { amount: true } }),
    // Batch 14 — "number of receptions" / "latest reception date" (a draft
    // still counts as purchasing ACTIVITY; only a cancelled one didn't
    // really happen), one grouped query, no N+1.
    prisma.reception.groupBy({
      by: ["supplierId"],
      where: { supplierId: { in: ids }, status: { not: "ANNULEE" } },
      _count: { _all: true },
      _max: { receptionDate: true },
    }),
  ]);
  const rows = suppliers.map((s) => {
    const r = received.find((x) => x.supplierId === s.id)?._sum.totalCost ?? zero();
    const p = paid.find((x) => x.supplierId === s.id)?._sum.amount ?? zero();
    const a = activity.find((x) => x.supplierId === s.id);
    return {
      ...s,
      totalReceived: r,
      totalPaid: p,
      balance: r.minus(p),
      receptionCount: a?._count._all ?? 0,
      lastReceptionDate: a?._max.receptionDate ?? null,
    };
  });
  return { suppliers: rows, total, page, pageSize: PAGE_SIZE };
}

export async function getSupplierDetail(id: string) {
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) return null;
  const [receptions, payments, balance] = await Promise.all([
    prisma.reception.findMany({
      where: { supplierId: id },
      orderBy: { receptionDate: "desc" },
      take: 50,
      include: { payments: { select: { amount: true } }, warehouse: { select: { name: true } } },
    }),
    prisma.supplierPayment.findMany({
      where: { supplierId: id },
      orderBy: { paidAt: "desc" },
      take: 50,
      include: { reception: { select: { receptionNumber: true, displayNumber: true } } },
    }),
    getSupplierBalance(id),
  ]);
  return {
    supplier,
    balance,
    payments,
    receptions: receptions.map((r) => ({
      ...r,
      paid: r.payments.reduce((s, p) => s.plus(p.amount), zero()),
    })),
  };
}

export async function listReceptions(params: { status?: ReceptionStatus; supplierId?: string; page?: number } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ReceptionWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.supplierId ? { supplierId: params.supplierId } : {}),
  };
  const [receptions, total] = await Promise.all([
    prisma.reception.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { supplier: { select: { name: true } }, warehouse: { select: { name: true } }, _count: { select: { lines: true } } },
    }),
    prisma.reception.count({ where }),
  ]);
  return { receptions, total, page, pageSize: PAGE_SIZE };
}

export async function getReceptionDetail(id: string) {
  return prisma.reception.findUnique({
    where: { id },
    include: {
      supplier: true,
      warehouse: { select: { id: true, name: true } },
      lines: { orderBy: { createdAt: "asc" }, include: { variation: { select: { attributes: true } } } }, // variation: only to label a variant line
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
}

export interface PurchasePriceHistoryEntry {
  date: Date;
  supplierName: string;
  unitCost: number;
  receptionId: string;
  receptionNumber: number;
  receptionDisplayNumber: number | null;
}

export interface SupplierPurchaseLine {
  date: Date;
  productName: string;
  variantLabel: string | null;
  sku: string;
  quantity: number;
  unitCost: number;
  receptionId: string;
  receptionNumber: number;
  receptionDisplayNumber: number | null;
}

/**
 * Batch 14 — "which products did we buy from this supplier, when, at what
 * cost" (line-level, unlike `getSupplierDetail`'s reception-level rows).
 * Read straight off `ReceptionLine`'s own snapshots — no new table, no join
 * back to the live Product for the name (a snapshot is what was actually
 * received, even if the product was since renamed). Only VALIDEE receptions
 * count as an actual purchase, same posture as `getPurchasePriceHistory`.
 */
export async function getSupplierPurchaseHistory(supplierId: string, limit = 30): Promise<SupplierPurchaseLine[]> {
  const lines = await prisma.receptionLine.findMany({
    where: { reception: { supplierId, status: "VALIDEE" } },
    orderBy: { reception: { receptionDate: "desc" } },
    take: limit,
    include: {
      variation: { select: { attributes: true } },
      reception: { select: { id: true, receptionNumber: true, displayNumber: true, receptionDate: true } },
    },
  });
  return lines.map((l) => ({
    date: l.reception.receptionDate,
    productName: l.nameSnapshot,
    variantLabel: variantLabel(l.variation?.attributes),
    sku: l.skuSnapshot,
    quantity: l.quantity,
    unitCost: Number(l.unitCost),
    receptionId: l.reception.id,
    receptionNumber: l.reception.receptionNumber,
    receptionDisplayNumber: l.reception.displayNumber,
  }));
}

/**
 * Purchase-price history for one sellable unit (Batch 3, Task 3) — read
 * straight off the existing `ReceptionLine`/`Reception` data, no new table.
 * Only VALIDEE receptions count as an actual purchase (a BROUILLON's price
 * is a draft, ANNULEE never happened) — same "counted" posture the
 * inventory/finance layers already use for receptions elsewhere. Newest
 * first, `limit`-capped. Does not touch `Product.cost` (the ASODITECH-owned
 * operational field) — this is historical information alongside it, never
 * a replacement for it.
 */
export async function getPurchasePriceHistory(
  ref: { productId?: string | null; variationId?: string | null },
  limit = 10
): Promise<PurchasePriceHistoryEntry[]> {
  if (!ref.productId && !ref.variationId) return [];
  const lines = await prisma.receptionLine.findMany({
    where: {
      ...(ref.variationId ? { variationId: ref.variationId } : { productId: ref.productId, variationId: null }),
      reception: { status: "VALIDEE" },
    },
    orderBy: { reception: { receptionDate: "desc" } },
    take: limit,
    include: { reception: { select: { id: true, receptionNumber: true, displayNumber: true, receptionDate: true, supplier: { select: { name: true } } } } },
  });
  return lines.map((l) => ({
    date: l.reception.receptionDate,
    supplierName: l.reception.supplier.name,
    unitCost: Number(l.unitCost),
    receptionId: l.reception.id,
    receptionNumber: l.reception.receptionNumber,
    receptionDisplayNumber: l.reception.displayNumber,
  }));
}

/** Just the most recent entry — the reception-line-entry hint (Task 3A) only needs one. */
export async function getLatestPurchasePrice(ref: { productId?: string | null; variationId?: string | null }) {
  const [latest] = await getPurchasePriceHistory(ref, 1);
  return latest ?? null;
}

/**
 * The same "last purchase" fact as `getLatestPurchasePrice`, batched for a
 * whole product page (Task 3B: the product's own price plus every
 * variation's) — one query for every unit at once instead of N+1, reduced
 * to "keep only the first (=latest, thanks to the `desc` order) row per
 * unit" in JS.
 */
export async function getLatestPurchasePricesForUnits(
  productIds: string[],
  variationIds: string[]
): Promise<Map<string, PurchasePriceHistoryEntry>> {
  if (productIds.length === 0 && variationIds.length === 0) return new Map();
  const lines = await prisma.receptionLine.findMany({
    where: {
      reception: { status: "VALIDEE" },
      OR: [
        ...(productIds.length > 0 ? [{ productId: { in: productIds }, variationId: null }] : []),
        ...(variationIds.length > 0 ? [{ variationId: { in: variationIds } }] : []),
      ],
    },
    orderBy: { reception: { receptionDate: "desc" } },
    include: { reception: { select: { id: true, receptionNumber: true, displayNumber: true, receptionDate: true, supplier: { select: { name: true } } } } },
  });
  const byUnit = new Map<string, PurchasePriceHistoryEntry>();
  for (const l of lines) {
    const key = l.variationId ?? l.productId!;
    if (byUnit.has(key)) continue; // already have a more recent row for this unit
    byUnit.set(key, {
      date: l.reception.receptionDate,
      supplierName: l.reception.supplier.name,
      unitCost: Number(l.unitCost),
      receptionId: l.reception.id,
      receptionNumber: l.reception.receptionNumber,
      receptionDisplayNumber: l.reception.displayNumber,
    });
  }
  return byUnit;
}
