import "server-only";

import { prisma } from "@/lib/prisma";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { Prisma } from "@prisma/client";

/**
 * Order-confirmation commission — see docs/adr/0022-order-confirmation-commission.md.
 *
 * `reconcileOrderCommission()` is the ONLY thing that writes the ledger. It
 * is idempotent and self-correcting: given an order id it looks at the
 * order's current status + assigned agent and makes the ledger match —
 * creating an EARNED entry when the order is LIVREE with an agent and none
 * exists, a REVERSED entry when a previously-earned order has left LIVREE,
 * and nothing otherwise. It runs inside a transaction holding a per-order
 * advisory lock, so two concurrent order-status updates cannot both credit
 * the same order; the `@@unique([orderId, type])` constraint is the final
 * backstop (a P2002 is swallowed as "someone else already did it").
 *
 * Call it — best-effort, after the triggering transaction commits — from
 * every place an order's status can change: manual status change, cancel,
 * a shipment reaching LIVRE, and a store webhook/sync moving the order.
 */

const DELIVERED_STATUS = "LIVREE";

export type CommissionReconcileOutcome = "earned" | "reversed" | "unchanged" | "skipped" | "error";

export async function reconcileOrderCommission(
  orderId: string,
  actorUserId?: string | null
): Promise<{ outcome: CommissionReconcileOutcome; amount?: number }> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`commission:${orderId}`}))`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, confirmationAgentId: true },
      });
      if (!order) return { outcome: "skipped" as const };

      const entries = await tx.commissionEntry.findMany({ where: { orderId } });
      const earned = entries.find((e) => e.type === "EARNED");
      const hasReversed = entries.some((e) => e.type === "REVERSED");
      const isDelivered = order.status === DELIVERED_STATUS;

      // EARN — delivered, has an agent, never earned or reversed before.
      if (isDelivered && order.confirmationAgentId && !earned && !hasReversed) {
        const agent = await tx.commissionAgent.findUnique({ where: { id: order.confirmationAgentId } });
        if (!agent) return { outcome: "skipped" as const };
        await tx.commissionEntry.create({
          data: {
            agentId: agent.id,
            orderId,
            type: "EARNED",
            amount: agent.ratePerOrder,
            rateApplied: agent.ratePerOrder,
            currency: agent.currency,
            createdById: actorUserId ?? null,
          },
        });
        return { outcome: "earned" as const, amount: Number(agent.ratePerOrder) };
      }

      // REVERSE — was earned, order is no longer delivered, not already reversed.
      if (!isDelivered && earned && !hasReversed) {
        await tx.commissionEntry.create({
          data: {
            agentId: earned.agentId,
            orderId,
            type: "REVERSED",
            amount: new Prisma.Decimal(earned.amount).negated(),
            rateApplied: earned.rateApplied,
            currency: earned.currency,
            note: `Reprise — commande passée à « ${order.status} »`,
            createdById: actorUserId ?? null,
          },
        });
        return { outcome: "reversed" as const, amount: -Number(earned.amount) };
      }

      return { outcome: "unchanged" as const };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { outcome: "unchanged" };
    console.error("reconcileOrderCommission() failed (non-fatal):", error);
    return { outcome: "error" };
  }
}

/** `[start, end)` UTC bounds for a calendar month (month is 1-12). */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

export interface AgentCommissionTotals {
  /** EARNED entries not yet in a closed statement. */
  unsettledEarnedCount: number;
  unsettledReversedCount: number;
  /** Net of all entries not yet settled (earned − reversed). */
  unsettledNet: number;
  /** Net of every entry ever, settled or not. */
  lifetimeNet: number;
  /** Sum of paidAmount across the agent's PAYE statements. */
  paidTotal: number;
  /** lifetimeNet − paidTotal. */
  remaining: number;
}

export async function getAgentCommissionTotals(agentId: string): Promise<AgentCommissionTotals> {
  const [unsettled, unsettledEarned, unsettledReversed, lifetime, paid] = await Promise.all([
    prisma.commissionEntry.aggregate({ where: { agentId, statementId: null }, _sum: { amount: true } }),
    prisma.commissionEntry.count({ where: { agentId, statementId: null, type: "EARNED" } }),
    prisma.commissionEntry.count({ where: { agentId, statementId: null, type: "REVERSED" } }),
    prisma.commissionEntry.aggregate({ where: { agentId }, _sum: { amount: true } }),
    prisma.commissionStatement.aggregate({ where: { agentId, status: "PAYE" }, _sum: { paidAmount: true } }),
  ]);
  const lifetimeNet = Number(lifetime._sum.amount ?? 0);
  const paidTotal = Number(paid._sum.paidAmount ?? 0);
  return {
    unsettledEarnedCount: unsettledEarned,
    unsettledReversedCount: unsettledReversed,
    unsettledNet: Number(unsettled._sum.amount ?? 0),
    lifetimeNet,
    paidTotal,
    remaining: lifetimeNet - paidTotal,
  };
}
