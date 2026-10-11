import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { availableStock, orderLineStockStates } from "@/lib/inventory";
import { lineTrackInventory, type ConfirmationStockLine } from "@/lib/stock-validation";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { orderSearchWhere } from "@/lib/orders/search";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { zonedInstant, zonedParts } from "@/lib/time/zoned";

/**
 * Reads for the order-confirmation workflow — see
 * docs/adr/0029-order-confirmation-workflow.md.
 */

const PAGE_SIZE = 30;

/** An order past this many failed call attempts is flagged in the queue. */
export const CONFIRMATION_RETRY_FLAG = 3;

/**
 * The shared confirmation queue: every NOUVELLE order. Never-called orders
 * come first (so nothing is forgotten), newest first within that group;
 * then previously-tried orders, least-recently-retried first.
 *
 * `onlyRetried` narrows the queue to orders that have already had at least
 * one attempt — the "À rappeler" tab (a follow-up call is due).
 */
export async function listOrdersAwaitingConfirmation(
  params: { page?: number; search?: string; onlyRetried?: boolean } = {}
) {
  const page = Math.max(1, params.page ?? 1);
  const q = params.search?.trim();
  // Shared search (src/lib/orders/search.ts) — a NOUVELLE order has no
  // shipment yet, so tracking numbers are not searched here.
  const search = q ? orderSearchWhere(q, { prefix: (await getReportBusinessInfo()).orderNumberPrefix }) : {};
  const where: Prisma.OrderWhereInput = {
    status: "NOUVELLE",
    ...(params.onlyRetried ? { confirmationAttemptCount: { gt: 0 } } : {}),
    ...search,
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ lastConfirmationAttemptAt: { sort: "asc", nulls: "first" } }, { placedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: true,
        _count: { select: { items: true } },
        // Batch 3, Task 8: item lines (product/variation/quantity only — no
        // name needed here) so the queue can flag a backorder without a
        // second round-trip; see `flagInsufficientStock` below.
        items: {
          select: {
            productId: true,
            variationId: true,
            quantity: true,
            // P2: the queue's stock flags need each line's stock tracking.
            product: { select: { trackInventory: true } },
            variation: { select: { product: { select: { trackInventory: true } } } },
          },
        },
        confirmationAttempts: {
          orderBy: { createdAt: "desc" },
          take: 3,
          include: { agent: { select: { name: true } } },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, page, pageSize: PAGE_SIZE };
}

/**
 * Backorder warning in the confirmation queue (Batch 3, Task 8). Since P2 the
 * confirmation itself refuses a shortage (unless an authorised override), so
 * this flag now uses the SAME rule as that check: the order's own fulfilment
 * warehouse, `max(0, onHand − reserved)`, duplicate lines aggregated — see
 * `stockFlagsForOrders`. Still read-only and batched for a whole page.
 */
export async function flagInsufficientStock(
  orders: { id: string; fulfillmentWarehouseId?: string | null; items: QueueStockLine[] }[]
): Promise<Set<string>> {
  return (await stockFlagsForOrders(orders)).insufficient;
}

type QueueStockLine = ConfirmationStockLine;

/**
 * P2 — per order, against ITS fulfilment warehouse (the same row the
 * confirmation will reserve on, not a sum over every warehouse):
 *  - `insufficient`: a tracked row whose aggregated demand exceeds
 *    `max(0, onHand − reserved)` — confirming will need an authorised override;
 *  - `untracked`: a line with no stock row there, or a product whose stock
 *    tracking is off — « Stock non suivi ».
 * Read-only and batched: one inventory query per page (orders without a
 * fulfilment warehouse — pre-32b — fall back to the per-line resolution).
 */
export async function stockFlagsForOrders(
  orders: { id: string; fulfillmentWarehouseId?: string | null; items: QueueStockLine[] }[]
): Promise<{ insufficient: Set<string>; untracked: Set<string> }> {
  const insufficient = new Set<string>();
  const untracked = new Set<string>();
  // Same rule as the confirmation check (unknown → tracked) — src/lib/stock-validation.ts.
  const tracked = lineTrackInventory;
  const unitKey = (l: { productId: string | null; variationId: string | null }) => (l.variationId ? `v:${l.variationId}` : `p:${l.productId}`);

  const withWarehouse = orders.filter((o) => o.fulfillmentWarehouseId);
  const variationIds = [...new Set(withWarehouse.flatMap((o) => o.items.map((i) => i.variationId).filter((v): v is string => Boolean(v))))];
  const productIds = [
    ...new Set(withWarehouse.flatMap((o) => o.items.filter((i) => !i.variationId && i.productId).map((i) => i.productId!))),
  ];
  const warehouseIds = [...new Set(withWarehouse.map((o) => o.fulfillmentWarehouseId!))];
  const rows =
    warehouseIds.length > 0 && (variationIds.length > 0 || productIds.length > 0)
      ? await prisma.inventoryItem.findMany({
          where: {
            warehouseId: { in: warehouseIds },
            OR: [
              ...(variationIds.length > 0 ? [{ variationId: { in: variationIds } }] : []),
              ...(productIds.length > 0 ? [{ productId: { in: productIds } }] : []),
            ],
          },
          select: { warehouseId: true, productId: true, variationId: true, quantityOnHand: true, quantityReserved: true },
        })
      : [];
  const rowByKey = new Map(rows.map((r) => [`${r.warehouseId}|${r.variationId ? `v:${r.variationId}` : `p:${r.productId}`}`, r]));

  for (const o of orders) {
    const lines = o.items.filter((i) => i.quantity > 0 && (i.productId || i.variationId));
    if (!o.fulfillmentWarehouseId) {
      const states = await orderLineStockStates(prisma, lines.map((l) => ({ ...l, trackInventory: tracked(l) })), null);
      if (states.some((st) => st.kind === "tracked" && st.short)) insufficient.add(o.id);
      if (states.some((st) => st.kind !== "tracked")) untracked.add(o.id);
      continue;
    }
    const demand = new Map<string, { requested: number; tracked: boolean }>();
    for (const l of lines) {
      const key = `${o.fulfillmentWarehouseId}|${unitKey(l)}`;
      const d = demand.get(key) ?? { requested: 0, tracked: tracked(l) };
      d.requested += l.quantity;
      demand.set(key, d);
    }
    for (const [key, d] of demand) {
      const row = rowByKey.get(key);
      if (!row || !d.tracked) {
        untracked.add(o.id);
        continue;
      }
      if (d.requested > availableStock(row)) insufficient.add(o.id);
    }
  }
  return { insufficient, untracked };
}

/** Full call-attempt history for one order (newest first) — order detail page. */
export async function getOrderConfirmationAttempts(orderId: string) {
  return prisma.orderConfirmationAttempt.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    include: { agent: { select: { name: true } } },
  });
}

/** Distinct orders with a matching confirmation attempt. */
async function countConfirmedOrders(where: Prisma.OrderConfirmationAttemptWhereInput): Promise<number> {
  const rows = await prisma.orderConfirmationAttempt.findMany({ where, distinct: ["orderId"], select: { orderId: true } });
  return rows.length;
}

/**
 * This calendar month's confirmation activity for one user — shown to a
 * confirmateur on the queue page so they see their own throughput and
 * roughly what they've earned, without exposing the full commissions area.
 */
export async function getMyConfirmationStats(userId: string) {
  const now = new Date();
  const timeZone = await getBusinessTimeZone();
  const today = zonedParts(now, timeZone);
  const monthStart = zonedInstant(timeZone, today.year, today.month, 1);

  const [confirmed, otherAttempts, agent] = await Promise.all([
    // ORDERS confirmed (distinct) — a re-confirmation after a reopen is one order.
    countConfirmedOrders({ agentUserId: userId, outcome: "CONFIRME", createdAt: { gte: monthStart } }),
    prisma.orderConfirmationAttempt.count({
      where: { agentUserId: userId, outcome: { not: "CONFIRME" }, createdAt: { gte: monthStart } },
    }),
    prisma.commissionAgent.findUnique({ where: { userId }, select: { ratePerOrder: true, currency: true } }),
  ]);

  // Commission is only *earned* on delivery — this is the potential, not a
  // guaranteed payout. Actual earned amounts live in the commissions area.
  const potentialCommission = agent ? Number(agent.ratePerOrder) * confirmed : null;

  return {
    confirmedThisMonth: confirmed,
    otherAttemptsThisMonth: otherAttempts,
    ratePerOrder: agent ? Number(agent.ratePerOrder) : null,
    currency: agent?.currency ?? "MAD",
    potentialCommission,
    isAgent: Boolean(agent),
  };
}

/** Compact, queue-wide KPIs for the Dashboard and the /confirmation header. */
export async function getConfirmationDashboardSummary() {
  const now = new Date();
  // « Aujourd'hui » / « ce mois » of the business time zone.
  const timeZone = await getBusinessTimeZone();
  const today = zonedParts(now, timeZone);
  const todayStart = zonedInstant(timeZone, today.year, today.month, today.day);
  const monthStart = zonedInstant(timeZone, today.year, today.month, 1);

  const [toConfirm, toRecall, confirmedToday, confirmedThisMonth] = await Promise.all([
    prisma.order.count({ where: { status: "NOUVELLE" } }),
    prisma.order.count({ where: { status: "NOUVELLE", confirmationAttemptCount: { gt: 0 } } }),
    // ORDERS confirmed (distinct), not attempt rows — same meaning as « Confirmées » elsewhere.
    countConfirmedOrders({ outcome: "CONFIRME", createdAt: { gte: todayStart } }),
    countConfirmedOrders({ outcome: "CONFIRME", createdAt: { gte: monthStart } }),
  ]);

  return { toConfirm, toRecall, confirmedToday, confirmedThisMonth };
}

/**
 * Orders owned by one confirmation agent, any status, most-recently-confirmed
 * first — backs the "Mes confirmations" tab.
 */
export async function listOrdersConfirmedByAgent(agentId: string, params: { page?: number } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.OrderWhereInput = { confirmationAgentId: agentId };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ confirmedAt: { sort: "desc", nulls: "last" } }, { placedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { customer: true, _count: { select: { items: true } } },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, page, pageSize: PAGE_SIZE };
}

/**
 * Orders that have left the queue on a positive outcome — the read-only
 * "Confirmées" tab. Scoped to orders that actually went through at least
 * one confirmation attempt (excludes manually-created orders that skipped
 * the queue entirely, e.g. already CONFIRMEE on creation).
 */
export async function listRecentlyConfirmedOrders(params: { page?: number; search?: string } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const q = params.search?.trim();
  const where: Prisma.OrderWhereInput = {
    status: { notIn: ["NOUVELLE", "ANNULEE"] },
    confirmationAttemptCount: { gt: 0 },
    ...(q
      ? {
          OR: [
            { customer: { fullName: { contains: q, mode: "insensitive" } } },
            { customer: { phone: { contains: q, mode: "insensitive" } } },
            ...(/^\d+$/.test(q) ? [{ orderNumber: Number(q) }] : []),
          ],
        }
      : {}),
  };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ confirmedAt: { sort: "desc", nulls: "last" } }, { placedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: true,
        _count: { select: { items: true } },
        confirmationAgent: { include: { user: { select: { name: true } } } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return { orders, total, page, pageSize: PAGE_SIZE };
}
