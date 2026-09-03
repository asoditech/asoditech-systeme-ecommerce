import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma, OrderStatus, OrderPaymentStatus } from "@prisma/client";

const PAGE_SIZE = 25;

export interface OrderListFilters {
  status?: OrderStatus;
  paymentStatus?: OrderPaymentStatus;
  customerId?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  minTotal?: string;
  maxTotal?: string;
  page?: number;
}

export async function listOrders(filters: OrderListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Prisma.OrderWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.q
      ? {
          OR: [
            { customer: { fullName: { contains: filters.q, mode: "insensitive" } } },
            { customer: { phone: { contains: filters.q, mode: "insensitive" } } },
            ...(Number.isFinite(Number(filters.q)) ? [{ orderNumber: Number(filters.q) }] : []),
          ],
        }
      : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
            ...(filters.dateTo ? { lte: new Date(filters.dateTo + "T23:59:59") } : {}),
          },
        }
      : {}),
    ...(filters.minTotal || filters.maxTotal
      ? {
          total: {
            ...(filters.minTotal ? { gte: Number(filters.minTotal) } : {}),
            ...(filters.maxTotal ? { lte: Number(filters.maxTotal) } : {}),
          },
        }
      : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { customer: true, _count: { select: { items: true } } },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, page, pageSize: PAGE_SIZE };
}

export async function getOrderDetail(id: string) {
  return prisma.order.findUnique({
    where: { id },
    include: {
      customer: true,
      items: { include: { product: true, variation: true } },
      refunds: { orderBy: { createdAt: "desc" } },
      shipments: { include: { provider: true }, orderBy: { createdAt: "desc" } },
      createdBy: true,
      fulfillmentWarehouse: { select: { name: true, type: true } },
    },
  });
}

export async function getOrderAuditTimeline(orderId: string) {
  return prisma.auditEvent.findMany({
    where: { entityType: "Order", entityId: orderId },
    orderBy: { createdAt: "desc" },
    include: { actorUser: { select: { name: true } } },
  });
}

export async function getOrdersRequiringAction() {
  return prisma.order.findMany({
    where: { status: { in: ["NOUVELLE", "CONFIRMEE"] } },
    orderBy: { createdAt: "asc" },
    take: 8,
    include: { customer: true },
  });
}
