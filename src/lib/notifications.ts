import "server-only";

import { prisma } from "@/lib/prisma";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { formatCurrency, formatOrderNumber } from "@/lib/format";
import type { NotificationType, RecordSource } from "@prisma/client";

/**
 * In-app notifications — see docs/adr/0016-notifications.md.
 *
 * `notify()` fans ONE business event out to every ACTIVE user who holds
 * the event's permission, as a per-user `Notification` row. Design rules:
 *
 *  - **Best-effort.** Every failure is logged and swallowed. A
 *    notification must never roll back or fail the business action that
 *    triggered it — call these AFTER the business transaction commits,
 *    next to `recordAuditEvent`.
 *  - **Concurrency-safe.** Fan-out is a single
 *    `createMany({ skipDuplicates: true })`; the
 *    `@@unique([userId, dedupeKey])` constraint makes a duplicate
 *    (from a retry, a concurrent request, or a webhook + manual sync
 *    racing) a silent no-op, no app-level lock.
 *  - **No new data exposure.** A recipient only ever gets a notification
 *    for an event they already have the permission to see; titles/messages
 *    are app-authored French built from data that recipient can already
 *    read (order numbers, product names, …). Never a credential, token,
 *    URL, or raw external payload.
 */

const SOURCE_LABEL: Record<RecordSource, string | null> = {
  INTERNE: null,
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
};

/** UTC day, `YYYY-MM-DD` — the bucket appended to a recurring-condition
 * dedupe key so an alert re-fires at most once per day. */
function dayBucket(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

interface NotifyInput {
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  /** `<event>:<entityId>[:<bucket>]`. A (user, key) that already exists is
   * skipped. Omit for a genuinely one-off ad-hoc notification. */
  dedupeKey?: string;
  /** Every ACTIVE user holding this permission receives the notification. */
  recipientPermission: Permission;
  /** The user who caused the event — excluded from recipients (they just
   * did it, they don't need to be told). `null`/omitted for
   * system/integration-driven events. */
  exceptUserId?: string | null;
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    const users = await prisma.user.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, role: true },
    });
    const recipientIds = users
      .filter((u) => u.id !== input.exceptUserId && hasPermission(u.role, input.recipientPermission))
      .map((u) => u.id);
    if (recipientIds.length === 0) return;

    await prisma.notification.createMany({
      data: recipientIds.map((userId) => ({
        userId,
        type: input.type,
        title: input.title.slice(0, 200),
        message: input.message.slice(0, 500),
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })),
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("notify() failed (non-fatal):", error);
  }
}

// ---------------------------------------------------------------------------
// Typed event helpers — one per business event, so call sites stay a
// single line and the title/message/dedupe/recipient wiring lives here.
// ---------------------------------------------------------------------------

/** A new order was created — manually, or imported from WooCommerce/Shopify. */
export async function notifyNewOrder(
  order: {
    id: string;
    orderNumber: number;
    total: string | number;
    currency: string;
    customerName: string;
    source: RecordSource;
  },
  exceptUserId?: string | null
): Promise<void> {
  const src = SOURCE_LABEL[order.source];
  await notify({
    type: "NOUVELLE_COMMANDE",
    title: `Nouvelle commande ${formatOrderNumber(order.orderNumber)}`,
    message:
      `${order.customerName} — ${formatCurrency(order.total, order.currency)}` +
      (src ? ` (importée de ${src})` : ""),
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `nouvelle_commande:${order.id}`,
    recipientPermission: "orders.view",
    exceptUserId,
  });
}

/** An order's payment status became ECHEC. */
export async function notifyPaymentProblem(
  order: { id: string; orderNumber: number },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "PROBLEME_PAIEMENT",
    title: `Problème de paiement — commande ${formatOrderNumber(order.orderNumber)}`,
    message: `Le paiement de la commande ${formatOrderNumber(order.orderNumber)} a échoué.`,
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `probleme_paiement:${order.id}`,
    recipientPermission: "orders.view",
    exceptUserId,
  });
}

/** An order moved to RETOUR. */
export async function notifyOrderReturned(
  order: { id: string; orderNumber: number; customerName: string },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "COMMANDE_RETOURNEE",
    title: `Commande retournée ${formatOrderNumber(order.orderNumber)}`,
    message: `La commande ${formatOrderNumber(order.orderNumber)} de ${order.customerName} a été retournée.`,
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `commande_retournee:${order.id}`,
    recipientPermission: "orders.view",
    exceptUserId,
  });
}

/** A shipment failed delivery (status ECHEC). */
export async function notifyShipmentFailed(
  shipment: { id: string; orderId: string; orderNumber: number; providerName: string; reason?: string | null },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "ECHEC_LIVRAISON",
    title: `Échec de livraison — commande ${formatOrderNumber(shipment.orderNumber)}`,
    message:
      `L'expédition de la commande ${formatOrderNumber(shipment.orderNumber)} (${shipment.providerName}) a échoué.` +
      (shipment.reason ? ` Motif : ${shipment.reason}` : ""),
    entityType: "Shipment",
    entityId: shipment.id,
    dedupeKey: `echec_livraison:${shipment.id}`,
    recipientPermission: "delivery.view",
    exceptUserId,
  });
}

/** A sync run ended ECHEC or PARTIEL. */
export async function notifySyncFailure(
  run: {
    id: string;
    provider: "WooCommerce" | "Shopify";
    resource: string;
    status: "ECHEC" | "PARTIEL";
    imported: number;
    failed: number;
    firstNote?: string | null;
  },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "ECHEC_SYNCHRONISATION",
    title:
      run.status === "ECHEC"
        ? `Échec de synchronisation ${run.provider}`
        : `Synchronisation ${run.provider} partielle`,
    message:
      run.status === "ECHEC"
        ? `La synchronisation « ${run.resource} » a échoué.` + (run.firstNote ? ` ${run.firstNote}` : "")
        : `« ${run.resource} » : ${run.imported} importé(s), ${run.failed} en échec.` +
          (run.firstNote ? ` ${run.firstNote}` : ""),
    entityType: "SyncRun",
    entityId: run.id,
    dedupeKey: `echec_sync:${run.id}`,
    recipientPermission: "integrations.view",
    exceptUserId,
  });
}

/**
 * A connection test failed for an Integration or an API shipping provider.
 * `recipientPermission` is the read gate of wherever the operator fixes it
 * (`integrations.view` for an Integration, `delivery.view` for a shipping
 * provider). Deduped per entity per day so a repeatedly-failing test
 * doesn't flood the bell.
 */
export async function notifyConnectionError(
  params: {
    entityType: "Integration" | "ShippingProvider";
    entityId: string;
    label: string;
    recipientPermission: Extract<Permission, "integrations.view" | "delivery.view">;
  },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "ERREUR_INTEGRATION",
    title: `Erreur de connexion — ${params.label}`,
    message: `Le test de connexion à « ${params.label} » a échoué. Vérifiez les identifiants et la configuration.`,
    entityType: params.entityType,
    entityId: params.entityId,
    dedupeKey: `erreur_connexion:${params.entityId}:${dayBucket()}`,
    recipientPermission: params.recipientPermission,
    exceptUserId,
  });
}

/**
 * After a business action that may have reduced on-hand stock, checks the
 * affected products/variations and notifies for any now at or below its
 * `lowStockThreshold` (RUPTURE_STOCK at ≤ 0, STOCK_FAIBLE otherwise).
 * Deduped per item per type per day. Best-effort; never throws.
 *
 * Deliberately never excludes the acting user (unlike every other
 * notify* helper here) — "you just created this order" is redundant to
 * tell its own creator, but "this is now low" is new information even to
 * whoever's adjustment caused it (they may not know the threshold, or
 * another location's stock), and a single-operator store would otherwise
 * never see its own low-stock alerts at all.
 */
export async function checkAndNotifyLowStock(
  refs: { productIds?: (string | null | undefined)[]; variationIds?: (string | null | undefined)[] }
): Promise<void> {
  try {
    const productIds = [...new Set((refs.productIds ?? []).filter((v): v is string => !!v))];
    const variationIds = [...new Set((refs.variationIds ?? []).filter((v): v is string => !!v))];
    if (productIds.length === 0 && variationIds.length === 0) return;

    const orClauses = [
      productIds.length > 0 ? { productId: { in: productIds } } : null,
      variationIds.length > 0 ? { variationId: { in: variationIds } } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    const items = await prisma.inventoryItem.findMany({
      where: { OR: orClauses },
      select: {
        id: true,
        quantityOnHand: true,
        product: { select: { name: true, sku: true, lowStockThreshold: true, trackInventory: true } },
        variation: {
          select: { sku: true, product: { select: { name: true, lowStockThreshold: true, trackInventory: true } } },
        },
      },
    });

    const today = dayBucket();
    for (const item of items) {
      const tracked = item.product?.trackInventory ?? item.variation?.product.trackInventory ?? false;
      if (!tracked) continue;
      const threshold = item.product?.lowStockThreshold ?? item.variation?.product.lowStockThreshold ?? 0;
      if (item.quantityOnHand > threshold) continue;

      const name = item.product?.name ?? item.variation?.product.name ?? "Produit";
      const sku = item.product?.sku ?? item.variation?.sku ?? "";
      const isRupture = item.quantityOnHand <= 0;

      await notify({
        type: isRupture ? "RUPTURE_STOCK" : "STOCK_FAIBLE",
        title: isRupture ? `Rupture de stock : ${name}` : `Stock faible : ${name}`,
        message: isRupture
          ? `${name} (${sku}) est en rupture de stock.`
          : `${name} (${sku}) — ${item.quantityOnHand} unité(s) restante(s) (seuil : ${threshold}).`,
        entityType: "InventoryItem",
        entityId: item.id,
        dedupeKey: `${isRupture ? "rupture_stock" : "stock_faible"}:${item.id}:${today}`,
        recipientPermission: "inventory.view",
      });
    }
  } catch (error) {
    console.error("checkAndNotifyLowStock() failed (non-fatal):", error);
  }
}
