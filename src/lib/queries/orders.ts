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

/** Parse a value from a query string into a Date, or undefined if it is
 * missing or not a real date — never let `new Date("all")` reach Prisma. */
function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const d = new Date(endOfDay ? `${value}T23:59:59` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Parse a numeric filter, or undefined if missing / not a finite number. */
function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function listOrders(filters: OrderListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const dateFrom = parseDate(filters.dateFrom);
  const dateTo = parseDate(filters.dateTo, true);
  const minTotal = parseNumber(filters.minTotal);
  const maxTotal = parseNumber(filters.maxTotal);
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
    ...(dateFrom || dateTo
      ? {
          // The customer-facing order date, not the sync import time.
          placedAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
    ...(minTotal !== undefined || maxTotal !== undefined
      ? {
          total: {
            ...(minTotal !== undefined ? { gte: minTotal } : {}),
            ...(maxTotal !== undefined ? { lte: maxTotal } : {}),
          },
        }
      : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { placedAt: "desc" },
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
