import "server-only";

import { prisma } from "@/lib/prisma";

const PAGE_SIZE = 25;

export async function listInventoryItems(params: { lowStockOnly?: boolean; q?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);

  const items = await prisma.inventoryItem.findMany({
    where: {
      ...(params.q
        ? {
            OR: [
              { product: { name: { contains: params.q, mode: "insensitive" } } },
              { product: { sku: { contains: params.q, mode: "insensitive" } } },
              { variation: { sku: { contains: params.q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: { product: true, variation: { include: { product: true } }, warehouse: true },
    orderBy: { updatedAt: "desc" },
  });

  const filtered = params.lowStockOnly
    ? items.filter((i) => {
        const threshold = i.product?.lowStockThreshold ?? i.variation?.product.lowStockThreshold ?? 0;
        return i.quantityOnHand <= threshold;
      })
    : items;

  const total = filtered.length;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return { items: paged, total, page, pageSize: PAGE_SIZE };
}

export async function getLowStockCount() {
  const items = await prisma.inventoryItem.findMany({
    include: { product: true, variation: { include: { product: true } } },
  });
  return items.filter((i) => {
    const threshold = i.product?.lowStockThreshold ?? i.variation?.product.lowStockThreshold ?? Infinity;
    return i.quantityOnHand <= threshold;
  }).length;
}

export async function listWarehouses() {
  return prisma.warehouse.findMany({ orderBy: { name: "asc" } });
}

export async function getInventoryMovements(inventoryItemId: string, take = 20) {
  return prisma.inventoryMovement.findMany({
    where: { inventoryItemId },
    orderBy: { createdAt: "desc" },
    take,
    include: { performedBy: { select: { name: true } } },
  });
}
