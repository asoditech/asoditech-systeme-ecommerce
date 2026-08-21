import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

const PAGE_SIZE = 20;

export async function listCustomers(params: { q?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.CustomerWhereInput = params.q
    ? {
        OR: [
          { fullName: { contains: params.q, mode: "insensitive" } },
          { phone: { contains: params.q, mode: "insensitive" } },
          { whatsapp: { contains: params.q, mode: "insensitive" } },
          { email: { contains: params.q, mode: "insensitive" } },
        ],
      }
    : {};

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
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
    prisma.order.findFirst({ where: { customerId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.order.findFirst({ where: { customerId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.order.count({ where: { customerId, status: { in: ["RETOUR", "REMBOURSEE"] } } }),
    prisma.order.count({ where: { customerId, status: "ANNULEE" } }),
  ]);

  return {
    totalSpent: aggregate._sum.total ?? null,
    ordersCount: aggregate._count,
    avgOrderValue: aggregate._avg.total ?? null,
    firstOrderAt: firstOrder?.createdAt ?? null,
    lastOrderAt: lastOrder?.createdAt ?? null,
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
