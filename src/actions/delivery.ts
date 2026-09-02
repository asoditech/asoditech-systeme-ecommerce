"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { applyShipmentStatusTransition, SHIPPABLE_ORDER_STATUSES } from "@/lib/delivery";
import {
  createShippingProviderSchema,
  createShipmentSchema,
  updateShipmentStatusSchema,
  configureDeliveryProviderApiSchema,
  createShipmentViaProviderSchema,
  generateManifestSchema,
  providerIdSchema,
  shipmentIdSchema,
  shippingProviderIdSchema,
} from "@/lib/validation/delivery";
import { isForeignKeyConstraintError } from "@/lib/prisma-errors";
import { encryptSecret } from "@/lib/crypto";
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import {
  testProviderConnection,
  createShipmentViaProvider,
  cancelShipmentViaProvider,
  syncShipmentStatus,
  generateManifestViaProvider,
  friendlyDeliveryError,
  reserveShipmentSlot,
  type SyncShipmentStatusOutcome,
} from "@/lib/integrations/delivery/service";
import { notifyShipmentFailed, notifyConnectionError } from "@/lib/notifications";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/** Loads the order number + provider name a shipment-failed notification needs. */
async function shipmentNotificationContext(shipmentId: string) {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, orderId: true, failedReason: true, order: { select: { orderNumber: true } }, provider: { select: { name: true } } },
  });
  return s
    ? {
        id: s.id,
        orderId: s.orderId,
        orderNumber: s.order.orderNumber,
        providerName: s.provider.name,
        reason: s.failedReason,
      }
    : null;
}

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createShippingProviderAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = createShippingProviderSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type") || "MANUEL",
    isActive: formData.get("isActive") !== "off",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const provider = await prisma.shippingProvider.create({ data: parsed.data });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipping_provider.created",
    entityType: "ShippingProvider",
    entityId: provider.id,
    newValue: { name: provider.name },
  });

  revalidatePath("/livraison");
  // The full row (never returned to the client — see
  // docs/adr/0004-integration-architecture.md's identical rule for
  // Integration; ShippingProvider carries the same class of field
  // (credentialsEncrypted, config) even though both are still null right
  // after creation here). Phase 30 hardening.
  return actionOk({ id: provider.id });
}

/**
 * Deletes a shipping provider. Refused (friendly message) if any shipment
 * still references it — `Shipment.provider` is `onDelete: Restrict`, so a
 * provider with delivery history is kept for that history's integrity.
 * Its `ShipmentWebhookEvent` rows cascade-delete with it.
 */
export async function deleteShippingProviderAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = shippingProviderIdSchema.safeParse({ id: formData.get("id") });
  if (!parsed.success) return actionError("Prestataire invalide.");

  const provider = await prisma.shippingProvider.findUnique({
    where: { id: parsed.data.id },
    include: { _count: { select: { shipments: true } } },
  });
  if (!provider) return actionError("Prestataire de livraison introuvable.");
  if (provider._count.shipments > 0) {
    return actionError(
      `Impossible de supprimer « ${provider.name} » : ${provider._count.shipments} expédition(s) y sont rattachées. ` +
        "Désactivez-le plutôt pour ne plus l'utiliser."
    );
  }

  try {
    await prisma.shippingProvider.delete({ where: { id: provider.id } });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return actionError("Impossible de supprimer ce prestataire : des expéditions y sont rattachées.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipping_provider.deleted",
    entityType: "ShippingProvider",
    entityId: provider.id,
    previousValue: { name: provider.name, type: provider.type },
  });

  revalidatePath("/livraison");
  return actionOk({ id: provider.id });
}

export async function createShipmentAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = createShipmentSchema.safeParse({
    orderId: formData.get("orderId"),
    providerId: formData.get("providerId"),
    trackingNumber: formData.get("trackingNumber"),
    trackingUrl: formData.get("trackingUrl"),
    cost: formData.get("cost") || undefined,
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order) return actionError("Commande introuvable.");
  // A shipment only makes sense for an order that's actually being
  // prepared/retried for delivery — not a brand-new, cancelled, already
  // shipped/delivered, or returned order. Found during the A–G audit; see
  // docs/adr/0006-delivery-providers.md.
  if (!SHIPPABLE_ORDER_STATUSES.includes(order.status)) {
    return actionError("Cette commande n'est pas dans un statut permettant de créer une expédition.");
  }

  const provider = await prisma.shippingProvider.findUnique({ where: { id: parsed.data.providerId } });
  if (!provider) return actionError("Prestataire de livraison introuvable.");
  // API providers must go through the real adapter call
  // (createShipmentViaProviderAction) so a shipment always has a genuine
  // external parcel behind it — this manual path is for MANUEL/
  // FLOTTE_INTERNE providers only. Found during the Phase 29 E2E audit.
  if (provider.type === "API") {
    return actionError(
      "Ce prestataire est connecté par API : utilisez « Créer une expédition » depuis la commande pour passer par le connecteur réel."
    );
  }

  // reserveShipmentSlot performs the duplicate-active-shipment check and
  // the create inside one advisory-locked transaction, so two concurrent
  // requests for the same order+provider can't both pass a stale check —
  // see its own doc comment (Phase 30 hardening).
  let shipment;
  try {
    shipment = await reserveShipmentSlot(order.id, parsed.data.providerId, {
      trackingNumber: normalizeOptional(parsed.data.trackingNumber),
      trackingUrl: normalizeOptional(parsed.data.trackingUrl),
      cost: parsed.data.cost ?? null,
      notes: normalizeOptional(parsed.data.notes),
      updatedById: user.id,
    });
  } catch (error) {
    return actionError(friendlyDeliveryError(error));
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipment.created",
    entityType: "Shipment",
    entityId: shipment.id,
    metadata: { orderId: order.id },
  });

  revalidatePath("/livraison");
  revalidatePath(`/commandes/${order.id}`);
  return actionOk({ id: shipment.id });
}

export async function updateShipmentStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = updateShipmentStatusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
    failedReason: formData.get("failedReason"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.shipment.findUnique({ where: { id: parsed.data.id }, include: { order: true } });
  if (!existing) return actionError("Expédition introuvable.");

  const result = await applyShipmentStatusTransition({
    shipmentId: existing.id,
    currentStatus: existing.status,
    orderId: existing.orderId,
    currentOrderStatus: existing.order.status,
    newStatus: parsed.data.status,
    updatedById: user.id,
    failedReason: normalizeOptional(parsed.data.failedReason),
  });
  if (!result.ok) {
    return actionError(
      result.reason === "invalid_transition"
        ? `Transition de statut invalide : ${existing.status} → ${parsed.data.status}.`
        : "Cette expédition a été modifiée entre-temps. Rechargez la page et réessayez."
    );
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipment.status_changed",
    entityType: "Shipment",
    entityId: existing.id,
    previousValue: { status: existing.status },
    newValue: { status: parsed.data.status },
  });

  if (parsed.data.status === "ECHEC" && existing.status !== "ECHEC") {
    const ctx = await shipmentNotificationContext(existing.id);
    if (ctx) await notifyShipmentFailed(ctx, user.id);
  }

  revalidatePath("/livraison");
  revalidatePath(`/commandes/${existing.orderId}`);
  return actionOk({ id: existing.id });
}

// --- API connector actions (Phase 22) ---
// See docs/adr/0012-delivery-provider-integration.md.

/**
 * Saves an API-type provider's connector selection + credentials. Never
 * lands on connectionStatus = CONNECTE by itself — see
 * testDeliveryProviderConnectionAction, the only action allowed to do that.
 */
export async function configureDeliveryProviderApiAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = configureDeliveryProviderApiSchema.safeParse({
    providerId: formData.get("providerId"),
    providerKey: formData.get("providerKey"),
    credentialsJson: formData.get("credentialsJson"),
    configJson: formData.get("configJson") || undefined,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const provider = await prisma.shippingProvider.findUnique({ where: { id: parsed.data.providerId } });
  if (!provider) return actionError("Prestataire de livraison introuvable.");
  if (provider.type !== "API") {
    return actionError('Seul un prestataire de type "API" peut recevoir une configuration de connecteur.');
  }
  const available = listDeliveryProviders().map((p) => p.key);
  if (!available.includes(parsed.data.providerKey)) {
    return actionError("Ce connecteur n'est pas disponible sur ce déploiement.");
  }

  await prisma.shippingProvider.update({
    where: { id: provider.id },
    data: {
      providerKey: parsed.data.providerKey,
      credentialsEncrypted: encryptSecret(parsed.data.credentialsJson),
      config: parsed.data.configJson ? JSON.parse(parsed.data.configJson) : undefined,
      // Closes the same gap docs/adr/0010 closed for Integration: saving
      // credentials must never imply a verified connection.
      connectionStatus: "CONFIGURE",
      lastError: null,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipping_provider.api_configured",
    entityType: "ShippingProvider",
    entityId: provider.id,
    metadata: { providerKey: parsed.data.providerKey },
  });

  revalidatePath("/livraison");
  return actionOk({ id: provider.id });
}

/** The only action allowed to set connectionStatus = CONNECTE — performs a
 * real authenticated request via the registered adapter. */
export async function testDeliveryProviderConnectionAction(
  formData: FormData
): Promise<ActionResult<{ status: "CONNECTE"; details?: Record<string, string | number> }>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = providerIdSchema.safeParse({ providerId: formData.get("providerId") });
  if (!parsed.success) return actionError("Prestataire invalide.");

  let result;
  try {
    result = await testProviderConnection(parsed.data.providerId);
  } catch (error) {
    return actionError(friendlyDeliveryError(error));
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: result.status === "CONNECTE" ? "shipping_provider.connection_test_succeeded" : "shipping_provider.connection_test_failed",
    entityType: "ShippingProvider",
    entityId: parsed.data.providerId,
    // `details` are non-secret read-only facts (e.g. city count) — safe in
    // the audit trail; the adapter guarantees no credential/URL is in them.
    ...(result.status === "CONNECTE" && result.details ? { metadata: result.details } : {}),
  });

  revalidatePath("/livraison");
  if (result.status === "ERREUR") {
    const row = await prisma.shippingProvider.findUnique({
      where: { id: parsed.data.providerId },
      select: { name: true },
    });
    await notifyConnectionError(
      {
        entityType: "ShippingProvider",
        entityId: parsed.data.providerId,
        label: row?.name ?? "Prestataire de livraison",
        recipientPermission: "delivery.view",
      },
      user.id
    );
    return actionError(result.error ?? "Échec de la connexion.");
  }
  return actionOk({ status: "CONNECTE", details: result.details });
}

export async function createShipmentViaProviderAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = createShipmentViaProviderSchema.safeParse({
    orderId: formData.get("orderId"),
    providerId: formData.get("providerId"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, include: { customer: true } });
  if (!order) return actionError("Commande introuvable.");
  if (!SHIPPABLE_ORDER_STATUSES.includes(order.status)) {
    return actionError("Cette commande n'est pas dans un statut permettant de créer une expédition.");
  }

  // The duplicate-active-shipment check happens inside createShipmentViaProvider
  // (via reserveShipmentSlot's advisory-locked transaction) — a plain
  // pre-check here would be redundant and, worse, non-atomic (Phase 30
  // hardening: two concurrent requests could both pass a pre-check like
  // this before either committed).
  try {
    const shipment = await createShipmentViaProvider({
      order,
      providerId: parsed.data.providerId,
      updatedById: user.id,
      notes: normalizeOptional(parsed.data.notes),
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "shipment.created",
      entityType: "Shipment",
      entityId: shipment.id,
      metadata: { orderId: order.id, providerId: parsed.data.providerId, externalId: shipment.externalId },
    });

    revalidatePath("/livraison");
    revalidatePath(`/commandes/${order.id}`);
    return actionOk({ id: shipment.id });
  } catch (error) {
    const message = friendlyDeliveryError(error);
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "shipment.creation_failed",
      entityType: "Order",
      entityId: order.id,
      metadata: { providerId: parsed.data.providerId, error: message },
    });
    return actionError(message);
  }
}

export async function cancelShipmentAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = shipmentIdSchema.safeParse({ shipmentId: formData.get("shipmentId") });
  if (!parsed.success) return actionError("Expédition invalide.");

  const shipment = await prisma.shipment.findUnique({ where: { id: parsed.data.shipmentId }, include: { order: true } });
  if (!shipment) return actionError("Expédition introuvable.");

  let result;
  try {
    result = await cancelShipmentViaProvider({ shipment, order: shipment.order, updatedById: user.id });
  } catch (error) {
    return actionError(friendlyDeliveryError(error));
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: result.ok ? "shipment.cancelled" : "shipment.cancellation_failed",
    entityType: "Shipment",
    entityId: shipment.id,
    metadata: result.ok ? undefined : { error: result.error },
  });

  revalidatePath("/livraison");
  revalidatePath(`/commandes/${shipment.orderId}`);
  if (!result.ok) return actionError(result.error);
  return actionOk({ id: shipment.id });
}

/**
 * Bon de Livraison / manifest — groups a batch of EN_ATTENTE API
 * shipments of one provider into a carrier delivery note and stores its
 * printable-document links. See docs/adr/0015-delivery-manifest.md.
 */
export async function generateDeliveryManifestAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = generateManifestSchema.safeParse({
    providerId: formData.get("providerId"),
    shipmentIds: formData.get("shipmentIds") ?? "",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  try {
    const manifest = await generateManifestViaProvider({
      providerId: parsed.data.providerId,
      shipmentIds: parsed.data.shipmentIds,
      createdById: user.id,
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "delivery_manifest.created",
      entityType: "DeliveryManifest",
      entityId: manifest.id,
      metadata: {
        providerId: parsed.data.providerId,
        externalRef: manifest.externalRef,
        parcelCount: manifest.parcelCount,
      },
    });

    revalidatePath("/livraison");
    return actionOk({ id: manifest.id });
  } catch (error) {
    const message = friendlyDeliveryError(error);
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "delivery_manifest.failed",
      entityType: "ShippingProvider",
      entityId: parsed.data.providerId,
      metadata: { error: message, shipmentCount: parsed.data.shipmentIds.length },
    });
    revalidatePath("/livraison");
    return actionError(message);
  }
}

export async function syncShipmentStatusAction(formData: FormData): Promise<ActionResult<{ outcome: SyncShipmentStatusOutcome["outcome"] }>> {
  const user = await requirePermissionForAction("delivery.manage");

  const parsed = shipmentIdSchema.safeParse({ shipmentId: formData.get("shipmentId") });
  if (!parsed.success) return actionError("Expédition invalide.");

  const shipment = await prisma.shipment.findUnique({ where: { id: parsed.data.shipmentId }, include: { order: true } });
  if (!shipment) return actionError("Expédition introuvable.");

  const result = await syncShipmentStatus({ shipment, order: shipment.order, updatedById: user.id });

  if (result.outcome === "error") {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "shipment.status_sync_failed",
      entityType: "Shipment",
      entityId: shipment.id,
      metadata: { error: result.error },
    });
    revalidatePath("/livraison");
    return actionError(result.error);
  }

  if (result.outcome === "updated") {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "shipment.status_changed",
      entityType: "Shipment",
      entityId: shipment.id,
      previousValue: { status: shipment.status },
      newValue: { status: result.newStatus },
      metadata: { source: "provider_sync" },
    });
    if (result.newStatus === "ECHEC" && shipment.status !== "ECHEC") {
      const ctx = await shipmentNotificationContext(shipment.id);
      if (ctx) await notifyShipmentFailed(ctx, user.id);
    }
  }

  revalidatePath("/livraison");
  revalidatePath(`/commandes/${shipment.orderId}`);
  return actionOk({ outcome: result.outcome });
}
