import "server-only";

import { prisma } from "@/lib/prisma";
import type { Permission } from "@/lib/auth/permissions";
import { loadEffectiveAccessMany } from "@/lib/auth/access-loader";
import { isGlobalRole } from "@/lib/auth/effective-access";
import { canReadWarehouse } from "@/lib/auth/location-access";
import { formatCurrency, formatOrderNumber, displayOrderNumber } from "@/lib/format";
import { availableStockTotal } from "@/lib/inventory";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { sendNotificationEmails } from "@/lib/email";
import { deliveryFailureEmail, integrationErrorEmail, outOfStockEmail, type NotificationEmail } from "@/lib/notification-email";
import { sendWhatsAppToUsers } from "@/lib/whatsapp/dispatch";
import {
  deliveryFailureSummaryTemplate,
  integrationDownTemplate,
  stockOutTemplate,
  type WhatsAppTemplateMessage,
} from "@/lib/whatsapp/templates";
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
 *    `createManyAndReturn({ skipDuplicates: true })`; the
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
  /** Set ONLY for an event about one specific location (docs/adr/0056):
   * recipients must additionally be able to READ that location — the same
   * rule as every location-scoped page (`canReadWarehouse`: OWNER/ADMIN
   * always, everyone else only with a UserLocation row for it). Omitted =
   * not location-bound, unchanged behaviour. */
  warehouseId?: string;
  /** Set ONLY for the four critical events (docs/adr/0057): also email the
   * same recipients, at their account address. Sent only to users whose
   * notification row was newly inserted by THIS call, so it inherits the
   * dedupeKey idempotency — a reprocessed event emails nobody twice.
   * Requires `dedupeKey`. */
  email?: NotificationEmail;
  /** Set ONLY for the WhatsApp V1 critical events (docs/adr/0058): out of
   * stock and integration down. Same newly-inserted-row rule as `email`;
   * further narrowed to tenants with WhatsApp enabled and users with a
   * verified, opted-in number. Requires `dedupeKey`. */
  whatsapp?: WhatsAppTemplateMessage;
}

/** Returns the users newly notified by THIS call (a duplicate is not one). */
export async function notify(input: NotifyInput): Promise<string[]> {
  try {
    const users = await prisma.user.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, role: true, tenantId: true, email: true },
    });
    // EFFECTIVE permissions (role + per-user overrides, filtered by channel
    // scope — docs/adr/0039), not the bare role: an Offline-only manager must
    // not receive an Online order notification, and a user granted an extra
    // permission should. Two batched queries for the whole tenant.
    const access = await loadEffectiveAccessMany(users);
    let recipients = users.filter((u) => u.id !== input.exceptUserId && access.get(u.id)?.permissions.has(input.recipientPermission));
    if (input.warehouseId && recipients.length > 0) {
      // Location-bound event: one batched query for the candidates' assignment to THIS location.
      const assigned = new Set(
        (
          await prisma.userLocation.findMany({
            where: { warehouseId: input.warehouseId, userId: { in: recipients.filter((u) => !isGlobalRole(u.role)).map((u) => u.id) } },
            select: { userId: true },
          })
        ).map((r) => r.userId)
      );
      recipients = recipients.filter((u) =>
        canReadWarehouse(
          { locations: { global: isGlobalRole(u.role), ids: assigned.has(u.id) ? [input.warehouseId!] : [] } },
          input.warehouseId!
        )
      );
    }
    const recipientIds = recipients.map((u) => u.id);
    if (recipientIds.length === 0) return [];

    const created = await prisma.notification.createManyAndReturn({
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
      select: { userId: true },
    });

    // Exactly the users this call newly notified (a duplicate row was
    // skipped, so its user is not in `created`).
    const newlyNotified = new Set(created.map((r) => r.userId));
    if (input.email && input.dedupeKey) {
      // Their own account email.
      await sendNotificationEmails(
        recipients.filter((u) => newlyNotified.has(u.id) && u.email).map((u) => ({ to: u.email, email: input.email! }))
      );
    }
    if (input.whatsapp && input.dedupeKey) {
      await sendWhatsAppToUsers([...newlyNotified].map((userId) => ({ userId, message: input.whatsapp! })));
    }
    return [...newlyNotified];
  } catch (error) {
    console.error("notify() failed (non-fatal):", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Typed event helpers — one per business event, so call sites stay a
// single line and the title/message/dedupe/recipient wiring lives here.
// ---------------------------------------------------------------------------

/**
 * The opposite of `notify()` — when the condition behind an event clears
 * (an order leaves NOUVELLE, stock climbs back above its threshold), drop
 * the now-stale notification for that entity from every user's bell.
 * Best-effort, never throws. A hard delete, same as
 * `dismissNotificationAction` — nothing reads a resolved notification back.
 */
export async function resolveNotifications(params: {
  types: NotificationType[];
  entityType: string;
  entityId: string;
}): Promise<void> {
  try {
    await prisma.notification.deleteMany({
      where: { type: { in: params.types }, entityType: params.entityType, entityId: params.entityId },
    });
  } catch (error) {
    console.error("resolveNotifications() failed (non-fatal):", error);
  }
}

/** A new order was created — manually, or imported from WooCommerce/Shopify. */
export async function notifyNewOrder(
  order: {
    id: string;
    orderNumber: number;
    displayNumber?: number | null;
    total: string | number;
    currency: string;
    customerName: string;
    source: RecordSource;
  },
  exceptUserId?: string | null
): Promise<void> {
  const src = SOURCE_LABEL[order.source];
  const business = await getReportBusinessInfo();
  await notify({
    type: "NOUVELLE_COMMANDE",
    title: `Nouvelle commande ${formatOrderNumber(order.displayNumber ?? order.orderNumber, business.orderNumberPrefix)}`,
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
  order: { id: string; orderNumber: number; displayNumber?: number | null },
  exceptUserId?: string | null
): Promise<void> {
  const business = await getReportBusinessInfo();
  const num = formatOrderNumber(order.displayNumber ?? order.orderNumber, business.orderNumberPrefix);
  await notify({
    type: "PROBLEME_PAIEMENT",
    title: `Problème de paiement — commande ${num}`,
    message: `Le paiement de la commande ${num} a échoué.`,
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `probleme_paiement:${order.id}`,
    recipientPermission: "orders.view",
    exceptUserId,
  });
}

/** An order moved to RETOUR. */
export async function notifyOrderReturned(
  order: { id: string; orderNumber: number; displayNumber?: number | null; customerName: string },
  exceptUserId?: string | null
): Promise<void> {
  const business = await getReportBusinessInfo();
  const num = formatOrderNumber(order.displayNumber ?? order.orderNumber, business.orderNumberPrefix);
  await notify({
    type: "COMMANDE_RETOURNEE",
    title: `Commande retournée ${num}`,
    message: `La commande ${num} de ${order.customerName} a été retournée.`,
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `commande_retournee:${order.id}`,
    recipientPermission: "orders.view",
    exceptUserId,
  });
}

interface ShipmentFailure {
  id: string;
  orderId: string;
  orderNumber: number;
  orderDisplayNumber?: number | null;
  providerName: string;
  reason?: string | null;
}

/** A shipment failed delivery (status ECHEC). */
export async function notifyShipmentFailed(shipment: ShipmentFailure, exceptUserId?: string | null): Promise<void> {
  await notifyShipmentsFailed([shipment], exceptUserId);
}

/**
 * Several shipments failed in one run (« Rafraîchir les statuts »). In-app
 * and email stay one per shipment, unchanged. WhatsApp is BUNDLED
 * (docs/adr/0058): one summary per recipient for the shipments newly
 * notified to them in this call, and at most one per recipient per UTC
 * day (atomic claim on the user row — the per-shipment dedupe key alone
 * cannot express "per recipient per day").
 */
export async function notifyShipmentsFailed(shipments: ShipmentFailure[], exceptUserId?: string | null): Promise<void> {
  const perUser = new Map<string, string[]>(); // userId → carrier per newly-notified failure
  if (shipments.length === 0) return;
  const business = await getReportBusinessInfo();
  for (const shipment of shipments) {
    const num = formatOrderNumber(shipment.orderDisplayNumber ?? shipment.orderNumber, business.orderNumberPrefix);
    const newlyNotified = await notify({
      type: "ECHEC_LIVRAISON",
      title: `Échec de livraison — commande ${num}`,
      message:
        `L'expédition de la commande ${num} (${shipment.providerName}) a échoué.` +
        (shipment.reason ? ` Motif : ${shipment.reason}` : ""),
      entityType: "Shipment",
      entityId: shipment.id,
      dedupeKey: `echec_livraison:${shipment.id}`,
      recipientPermission: "delivery.view",
      exceptUserId,
      email: deliveryFailureEmail({ orderNumber: num, providerName: shipment.providerName }),
    });
    for (const userId of newlyNotified) perUser.set(userId, [...(perUser.get(userId) ?? []), shipment.providerName]);
  }
  await sendWhatsAppToUsers(
    [...perUser].map(([userId, providerNames]) => ({
      userId,
      message: deliveryFailureSummaryTemplate({ count: providerNames.length, providerNames }),
    })),
    { oncePerDay: "delivery_failure" }
  );
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
    email: integrationErrorEmail({ label: params.label, kind: params.entityType }),
    whatsapp: integrationDownTemplate({ label: params.label }),
  });
}

/**
 * A user reported a problem from the support widget
 * (src/actions/support.ts). Goes to owners/admins (`settings.view`), the
 * people who configure support and would triage an issue. One notification
 * per ticket (`dedupeKey` on the ticket id), reporter excluded.
 */
export async function notifySupportTicket(
  ticket: { id: string; categoryLabel: string; reporterName: string },
  exceptUserId?: string | null
): Promise<void> {
  await notify({
    type: "SUPPORT_TICKET",
    title: `Problème signalé — ${ticket.categoryLabel}`,
    message: `${ticket.reporterName} a signalé un problème depuis le centre d'aide.`,
    entityType: "SupportTicket",
    entityId: ticket.id,
    dedupeKey: `support_ticket:${ticket.id}`,
    recipientPermission: "settings.view",
    exceptUserId,
  });
}

/**
 * A connected store (WooCommerce/Shopify) reported an order status that
 * conflicts with ASODITECH's own workflow stage for that order — most
 * importantly, a store-side status that would otherwise map straight to
 * EXPEDIEE (docs/adr/0036-inventory-single-source-of-truth.md: only
 * ASODITECH's own EXPEDIEE transition may ever physically consume stock,
 * so the store's report is never auto-applied). Read-only: never mutates
 * the order or its stock — purely a "please look at this" signal for a
 * human to resolve.
 *
 * One standing notification per order (`dedupeKey` on the order id, no day
 * bucket — the same underlying disagreement re-reported by every later
 * webhook/sync is the same fact, not a new one) — resolved via
 * `resolveNotifications` the moment the local workflow catches up (see
 * `updateOrderStatusAction`/`cancelOrderAction` in src/actions/orders.ts,
 * which call it on every successful transition).
 */
export async function notifyWorkflowMismatch(order: {
  id: string;
  orderNumber: number;
  displayNumber?: number | null;
  source: RecordSource;
  externalNumber?: string | null;
  localStatus: string;
  externalStatus: string;
}): Promise<void> {
  const business = await getReportBusinessInfo();
  const num = displayOrderNumber(order, business.orderNumberPrefix);
  const src = SOURCE_LABEL[order.source] ?? order.source;
  const externalRef = order.externalNumber ? ` (${order.externalNumber})` : "";
  await notify({
    type: "INCOHERENCE_WORKFLOW",
    title: `Incohérence de workflow — commande ${num}`,
    message:
      `${src}${externalRef} rapporte le statut « ${order.externalStatus} » alors que la commande ${num} est ` +
      `« ${order.localStatus} » dans ASODITECH. Le statut externe n'a pas été appliqué automatiquement — ` +
      `vérifiez et faites progresser la commande manuellement si nécessaire.`,
    entityType: "Order",
    entityId: order.id,
    dedupeKey: `incoherence_workflow:${order.id}`,
    recipientPermission: "orders.view",
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
        warehouseId: true,
        warehouse: { select: { name: true } },
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
      if (item.quantityOnHand > threshold) {
        // Stock recovered — clear any standing low-stock / rupture alert
        // for this item so it doesn't sit stale in everyone's bell.
        await resolveNotifications({
          types: ["STOCK_FAIBLE", "RUPTURE_STOCK"],
          entityType: "InventoryItem",
          entityId: item.id,
        });
        continue;
      }

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
        // One stock item = one location: only users who may read that location (docs/adr/0056).
        warehouseId: item.warehouseId,
        // Out of stock is critical (email docs/adr/0057, WhatsApp 0058); low stock stays in-app only.
        ...(isRupture
          ? {
              email: outOfStockEmail({ productName: name, sku, locationName: item.warehouse.name }),
              whatsapp: stockOutTemplate({ productName: name, locationName: item.warehouse.name }),
            }
          : {}),
      });
    }
  } catch (error) {
    console.error("checkAndNotifyLowStock() failed (non-fatal):", error);
  }
}

/**
 * Alerts when a NEW order's line quantity exceeds current available stock
 * (Physical − Reserved, `availableStockTotal` — the same derived-stock
 * definition every other stock path uses). Read-only: never touches
 * `quantityOnHand`/`quantityReserved` or writes an `InventoryMovement` —
 * this is purely informational, so staff can decide whether to still
 * confirm, backorder, or contact the customer.
 *
 * Called once per new order (manual `createOrderAction`, and WooCommerce/
 * Shopify `createImportedOrder`, mirroring `notifyNewOrder`'s own call
 * sites) — never on a re-import/update, so an order that later drops in
 * stock elsewhere doesn't retroactively get flagged.
 *
 * Deduped per (order, product|variation) — not a day bucket like
 * `checkAndNotifyLowStock`'s recurring condition, since this describes a
 * one-off fact about a specific order: a webhook retry, a re-sync, a
 * manual refresh, or a repeated API call for the SAME order always
 * resolves to the same key and is silently skipped by the
 * `@@unique([userId, dedupeKey])` constraint (see this module's own doc
 * comment on `notify()`).
 */
export async function checkAndNotifyInsufficientStockForOrder(
  order: {
    id: string;
    orderNumber: number;
    displayNumber?: number | null;
    source: RecordSource;
    externalNumber?: string | null;
  },
  lines: { productId?: string | null; variationId?: string | null; quantity: number }[]
): Promise<void> {
  try {
    const business = await getReportBusinessInfo();
    const num = displayOrderNumber(order, business.orderNumberPrefix);
    for (const line of lines) {
      if (line.quantity <= 0) continue;
      if (!line.productId && !line.variationId) continue;

      const items = await prisma.inventoryItem.findMany({
        where: line.variationId ? { variationId: line.variationId } : { productId: line.productId! },
        select: {
          quantityOnHand: true,
          quantityReserved: true,
          product: { select: { name: true } },
          variation: { select: { product: { select: { name: true } } } },
        },
      });
      // Not stock-tracked anywhere — nothing to compare the order against
      // (same "silent no-op" posture as applyStockMovement's own
      // no_inventory_item case).
      if (items.length === 0) continue;

      const available = availableStockTotal(items) ?? 0;
      if (line.quantity <= available) continue;

      // NOT location-bound (docs/adr/0056): an Online order is compared with the
      // stock AVAILABLE across every location, so no single location is affected.
      const missing = line.quantity - available;
      const name = items[0].product?.name ?? items[0].variation?.product.name ?? "Produit";
      const key = line.variationId ?? line.productId!;

      await notify({
        type: "STOCK_INSUFFISANT_COMMANDE",
        title: "Stock insuffisant",
        message: `Stock insuffisant — ${name} — commande ${num} : ${line.quantity} demandée(s), ${available} disponible(s), ${missing} manquante(s).`,
        entityType: "Order",
        entityId: order.id,
        dedupeKey: `stock_insuffisant_commande:${order.id}:${key}`,
        recipientPermission: "orders.view",
      });
    }
  } catch (error) {
    console.error("checkAndNotifyInsufficientStockForOrder() failed (non-fatal):", error);
  }
}
