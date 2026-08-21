"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { applyShipmentStatusTransition } from "@/lib/delivery";
import {
  createShippingProviderSchema,
  createShipmentSchema,
  updateShipmentStatusSchema,
  configureDeliveryProviderApiSchema,
  createShipmentViaProviderSchema,
  providerIdSchema,
  shipmentIdSchema,
} from "@/lib/validation/delivery";
import { encryptSecret } from "@/lib/crypto";
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import {
  testProviderConnection,
  createShipmentViaProvider,
  cancelShipmentViaProvider,
  syncShipmentStatus,
  friendlyDeliveryError,
  type SyncShipmentStatusOutcome,
} from "@/lib/integrations/delivery/service";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import type { ShippingProvider, OrderStatus, ShipmentStatus } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Orders a shipment can legitimately be created against — see docs/adr/0006-delivery-providers.md. */
const SHIPPABLE_ORDER_STATUSES: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "ECHEC"];

export async function createShippingProviderAction(formData: FormData): Promise<ActionResult<ShippingProvider>> {
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
  return actionOk(provider);
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

  const shipment = await prisma.shipment.create({
    data: {
      orderId: parsed.data.orderId,
      providerId: parsed.data.providerId,
      trackingNumber: normalizeOptional(parsed.data.trackingNumber),
      trackingUrl: normalizeOptional(parsed.data.trackingUrl),
      cost: parsed.data.cost ?? null,
      notes: normalizeOptional(parsed.data.notes),
      updatedById: user.id,
    },
  });

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
): Promise<ActionResult<{ status: "CONNECTE" | "ERREUR" }>> {
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
  });

  revalidatePath("/livraison");
  if (result.status === "ERREUR") return actionError(result.error ?? "Échec de la connexion.");
  return actionOk({ status: "CONNECTE" });
}

/** Statuses that already have an active (non-terminal, non-failed) API
 * shipment in flight for a given order+provider — a second create request
 * against the same pair is refused rather than risking two real-world
 * parcels from one accidental double submission. See docs/adr/0012,
 * "Retry / concurrency safety". This narrows, but does not eliminate, the
 * residual race under genuinely concurrent requests — see the ADR. */
const ACTIVE_SHIPMENT_STATUSES: ShipmentStatus[] = ["EN_ATTENTE", "EN_TRANSIT"];

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

  const existingActive = await prisma.shipment.findFirst({
    where: { orderId: order.id, providerId: parsed.data.providerId, status: { in: ACTIVE_SHIPMENT_STATUSES } },
  });
  if (existingActive) {
    return actionError("Une expédition est déjà en cours pour cette commande auprès de ce prestataire.");
  }

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
  }

  revalidatePath("/livraison");
  revalidatePath(`/commandes/${shipment.orderId}`);
  return actionOk({ outcome: result.outcome });
}
