import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";

/**
 * « Paiement confirmé par la boutique » (BusinessSettings.autoPaymentFromStore,
 * default OFF). Payment and delivery stay separate concepts:
 *  - the ONLY automatic source is the store itself reporting the order paid
 *    (WooCommerce `date_paid`, Shopify `displayFinancialStatus = PAID`) — the
 *    store is where the customer actually paid (card, transfer…);
 *  - a carrier « Livré » never marks an order paid: delivery does not prove
 *    the courier collected the cash, and no COD remittance record exists to
 *    reconcile against (documented decision);
 *  - only EN_ATTENTE → PAYE. PAYE / PARTIELLEMENT_PAYE / ECHEC / REMBOURSE set
 *    by a person or a refund are never overwritten, and the store reporting
 *    "unpaid" never reverts anything.
 * The conditional updateMany makes it idempotent (repeated webhooks / syncs:
 * one change, one audit event).
 */
export async function applyStorePaymentConfirmation(
  orderId: string,
  storeReportsPaid: boolean,
  source: "WOOCOMMERCE" | "SHOPIFY",
  db: PrismaTransactionClient | typeof prisma = prisma
): Promise<boolean> {
  if (!storeReportsPaid) return false;
  const settings = await db.businessSettings.findFirst({ select: { autoPaymentFromStore: true } });
  if (!settings?.autoPaymentFromStore) return false;

  const changed = await db.order.updateMany({
    where: { id: orderId, paymentStatus: "EN_ATTENTE" },
    data: { paymentStatus: "PAYE" },
  });
  if (changed.count === 0) return false;

  await recordAuditEvent(
    {
      actorType: "INTEGRATION",
      action: "order.updated",
      entityType: "Order",
      entityId: orderId,
      previousValue: { paymentStatus: "EN_ATTENTE" },
      newValue: { paymentStatus: "PAYE" },
      metadata: { reason: "store_reported_paid", source },
    },
    db
  );
  return true;
}
