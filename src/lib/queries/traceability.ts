import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lookupSellableUnits, type SellableUnit } from "@/lib/catalog/lookup";
import { movementScopeWhere } from "@/lib/auth/movement-scope";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Product / variant traceability — docs/adr/0038 (§ledger hardening) and 0040.
 *
 * For ONE sellable unit: its identity (reference, barcodes, category), where
 * its stock physically is right now, and its complete movement history from the
 * single ledger — each row with the location, signed effect, running balance,
 * cost, actor and the SOURCE DOCUMENT (reception, sale, sale return, transfer,
 * stocktake, order, order return). There is no second history table: this is a
 * read over `InventoryMovement`, scoped to what the viewer's channels allow.
 *
 * Provenance before the cut-over is NOT reconstructed: legacy movements have no
 * signed delta / balance / document, and are flagged (`legacy`) rather than
 * given an invented origin.
 */

type Viewer = Pick<CurrentUser, "channels">;

export interface TraceUnit {
  unit: SellableUnit;
  barcodes: { code: string; isPrimary: boolean }[];
}

/** Barcode → reference → name lookup, for the search box. */
export async function findTraceUnits(query: string): Promise<SellableUnit[]> {
  return lookupSellableUnits(prisma, query, { onlyActive: false, limit: 15 });
}

export type MovementDocument =
  | { kind: "reception"; label: string; href: string; extra: string | null }
  | { kind: "sale"; label: string; href: string; extra: string | null }
  | { kind: "sale_return"; label: string; href: string; extra: string | null }
  | { kind: "transfer"; label: string; href: string; extra: null }
  | { kind: "stocktake"; label: string; href: string; extra: null }
  | { kind: "order"; label: string; href: string; extra: null }
  | { kind: "order_return"; label: string; href: string; extra: null };

export async function getUnitTraceability(viewer: Viewer, ref: { productId: string; variationId: string | null }) {
  const itemWhere: Prisma.InventoryItemWhereInput = ref.variationId ? { variationId: ref.variationId } : { productId: ref.productId, variationId: null };

  const [product, variation, items] = await Promise.all([
    prisma.product.findUnique({
      where: { id: ref.productId },
      include: { category: { select: { name: true } }, barcodes: { where: { variationId: null }, orderBy: { isPrimary: "desc" } } },
    }),
    ref.variationId ? prisma.productVariation.findUnique({ where: { id: ref.variationId }, include: { barcodes: { orderBy: { isPrimary: "desc" } } } }) : null,
    prisma.inventoryItem.findMany({ where: itemWhere, include: { warehouse: { select: { id: true, name: true, type: true } } } }),
  ]);
  if (!product) return null;

  const itemIds = items.map((i) => i.id);
  const movements = await prisma.inventoryMovement.findMany({
    where: { inventoryItemId: { in: itemIds }, ...movementScopeWhere(viewer.channels) },
    orderBy: { createdAt: "desc" },
    take: 300,
    include: {
      warehouse: { select: { name: true } },
      performedBy: { select: { name: true } },
      receptionLine: { include: { reception: { include: { supplier: { select: { name: true } } } } } },
      sale: { select: { id: true, saleNumber: true, displayNumber: true } },
      saleReturn: { select: { id: true, returnNumber: true, displayNumber: true } },
      stockTransfer: { select: { id: true, transferNumber: true, displayNumber: true } },
      stocktakeSession: { select: { id: true, sessionNumber: true, displayNumber: true } },
      order: { select: { id: true, orderNumber: true, displayNumber: true } },
      orderReturn: { select: { id: true, orderId: true } },
    },
  });

  const totals = await prisma.inventoryMovement.groupBy({
    by: ["type"],
    where: { inventoryItemId: { in: itemIds }, ...movementScopeWhere(viewer.channels) },
    _sum: { quantity: true },
    _count: true,
  });

  return {
    identity: {
      name: product.name,
      variantAttributes: (variation?.attributes as Record<string, string> | null) ?? null,
      sku: variation?.sku ?? product.sku,
      reference: product.reference,
      category: product.category?.name ?? null,
      status: product.status,
      barcodes: (variation ? variation.barcodes : product.barcodes).map((b) => ({ code: b.code, isPrimary: b.isPrimary })),
    },
    stock: items.map((i) => ({
      warehouseId: i.warehouse.id,
      warehouseName: i.warehouse.name,
      warehouseType: i.warehouse.type,
      onHand: i.quantityOnHand,
      reserved: i.quantityReserved,
      damaged: i.quantityDamaged,
      available: Math.max(0, i.quantityOnHand - i.quantityReserved),
    })),
    totalsByType: totals.map((t) => ({ type: t.type, quantity: t._sum.quantity ?? 0, count: t._count })),
    movements: movements.map((m) => ({
      id: m.id,
      at: m.createdAt,
      type: m.type,
      quantity: m.quantity,
      /** null = a pre-cut-over movement: no signed delta was recorded. */
      onHandDelta: m.onHandDelta,
      onHandAfter: m.onHandAfter,
      unitCost: m.unitCost ? Number(m.unitCost) : null,
      location: m.warehouse.name,
      actor: m.performedBy?.name ?? m.performedByName ?? null,
      reason: m.reason,
      legacy: m.onHandDelta === null,
      document: documentOf(m),
    })),
  };
}

const pad = (n: number) => n.toString().padStart(6, "0");

function documentOf(m: {
  receptionLine: { reception: { id: string; receptionNumber: number; displayNumber: number | null; supplier: { name: string } } } | null;
  sale: { id: string; saleNumber: number; displayNumber: number | null } | null;
  saleReturn: { id: string; returnNumber: number; displayNumber: number | null } | null;
  stockTransfer: { id: string; transferNumber: number; displayNumber: number | null } | null;
  stocktakeSession: { id: string; sessionNumber: number; displayNumber: number | null } | null;
  order: { id: string; orderNumber: number; displayNumber: number | null } | null;
  orderReturn: { id: string; orderId: string } | null;
}): MovementDocument | null {
  if (m.receptionLine) {
    const r = m.receptionLine.reception;
    return { kind: "reception", label: `REC-${pad(r.displayNumber ?? r.receptionNumber)}`, href: `/receptions/${r.id}`, extra: r.supplier.name };
  }
  if (m.saleReturn) return { kind: "sale_return", label: `RTM-${pad(m.saleReturn.displayNumber ?? m.saleReturn.returnNumber)}`, href: m.sale ? `/ventes/${m.sale.id}` : "/ventes", extra: m.sale ? `VTE-${pad(m.sale.displayNumber ?? m.sale.saleNumber)}` : null };
  if (m.sale) return { kind: "sale", label: `VTE-${pad(m.sale.displayNumber ?? m.sale.saleNumber)}`, href: `/ventes/${m.sale.id}`, extra: null };
  if (m.stockTransfer) return { kind: "transfer", label: `TR-${pad(m.stockTransfer.displayNumber ?? m.stockTransfer.transferNumber)}`, href: `/transferts/${m.stockTransfer.id}`, extra: null };
  if (m.stocktakeSession) return { kind: "stocktake", label: `INV-${pad(m.stocktakeSession.displayNumber ?? m.stocktakeSession.sessionNumber)}`, href: `/inventaires/${m.stocktakeSession.id}`, extra: null };
  if (m.orderReturn && m.order) return { kind: "order_return", label: `Retour CMD-${pad(m.order.displayNumber ?? m.order.orderNumber)}`, href: `/commandes/${m.order.id}`, extra: null };
  if (m.order) return { kind: "order", label: `CMD-${pad(m.order.displayNumber ?? m.order.orderNumber)}`, href: `/commandes/${m.order.id}`, extra: null };
  return null;
}
