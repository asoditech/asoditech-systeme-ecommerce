import type { OrderStatus, RecordSource } from "@prisma/client";
import { PURGEABLE_STATUSES, type PurgeEvaluation } from "@/lib/orders/purge";

/**
 * Pure UI rules of the « Purger cette commande de test » dialog (client-safe).
 * The business rules stay in src/lib/orders/purge.ts and the server action;
 * these only decide what the page shows and when the button is enabled.
 */

/** Offered only to an `orders.purge` holder, and only for an order the preview says is eligible. */
export function shouldOfferPurge(canPurge: boolean, evaluation: { ok: true; data: PurgeEvaluation } | { ok: false } | null): boolean {
  return canPurge && evaluation !== null && evaluation.ok && evaluation.data.eligible;
}

/**
 * Cheap list-level pre-filter (no per-row query): the parts of the purge rules
 * visible on an order row — created in ASODITECH, a purgeable status, never
 * shipped. Only decides whether the orders table offers the shortcut; the
 * dialog then loads the full server preview (shipments, refunds, returns,
 * commissions) and the action re-checks everything under lock.
 */
export function isPurgeCandidate(order: { source: RecordSource; status: OrderStatus; shippedAt: Date | null }): boolean {
  return order.source === "INTERNE" && PURGEABLE_STATUSES.includes(order.status) && order.shippedAt === null;
}

export const PURGE_MIN_REASON = 3;

/** Both deliberate confirmations: a reason, and the exact order number typed. */
export function purgeConfirmationReady(input: { reason: string; typedNumber: string; orderLabel: string; eligible: boolean }): boolean {
  return input.eligible && input.reason.trim().length >= PURGE_MIN_REASON && input.typedNumber.trim() === input.orderLabel;
}

export type PurgeOutcome = { kind: "success"; message: string; redirectTo: "/commandes" } | { kind: "error"; message: string };

/** Server answer → what the dialog does: on success leave the (now deleted) order page for the list. */
export function purgeOutcome(result: { ok: true; data: { label: string } } | { ok: false; error: string }): PurgeOutcome {
  return result.ok
    ? { kind: "success", message: `Commande ${result.data.label} purgée.`, redirectTo: "/commandes" }
    : { kind: "error", message: result.error };
}
