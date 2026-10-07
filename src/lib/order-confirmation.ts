import "server-only";
import { PACKING_CLEARED } from "@/lib/packing";

import type { PrismaTransactionClient } from "@/lib/prisma";
import { reserveStockForOrder } from "@/lib/inventory";

/**
 * THE canonical Online-order confirmation — docs/adr/0045-canonical-online-confirmation.md.
 *
 * Every legitimate NOUVELLE → CONFIRMEE transition goes through here: the
 * confirmation queue (`recordConfirmationAttemptAction`, outcome CONFIRME)
 * and the direct status change (`updateOrderStatusAction`). Runs INSIDE the
 * caller's transaction, so the caller's own side effects (audit event,
 * notifications, stock push, commission reconciliation — all after commit)
 * are unchanged.
 *
 * In one transaction:
 *   1. the order must exist (tenant-scoped client — a foreign id is not
 *      found), be an Online order, and be NOUVELLE;
 *   2. conditional NOUVELLE → CONFIRMEE update setting `confirmedAt` and the
 *      attempt counters — the race guard: a concurrent or retried
 *      confirmation matches 0 rows and throws, rolling everything back, so
 *      there is never a second CONFIRME attempt nor a second reservation;
 *   3. the confirmation history: one `OrderConfirmationAttempt`
 *      (outcome CONFIRME, `agentUserId` = the real confirmer) — always, agent
 *      or not;
 *   4. the reservation, through the one existing `reserveStockForOrder`;
 *   5. default commission attribution: the confirmer's CommissionAgent, ONLY
 *      when that agent is ACTIVE and the order has no attribution yet. The
 *      write is itself conditional (`confirmationAgentId: null`), so an
 *      attribution a manager set concurrently is never overwritten. No agent
 *      id is ever taken from the request — only derived from the confirmer.
 *
 * Commission itself is untouched here: callers run the existing
 * `reconcileOrderCommission` after commit, exactly as before (a CONFIRMEE
 * order earns nothing until LIVREE).
 */

export class OrderConfirmationConflictError extends Error {
  constructor() {
    super("Cette commande vient d'être traitée ailleurs. Rechargez la page.");
  }
}

export class OrderNotConfirmableError extends Error {}

/**
 * ANNULEE → NOUVELLE — the one "reopen" transition (docs/adr/0045, 0049), from
 * whichever side drives it: « Rétablir la commande », a direct status change,
 * or a WooCommerce / Shopify sync. A reopened order genuinely waits for a NEW
 * confirmation, so the CURRENT confirmation state is reset: `confirmedAt` and
 * the current commission attribution. History is never touched —
 * OrderConfirmationAttempt rows, audit events and the commission ledger stay.
 * (A reopenable order was never shipped, hence never delivered: it holds no
 * commission entry.)
 */
export const REOPEN_ORDER_DATA = {
  status: "NOUVELLE",
  cancelledAt: null,
  confirmedAt: null,
  confirmationAgentId: null,
  // A reopened order must be packed (and verified) again — src/lib/packing.ts.
  ...PACKING_CLEARED,
} as const;

/** Only a cancelled order that was never shipped may go back to NOUVELLE (no stock was ever consumed). */
export function isReopenable(order: { status: string; shippedAt: Date | null }): boolean {
  return order.status === "ANNULEE" && order.shippedAt === null;
}

export async function confirmOnlineOrderInTx(
  tx: PrismaTransactionClient,
  params: { orderId: string; confirmerUserId: string; note?: string | null }
): Promise<{ creditedAgentId: string | null }> {
  const order = await tx.order.findUnique({
    where: { id: params.orderId },
    select: {
      id: true,
      status: true,
      confirmationAgentId: true,
      salesChannel: { select: { kind: true } },
      items: { select: { productId: true, variationId: true, quantity: true } },
    },
  });
  if (!order) throw new OrderNotConfirmableError("Commande introuvable.");
  // Orders are the Online business (docs/adr/0038); a NULL channel is a
  // legacy, not-yet-attributed Online order. An Offline channel here would be
  // a data error — never confirm it through the Online workflow.
  if (order.salesChannel && order.salesChannel.kind !== "ONLINE") {
    throw new OrderNotConfirmableError("Seule une commande en ligne peut être confirmée.");
  }
  if (order.status !== "NOUVELLE") throw new OrderConfirmationConflictError();

  const now = new Date();
  const moved = await tx.order.updateMany({
    where: { id: order.id, status: "NOUVELLE" },
    data: {
      status: "CONFIRMEE",
      confirmedAt: now,
      confirmationAttemptCount: { increment: 1 },
      lastConfirmationAttemptAt: now,
    },
  });
  if (moved.count === 0) throw new OrderConfirmationConflictError();

  await tx.orderConfirmationAttempt.create({
    data: { orderId: order.id, agentUserId: params.confirmerUserId, outcome: "CONFIRME", note: params.note ?? null },
  });

  await reserveStockForOrder(tx, order.id, order.items, params.confirmerUserId);

  let creditedAgentId: string | null = null;
  if (!order.confirmationAgentId) {
    const agent = await tx.commissionAgent.findUnique({
      where: { userId: params.confirmerUserId },
      select: { id: true, isActive: true },
    });
    if (agent?.isActive) {
      const credited = await tx.order.updateMany({
        where: { id: order.id, confirmationAgentId: null },
        data: { confirmationAgentId: agent.id },
      });
      if (credited.count > 0) creditedAgentId = agent.id;
    }
  }

  return { creditedAgentId };
}
