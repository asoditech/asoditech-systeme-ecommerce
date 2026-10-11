import "server-only";

import { prisma } from "@/lib/prisma";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { exactOrderTrackingPriority, orderSearchWhere } from "@/lib/orders/search";
import { paginateWithPriority } from "@/lib/priority-pagination";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { parseZonedDay } from "@/lib/time/zoned";
import type { Prisma, OrderStatus, OrderPaymentStatus } from "@prisma/client";

const PAGE_SIZE = 25;

export interface OrderListFilters {
  status?: OrderStatus;
  paymentStatus?: OrderPaymentStatus;
  customerId?: string;
  confirmationAgentId?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  minTotal?: string;
  maxTotal?: string;
  page?: number;
  /** Rows per page — the list page passes the URL's 10/50/100; other callers keep the 25 default. */
  pageSize?: number;
}

/** Parse a numeric filter, or undefined if missing / not a finite number. */
function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function listOrders(filters: OrderListFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : PAGE_SIZE;
  // « Du / Au » are whole days of the business time zone, both inclusive
  // (parseZonedDay never lets `new Date("all")` reach Prisma).
  const timeZone = filters.dateFrom || filters.dateTo ? await getBusinessTimeZone() : undefined;
  const dateFrom = parseZonedDay(filters.dateFrom, timeZone);
  const dateTo = parseZonedDay(filters.dateTo, timeZone, true);
  const minTotal = parseNumber(filters.minTotal);
  const maxTotal = parseNumber(filters.maxTotal);
  // Shared search (src/lib/orders/search.ts): the displayed per-tenant number
  // with the tenant's prefix, external number, tracking number, recipient and
  // phone — not only the internal number. The prefix is read only when searching.
  const q = filters.q?.trim();
  const search = q
    ? orderSearchWhere(q, { prefix: (await getReportBusinessInfo()).orderNumberPrefix, includeTrackingNumber: true })
    : {};
  const where: Prisma.OrderWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.confirmationAgentId ? { confirmationAgentId: filters.confirmationAgentId } : {}),
    ...search,
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

  // An order with a shipment (current or past) whose tracking number EXACTLY
  // matches the search ranks first, across pages.
  const { rows: orders, total } = await paginateWithPriority({
    where,
    priority: exactOrderTrackingPriority(q),
    skip: (page - 1) * pageSize,
    take: pageSize,
    and: (a, b): Prisma.OrderWhereInput => ({ AND: [a, b] }),
    count: (w) => prisma.order.count({ where: w }),
    findMany: (w, skip, take) => prisma.order.findMany({
      where: w,
      // Newest order first — `placedAt` is the customer-facing order date
      // (WooCommerce/Shopify `date_created`, or `now()` for a manual
      // order), which is also the visible "Date" column and the date
      // filter, so the list stays in step with what it shows. `createdAt`
      // (local insert time) only breaks ties on a bulk import; `id` keeps
      // the order stable across pages.
      orderBy: [{ placedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
      include: {
        customer: true,
        _count: { select: { items: true, returns: true } },
        confirmationAgent: { include: { user: { select: { name: true } } } },
        // Batch 9, Group 5/8: the list's own "Canal" (En ligne, always — an
        // Order is never Offline, docs/adr/0038) and return badge, reusing
        // the SAME `returnStateLabel` the detail page already uses instead
        // of a second calculation — just fed with cheap aggregate sums here
        // instead of the detail page's per-line matching (this view never
        // needs which specific line a unit was returned from).
        salesChannel: { select: { name: true, kind: true } },
        // « Produits » column: the line snapshot name + variation options.
        items: { select: { quantity: true, nameSnapshot: true, skuSnapshot: true, variation: { select: { attributes: true } } } },
        returns: { select: { lines: { select: { quantitySellable: true, quantityDamaged: true } } } },
      },
    }),
  });

  return { orders, total, page, pageSize };
}

export async function getOrderDetail(id: string) {
  return prisma.order.findUnique({
    where: { id },
    include: {
      customer: true,
      items: {
        include: {
          // Lead photo only — ProductImage has no per-variation image, so
          // a variation line's preview also uses its parent product's.
          product: { include: { images: { take: 1, orderBy: { position: "asc" } } } },
          // Parent gallery too: a variation line falls back to it when the
          // variation has no image of its own (src/lib/catalog/unit-image.ts).
          variation: { include: { product: { select: { images: { take: 1, orderBy: { position: "asc" } } } } } },
        },
      },
      refunds: { orderBy: { createdAt: "desc" } },
      shipments: { include: { provider: true }, orderBy: { createdAt: "desc" } },
      createdBy: true,
      packedBy: { select: { name: true } },
      // Business channel (docs/adr/0038) — deliberately separate from
      // `fulfillmentWarehouse` below: SalesChannel is NOT a Location. Batch
      // 12: the order list already showed this (listOrders, Batch 9); the
      // detail page's own query never fetched it, so it was invisible here.
      salesChannel: { select: { name: true, kind: true } },
      fulfillmentWarehouse: { select: { name: true, type: true } },
      returns: {
        orderBy: { createdAt: "desc" },
        include: {
          receivedBy: { select: { name: true } },
          lines: { include: { warehouse: { select: { name: true } } } },
        },
      },
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
