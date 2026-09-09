"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { refreshShipmentTracking } from "@/lib/integrations/delivery/tracking-service";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Server actions for the « Suivi » module (docs/adr/0033-tracking-module.md).
 *
 * These NEVER touch the existing delivery status / cost / invoice logic
 * directly — every carrier call goes through `refreshShipmentTracking`,
 * which itself reuses the shared `syncShipmentStatus` for status/cost and
 * only layers the tracking-event read on top. A carrier API failure here
 * never overwrites a valid last-known status (§16 of the brief).
 *
 * View is gated on `delivery.view`; refresh on `delivery.manage`. Cost
 * visibility is enforced in the query layer, not here.
 */

const TRACKING_PATH = "/livraison/suivi";

/** Refresh ONE shipment's tracking. */
export async function refreshTrackingAction(
  formData: FormData
): Promise<ActionResult<{ eventsFetched: boolean; eventCount: number }>> {
  const user = await requirePermissionForAction("delivery.manage");

  const shipmentId = String(formData.get("shipmentId") ?? "");
  if (!shipmentId) return actionError("Expédition invalide.");

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: true },
  });
  if (!shipment) return actionError("Expédition introuvable.");

  const outcome = await refreshShipmentTracking({
    shipment,
    order: shipment.order,
    updatedById: user.id,
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipment.tracking_refreshed",
    entityType: "Shipment",
    entityId: shipment.id,
    metadata: outcome.ok
      ? { source: "suivi_single", eventsFetched: outcome.eventsFetched, eventCount: outcome.eventCount }
      : { source: "suivi_single", error: outcome.error },
  });

  revalidatePath(TRACKING_PATH);
  revalidatePath(`${TRACKING_PATH}/${shipment.id}`);
  revalidatePath("/livraison");
  revalidatePath(`/commandes/${shipment.orderId}`);

  if (!outcome.ok) return actionError(outcome.error);
  return actionOk({ eventsFetched: outcome.eventsFetched, eventCount: outcome.eventCount });
}

/**
 * Bulk "Actualiser le suivi" — a bounded batch per call (Vercel Hobby
 * ~10s). The client button loops while `hasMore` is true. Mirrors
 * `refreshShipmentStatusesAction`: oldest-tracking-sync first, so a
 * never-synced shipment is picked up before one checked recently.
 */
const REFRESH_TRACKING_BATCH = 6;

export async function refreshTrackingBatchAction(): Promise<
  ActionResult<{ checked: number; withEvents: number; failed: number; hasMore: boolean }>
> {
  const user = await requirePermissionForAction("delivery.manage");

  const startedAt = new Date();
  const eligibleWhere: Prisma.ShipmentWhereInput = {
    externalId: { not: null },
    status: { in: ["EN_ATTENTE", "EN_TRANSIT", "ECHEC"] },
    provider: { type: "API" },
  };

  const batch = await prisma.shipment.findMany({
    where: eligibleWhere,
    include: { order: true },
    // Nulls first in Postgres default asc ordering → never-synced first.
    orderBy: { lastTrackingSyncAt: "asc" },
    take: REFRESH_TRACKING_BATCH,
  });

  let withEvents = 0;
  let failed = 0;
  for (const shipment of batch) {
    const outcome = await refreshShipmentTracking({
      shipment,
      order: shipment.order,
      updatedById: user.id,
    });
    if (outcome.ok) {
      if (outcome.eventsFetched) withEvents++;
    } else {
      failed++;
      // refreshShipmentTracking already stamped lastTrackingSyncAt on the
      // failure path, so this shipment won't be retried on the next loop.
    }
  }

  const remaining =
    batch.length < REFRESH_TRACKING_BATCH
      ? 0
      : await prisma.shipment.count({
          where: {
            ...eligibleWhere,
            OR: [{ lastTrackingSyncAt: null }, { lastTrackingSyncAt: { lt: startedAt } }],
          },
        });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "shipment.tracking_refreshed",
    entityType: "Shipment",
    entityId: "batch",
    metadata: { source: "suivi_batch", checked: batch.length, withEvents, failed },
  });

  revalidatePath(TRACKING_PATH);
  revalidatePath("/livraison");
  return actionOk({ checked: batch.length, withEvents, failed, hasMore: remaining > 0 });
}
