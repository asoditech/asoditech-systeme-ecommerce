import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

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
