import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { availableStockTotal } from "@/lib/inventory";

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
  const where: Prisma.OrderWhereInput = {
    status: "NOUVELLE",
    ...(params.onlyRetried ? { confirmationAttemptCount: { gt: 0 } } : {}),
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
      orderBy: [{ lastConfirmationAttemptAt: { sort: "asc", nulls: "first" } }, { placedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        customer: true,
        _count: { select: { items: true } },
        // Batch 3, Task 8: item lines (product/variation/quantity only — no
        // name needed here) so the queue can flag a backorder without a
        // second round-trip; see `flagInsufficientStock` below.
        items: { select: { productId: true, variationId: true, quantity: true } },
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
 * Backorder warning at confirmation time (Batch 3, Task 8) — purely
 * informational, never blocks confirming (backorders are allowed by
 * design, docs/adr/0030). Reuses the exact same available-stock definition
 * (`availableStockTotal`, Physical − Reserved) as
 * `checkAndNotifyInsufficientStockForOrder` in src/lib/notifications.ts, but
 * batched for a whole page of orders in ONE query instead of one per line —
 * this runs on every render of the confirmation queue, not once per order.
 */
export async function flagInsufficientStock(
  orders: { id: string; items: { productId: string | null; variationId: string | null; quantity: number }[] }[]
): Promise<Set<string>> {
  const productIds = new Set<string>();
  const variationIds = new Set<string>();
  for (const o of orders) {
    for (const item of o.items) {
      if (item.productId) productIds.add(item.productId);
      if (item.variationId) variationIds.add(item.variationId);
    }
  }
  if (productIds.size === 0 && variationIds.size === 0) return new Set();

  const rows = await prisma.inventoryItem.findMany({
    where: {
      OR: [
        ...(productIds.size > 0 ? [{ productId: { in: [...productIds] } }] : []),
        ...(variationIds.size > 0 ? [{ variationId: { in: [...variationIds] } }] : []),
      ],
    },
    select: { productId: true, variationId: true, quantityOnHand: true, quantityReserved: true },
  });
  const byUnit = new Map<string, { quantityOnHand: number; quantityReserved: number }[]>();
  for (const r of rows) {
    const key = r.variationId ?? r.productId;
    if (!key) continue;
    const list = byUnit.get(key) ?? [];
    list.push(r);
    byUnit.set(key, list);
  }

  const flagged = new Set<string>();
  for (const o of orders) {
    for (const item of o.items) {
      if (item.quantity <= 0) continue;
      const key = item.variationId ?? item.productId;
      if (!key) continue;
      const units = byUnit.get(key);
      if (!units) continue; // not stock-tracked — nothing to compare against
      const available = availableStockTotal(units) ?? 0;
      if (item.quantity > available) {
        flagged.add(o.id);
        break;
      }
    }
  }
  return flagged;
}

/** Full call-attempt history for one order (newest first) — order detail page. */
export async function getOrderConfirmationAttempts(orderId: string) {
  return prisma.orderConfirmationAttempt.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    include: { agent: { select: { name: true } } },
  });
}

/**
 * This calendar month's confirmation activity for one user — shown to a
 * confirmateur on the queue page so they see their own throughput and
 * roughly what they've earned, without exposing the full commissions area.
 */
export async function getMyConfirmationStats(userId: string) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [confirmed, otherAttempts, agent] = await Promise.all([
    prisma.orderConfirmationAttempt.count({
      where: { agentUserId: userId, outcome: "CONFIRME", createdAt: { gte: monthStart } },
    }),
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
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [toConfirm, toRecall, confirmedToday, confirmedThisMonth] = await Promise.all([
    prisma.order.count({ where: { status: "NOUVELLE" } }),
    prisma.order.count({ where: { status: "NOUVELLE", confirmationAttemptCount: { gt: 0 } } }),
    prisma.orderConfirmationAttempt.count({
      where: { outcome: "CONFIRME", createdAt: { gte: todayStart } },
    }),
    prisma.orderConfirmationAttempt.count({
      where: { outcome: "CONFIRME", createdAt: { gte: monthStart } },
    }),
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
