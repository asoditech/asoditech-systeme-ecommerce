import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * In-store sales reads — docs/adr/0040. EVERY query is ROW-scoped by the
 * viewer's OFFLINE channels (`saleChannelWhere`, docs/adr/0039): a user
 * assigned to one store never reads another store's sales, and a user with no
 * OFFLINE channel gets nothing — the scope is applied here, in the query, not
 * left to the page to remember.
 */

type Viewer = Pick<CurrentUser, "channels">;
const PAGE_SIZE = 20;

export interface SaleListFilters {
  q?: string;
  salesChannelId?: string;
  from?: Date;
  to?: Date;
  page?: number;
}

export async function listSales(viewer: Viewer, filters: SaleListFilters = {}) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.SaleWhereInput = {
    ...saleChannelWhere(viewer),
    ...(filters.salesChannelId ? { salesChannelId: filters.salesChannelId } : {}),
    ...(filters.from || filters.to ? { soldAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } } : {}),
    ...(filters.q
      ? {
          OR: [
            { customerLabel: { contains: filters.q, mode: "insensitive" } },
            { soldByName: { contains: filters.q, mode: "insensitive" } },
            { lines: { some: { OR: [{ nameSnapshot: { contains: filters.q, mode: "insensitive" } }, { skuSnapshot: { contains: filters.q, mode: "insensitive" } }, { barcodeSnapshot: { contains: filters.q } }] } } },
          ],
        }
      : {}),
  };
  const [sales, total] = await Promise.all([
    prisma.sale.findMany({
      where,
      orderBy: { soldAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        salesChannel: { select: { name: true } },
        warehouse: { select: { name: true } },
        payments: { select: { method: true, amount: true } },
        _count: { select: { lines: true, returns: true } },
      },
    }),
    prisma.sale.count({ where }),
  ]);
  return { sales, total, page, pageSize: PAGE_SIZE };
}

export async function getSaleDetail(viewer: Viewer, id: string) {
  return prisma.sale.findFirst({
    where: { id, ...saleChannelWhere(viewer) },
    include: {
      salesChannel: { select: { id: true, name: true } },
      warehouse: { select: { id: true, name: true } },
      customer: { select: { id: true, fullName: true } },
      // `variation` is read only to LABEL a variant line on the document (the size/colour);
      // the stored snapshots are unchanged.
      lines: { orderBy: { createdAt: "asc" }, include: { variation: { select: { attributes: true } }, returnLines: { select: { quantitySellable: true, quantityDamaged: true } } } },
      payments: { orderBy: { createdAt: "asc" } },
      returns: { orderBy: { receivedAt: "desc" }, include: { lines: true } },
    },
  });
}
