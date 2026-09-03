import "server-only";

import { Prisma, type TransferStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { availableStock } from "@/lib/inventory";

const TRANSFER_STATUSES: TransferStatus[] = ["BROUILLON", "EN_TRANSIT", "RECU", "ANNULE"];

const PAGE_SIZE = 25;

/** Paginated transfer list for /transferts, newest first. */
export async function listStockTransfers(params: { status?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const where: Prisma.StockTransferWhereInput =
    params.status && (TRANSFER_STATUSES as string[]).includes(params.status)
      ? { status: params.status as TransferStatus }
      : {};

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

export async function getStockTransferDetail(id: string) {
  return prisma.stockTransfer.findUnique({
    where: { id },
    include: {
      source: { select: { id: true, name: true, type: true, isActive: true } },
      destination: { select: { id: true, name: true, type: true, isActive: true } },
      createdBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      lines: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { name: true, sku: true } },
          variation: { select: { sku: true, attributes: true, product: { select: { name: true } } } },
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
export async function listStockAtWarehouse(warehouseId: string) {
  const items = await prisma.inventoryItem.findMany({
    where: { warehouseId, quantityOnHand: { gt: 0 } },
    include: {
      product: { select: { name: true, sku: true } },
      variation: { select: { sku: true, attributes: true, product: { select: { name: true } } } },
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
  }));
}
