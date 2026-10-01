"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { InsufficientStockError } from "@/lib/inventory";
import { confirmOnlineOrderInTx, OrderConfirmationConflictError, OrderNotConfirmableError } from "@/lib/order-confirmation";
import { resolveNotifications } from "@/lib/notifications";
import { pushStockAfterLocalChange, pushOrderStatusToWooCommerce } from "@/lib/integrations/shared/auto-push";
import { reconcileOrderCommission } from "@/lib/commissions";
import { recordConfirmationAttemptSchema } from "@/lib/validation/order";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Order-confirmation call workflow — see
 * docs/adr/0029-order-confirmation-workflow.md.
 *
 * The shared confirmation queue (`/confirmation`) lists every NOUVELLE
 * order oldest-first. A confirmateur calls the customer and records the
 * outcome here:
 *   - CONFIRME  → the canonical confirmation (`confirmOnlineOrderInTx`,
 *     docs/adr/0045): order becomes CONFIRMEE, stock is reserved, and if
 *     the order has no confirmation agent yet and the caller has an ACTIVE
 *     `CommissionAgent` record, the caller is credited automatically.
 *   - ANNULE    → order becomes ANNULEE, its reserved stock is released.
 *   - the rest  → the attempt is logged, the order stays in the queue,
 *     its attempt counter bumps.
 *
 * Every attempt is appended to `OrderConfirmationAttempt` and the
 * denormalised `Order.confirmationAttemptCount` / `lastConfirmationAttemptAt`
 * are kept in step, so the queue can sort by "least recently tried" and
 * flag an order past a retry threshold.
 *
 * Held by `orders.confirm` (CONFIRMATION, MANAGER, ADMIN, OWNER) — narrower
 * than the full `orders.edit` status machine.
 */
export async function recordConfirmationAttemptAction(
  formData: FormData
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.confirm");

  const parsed = recordConfirmationAttemptSchema.safeParse({
    id: formData.get("id"),
    outcome: formData.get("outcome"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }
  const { id, outcome } = parsed.data;
  const note = parsed.data.note && parsed.data.note.trim().length > 0 ? parsed.data.note.trim() : null;

  const existing = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!existing) return actionError("Commande introuvable.");
  if (existing.status !== "NOUVELLE") {
    return actionError(
      `Cette commande n'est plus à confirmer (statut : ${existing.status}). Rechargez la file d'attente.`
    );
  }

  const lines = existing.items.map((i) => ({
    productId: i.productId,
    variationId: i.variationId,
    quantity: i.quantity,
  }));

  const terminal = outcome === "CONFIRME" ? "CONFIRMEE" : outcome === "ANNULE" ? "ANNULEE" : null;

  try {
    await prisma.$transaction(async (tx) => {
      if (outcome === "CONFIRME") {
        // The one canonical confirmation (docs/adr/0045): attempt + confirmedAt
        // + reservation + default attribution (the caller's ACTIVE agent, only
        // when the order has none) — the same path a direct status change uses.
        await confirmOnlineOrderInTx(tx, { orderId: id, confirmerUserId: user.id, note });
        return;
      }

      await tx.orderConfirmationAttempt.create({
        data: { orderId: id, agentUserId: user.id, outcome, note },
      });
      await tx.order.update({
        where: { id },
        data: {
          confirmationAttemptCount: { increment: 1 },
          lastConfirmationAttemptAt: new Date(),
        },
      });

      if (terminal === "ANNULEE") {
        // Conditional update guarding the NOUVELLE → ANNULEE race, same
        // pattern as updateOrderStatusAction. Nothing to release — a
        // NOUVELLE order never held a reservation.
        const moved = await tx.order.updateMany({
          where: { id, status: "NOUVELLE" },
          data: { status: terminal, cancelledAt: new Date() },
        });
        if (moved.count === 0) throw new OrderRaceError();
      }
    });
  } catch (error) {
    if (error instanceof OrderRaceError || error instanceof OrderConfirmationConflictError) {
      return actionError("Cette commande vient d'être traitée ailleurs. Rechargez la file d'attente.");
    }
    if (error instanceof OrderNotConfirmableError) {
      return actionError(error.message);
    }
    if (error instanceof InsufficientStockError) {
      return actionError(error.message);
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.confirmation_attempt",
    entityType: "Order",
    entityId: id,
    newValue: { outcome, ...(terminal ? { status: terminal } : {}), ...(note ? { note } : {}) },
  });

  if (terminal) {
    await resolveNotifications({ types: ["NOUVELLE_COMMANDE"], entityType: "Order", entityId: id });
    await reconcileOrderCommission(id, user.id);
  }
  if (terminal === "CONFIRMEE") {
    // Confirmation just reserved stock — push the new sellable number
    // outward for every order source now (docs/adr/0036): WooCommerce/
    // Shopify stock is never authoritative after onboarding, so there is
    // no more "provider's own more-recent number" to accidentally
    // overwrite (see updateOrderStatusAction's identical change).
    await pushStockAfterLocalChange({
      productIds: lines.map((l) => l.productId),
      variationIds: lines.map((l) => l.variationId),
    });
  }
  if (terminal === "ANNULEE") {
    await pushOrderStatusToWooCommerce(id);
  }

  revalidatePath("/confirmation");
  revalidatePath("/commandes");
  revalidatePath(`/commandes/${id}`);
  return actionOk({ id });
}

/** Thrown when the conditional NOUVELLE → terminal update matches 0 rows. */
class OrderRaceError extends Error {}
