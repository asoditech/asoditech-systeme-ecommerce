import "server-only";

import type { AuditActorType } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

/**
 * « Marquer automatiquement les commandes comme payées à la livraison »
 * (BusinessSettings.autoPaidOnDelivery, per company, default OFF — owner
 * decision 2026-10-16).
 *
 * The company's own business rule "delivered = paid": when ON, an order
 * whose payment is still EN_ATTENTE becomes PAYE at the moment it validly
 * becomes LIVREE — whichever path delivered it (parcel « Livré » from a
 * carrier or staff, the order's own status, a store reporting it delivered).
 * It is only that rule, recorded as such in the audit trail
 * (`reason: "delivered_auto_paid"`): it never creates a cash-collection or
 * courier-remittance record (none exists in the model), and the delivery
 * reports keep showing what the courier really remitted.
 *
 * Never touched: ECHEC (a recorded payment failure needs a person),
 * PARTIELLEMENT_PAYE, PAYE, REMBOURSE. The update is conditional on
 * (LIVREE, EN_ATTENTE) inside the caller's transaction, so a replayed
 * carrier event / webhook / double click changes it once and writes one
 * audit event; a rolled-back delivery rolls this back with it.
 */

export type DeliveredPaymentVia = "shipment" | "order_status" | "store_sync";

export function shouldMarkPaidOnDelivery(params: {
  enabled: boolean;
  orderStatus: string;
  paymentStatus: string;
}): boolean {
  return params.enabled && params.orderStatus === "LIVREE" && params.paymentStatus === "EN_ATTENTE";
}

export async function isAutoPaidOnDeliveryEnabled(db: PrismaTransactionClient | typeof prisma = prisma): Promise<boolean> {
  const settings = await db.businessSettings.findFirst({ select: { autoPaidOnDelivery: true } });
  return settings?.autoPaidOnDelivery === true;
}

/**
 * Call right after the order became LIVREE, inside the same transaction.
 * Returns true when this call moved the payment EN_ATTENTE → PAYE.
 */
export async function applyDeliveredPayment(
  db: PrismaTransactionClient,
  params: {
    orderId: string;
    via: DeliveredPaymentVia;
    actorType: AuditActorType;
    actorUserId?: string | null;
    metadata?: Record<string, string | null>;
  }
): Promise<boolean> {
  if (!(await isAutoPaidOnDeliveryEnabled(db))) return false;
  const { count } = await db.order.updateMany({
    where: { id: params.orderId, status: "LIVREE", paymentStatus: "EN_ATTENTE" },
    data: { paymentStatus: "PAYE" },
  });
  if (count !== 1) return false;
  await recordAuditEvent(
    {
      actorType: params.actorType,
      actorUserId: params.actorUserId ?? null,
      action: "order.updated",
      entityType: "Order",
      entityId: params.orderId,
      previousValue: { paymentStatus: "EN_ATTENTE" },
      newValue: { paymentStatus: "PAYE" },
      metadata: { reason: "delivered_auto_paid", via: params.via, ...params.metadata },
    },
    db
  );
  return true;
}
