import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma, CustomerSegment, RecordSource } from "@prisma/client";

const PAGE_SIZE = 20;

export type CustomerSort = "recent" | "name" | "orders";

export interface CustomerListFilters {
  q?: string;
  segment?: CustomerSegment;
  source?: RecordSource;
  city?: string;
  sort?: CustomerSort;
  page?: number;
}

export async function listCustomers(params: CustomerListFilters) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.CustomerWhereInput = {
    ...(params.q
      ? {
          OR: [
            { fullName: { contains: params.q, mode: "insensitive" } },
            { phone: { contains: params.q, mode: "insensitive" } },
            { whatsapp: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(params.segment ? { segment: params.segment } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(params.city ? { city: { contains: params.city, mode: "insensitive" } } : {}),
  };

  const orderBy: Prisma.CustomerOrderByWithRelationInput =
    params.sort === "name"
      ? { fullName: "asc" }
      : params.sort === "orders"
        ? { orders: { _count: "desc" } }
        : { createdAt: "desc" };

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { _count: { select: { orders: true } } },
    }),
    prisma.customer.count({ where }),
  ]);

  return { customers, total, page, pageSize: PAGE_SIZE };
}

/**
 * Order stats are computed on read, never stored — see docs/adr/0002. Only
 * DELIVERED/paid orders that aren't cancelled count toward spend, since a
 * cancelled order was never real revenue.
 */
export async function getCustomerStats(customerId: string) {
  const [aggregate, firstOrder, lastOrder, returnedCount, cancelledCount] = await Promise.all([
    prisma.order.aggregate({
      where: { customerId, status: { notIn: ["ANNULEE", "ECHEC"] } },
      _sum: { total: true },
      _count: true,
      _avg: { total: true },
    }),
    prisma.order.findFirst({ where: { customerId }, orderBy: { placedAt: "asc" }, select: { placedAt: true } }),
    prisma.order.findFirst({ where: { customerId }, orderBy: { placedAt: "desc" }, select: { placedAt: true } }),
    prisma.order.count({ where: { customerId, status: { in: ["RETOUR", "REMBOURSEE"] } } }),
    prisma.order.count({ where: { customerId, status: "ANNULEE" } }),
  ]);

  return {
    totalSpent: aggregate._sum.total ?? null,
    ordersCount: aggregate._count,
    avgOrderValue: aggregate._avg.total ?? null,
    firstOrderAt: firstOrder?.placedAt ?? null,
    lastOrderAt: lastOrder?.placedAt ?? null,
    returnedOrders: returnedCount,
    cancelledOrders: cancelledCount,
  };
}

export async function getCustomerDetail(id: string) {
  return prisma.customer.findUnique({
    where: { id },
    include: {
      addresses: { orderBy: { isDefault: "desc" } },
      orders: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
}
