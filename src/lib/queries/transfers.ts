import "server-only";

import { Prisma, type TransferStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { availableStock } from "@/lib/inventory";
import { readableWarehouseIds } from "@/lib/auth/location-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Location read scope (docs/adr/0050): a scoped viewer reads only transfers
 * touching one of their locations (source OR destination). Omitted =
 * tenant-wide (non-page callers); every page passes its viewer.
 */
type LocationViewer = Pick<CurrentUser, "locations">;
function transferScope(viewer?: LocationViewer): Prisma.StockTransferWhereInput {
  const ids = viewer ? readableWarehouseIds(viewer) : null;
  return ids === null ? {} : { OR: [{ sourceWarehouseId: { in: ids } }, { destinationWarehouseId: { in: ids } }] };
}

const TRANSFER_STATUSES: TransferStatus[] = ["BROUILLON", "EN_TRANSIT", "RECU", "ANNULE"];

const PAGE_SIZE = 25;

/** Paginated transfer list for /transferts, newest first. */
export async function listStockTransfers(params: { status?: string; page?: number }, viewer?: LocationViewer) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const where: Prisma.StockTransferWhereInput = {
    ...(params.status && (TRANSFER_STATUSES as string[]).includes(params.status) ? { status: params.status as TransferStatus } : {}),
    ...transferScope(viewer),
  };

  const [transfers, total] = await Promise.all([
    prisma.stockTransfer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
      include: {
        source: { select: { name: true } },
        destination: { select: { name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.stockTransfer.count({ where }),
  ]);

  return { transfers, total, page, pageSize: PAGE_SIZE };
}

export async function getStockTransferDetail(id: string, viewer?: LocationViewer) {
  return prisma.stockTransfer.findFirst({
    where: { id, ...transferScope(viewer) },
    include: {
      source: { select: { id: true, name: true, type: true, isActive: true } },
      destination: { select: { id: true, name: true, type: true, isActive: true } },
      createdBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      lines: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { name: true, sku: true, cost: true } },
          variation: { select: { sku: true, attributes: true, cost: true, product: { select: { name: true, cost: true } } } },
        },
      },
    },
  });
}

export async function getStockTransferAuditTimeline(id: string) {
  return prisma.auditEvent.findMany({
    where: { entityType: "StockTransfer", entityId: id },
    orderBy: { createdAt: "desc" },
    include: { actorUser: { select: { name: true } } },
  });
}

/**
 * Physically-held stock at one warehouse, for the transfer create form's
 * line picker (Phase 32b). Only rows with on-hand units — a transfer moves
 * physical stock. Any product status: an ARCHIVE product can still have
 * units to move out of a location.
 */
export async function listStockAtWarehouse(warehouseId: string, opts: { includeCost?: boolean } = {}) {
  const items = await prisma.inventoryItem.findMany({
    where: { warehouseId, quantityOnHand: { gt: 0 } },
    include: {
      product: { select: { name: true, sku: true, cost: true } },
      variation: { select: { sku: true, attributes: true, cost: true, product: { select: { name: true, cost: true } } } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return items.map((i) => ({
    productId: i.productId,
    variationId: i.variationId,
    quantityOnHand: i.quantityOnHand,
    available: availableStock(i),
    label: i.variation
      ? `${i.variation.product.name} (${Object.values(i.variation.attributes as Record<string, string>).join(", ")})`
      : (i.product?.name ?? "—"),
    sku: i.variation?.sku ?? i.product?.sku ?? "—",
    // Global purchase cost (variation → product) — finance.view data, so only
    // when the caller asked for it (docs/adr/0043). Never a selling price.
    globalCost: opts.includeCost
      ? ((i.variation ? (i.variation.cost ?? i.variation.product.cost) : i.product?.cost) ?? null)?.toString() ?? null
      : null,
  }));
}
