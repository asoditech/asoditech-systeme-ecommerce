"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  createShippingProviderSchema,
  createShipmentSchema,
  updateShipmentStatusSchema,
  canTransitionShipmentStatus,
} from "@/lib/validation/delivery";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import type { ShippingProvider } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

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

  const existing = await prisma.shipment.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Expédition introuvable.");
  if (!canTransitionShipmentStatus(existing.status, parsed.data.status)) {
    return actionError(`Transition de statut invalide : ${existing.status} → ${parsed.data.status}.`);
  }

  const timestamps: Record<string, Date> = {};
  if (parsed.data.status === "EN_TRANSIT") timestamps.shippedAt = new Date();
  if (parsed.data.status === "LIVRE") timestamps.deliveredAt = new Date();

  const shipment = await prisma.shipment.update({
    where: { id: parsed.data.id },
    data: {
      status: parsed.data.status,
      failedReason: parsed.data.status === "ECHEC" ? normalizeOptional(parsed.data.failedReason) : existing.failedReason,
      updatedById: user.id,
      ...timestamps,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipment.status_changed",
    entityType: "Shipment",
    entityId: shipment.id,
    previousValue: { status: existing.status },
    newValue: { status: shipment.status },
  });

  revalidatePath("/livraison");
  return actionOk({ id: shipment.id });
}
