import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma, OrderStatus } from "@prisma/client";
import { canTransitionOrderStatus } from "@/lib/validation/order";
import { canTransitionShipmentStatus, type ShipmentStatusValue } from "@/lib/validation/delivery";

/** Thrown when a conditional status-transition update matches 0 rows. */
export class ShipmentConflictError extends Error {}

/** Order statuses a shipment may be created (or retried) against — see
 * docs/adr/0006-delivery-providers.md. Single source of truth, shared by
 * `createShipmentAction`/`createShipmentViaProviderAction`
 * (src/actions/delivery.ts) and the city-resolution connection-test
 * diagnostic (service.ts) so "which orders still need a shipment" can't
 * silently diverge between the two. */
export const SHIPPABLE_ORDER_STATUSES: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "ECHEC"];

/** Statuses that already have an active (non-terminal, non-failed) API
 * shipment in flight for a given order+provider — a second create request
 * against the same pair is refused rather than risking two real-world
 * parcels from one accidental double submission. See docs/adr/0012,
 * "Retry / concurrency safety". This narrows, but does not eliminate, the
 * residual race under genuinely concurrent requests — see the ADR.
 * Anything else (ECHEC, ANNULE, RETOURNE) has no live external parcel
 * standing in the way, so a fresh attempt against the same order+provider
 * is allowed. Shared for the same reason as SHIPPABLE_ORDER_STATUSES
 * above. */
export const ACTIVE_SHIPMENT_STATUSES: ShipmentStatusValue[] = ["EN_ATTENTE", "EN_TRANSIT"];

export type ShipmentTransitionResult =
  | { ok: true }
  | { ok: false; reason: "invalid_transition" | "conflict" };

/**
 * The one place that transitions Shipment.status, shared by the manual
 * "Modifier le statut" Server Action (src/actions/delivery.ts) and
 * provider-driven status synchronization (manual "Synchroniser" action;
 * future webhook ingestion) — see
 * docs/adr/0012-delivery-provider-integration.md, "Status synchronization".
 * Keeping this in one place means the LIVRE -> order auto-advance rule
 * (docs/adr/0006's audit addendum) and the concurrency-safe conditional
 * update pattern (docs/adr/0002's audit addendum) can't silently diverge
 * between the two call sites.
 */
export async function applyShipmentStatusTransition(params: {
  shipmentId: string;
  currentStatus: ShipmentStatusValue;
  orderId: string;
  currentOrderStatus: OrderStatus;
  newStatus: ShipmentStatusValue;
  updatedById: string | null;
  failedReason?: string | null;
  /** Extra columns to set atomically with the status change (e.g.
   * providerStatusRaw, lastSyncedAt) — never a second, uncoordinated write. */
  extraData?: Prisma.ShipmentUpdateManyMutationInput;
}): Promise<ShipmentTransitionResult> {
  if (!canTransitionShipmentStatus(params.currentStatus, params.newStatus)) {
    return { ok: false, reason: "invalid_transition" };
  }

  const timestamps: Record<string, Date> = {};
  if (params.newStatus === "EN_TRANSIT") timestamps.shippedAt = new Date();
  if (params.newStatus === "LIVRE") timestamps.deliveredAt = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      // Same conditional-update + row-count-check concurrency pattern as
      // Order/Refund status transitions — see docs/adr/0002's audit
      // addendum.
      const result = await tx.shipment.updateMany({
        where: { id: params.shipmentId, status: params.currentStatus },
        data: {
          status: params.newStatus,
          ...(params.newStatus === "ECHEC" ? { failedReason: params.failedReason ?? null } : {}),
          updatedById: params.updatedById,
          ...timestamps,
          ...params.extraData,
        },
      });
      if (result.count === 0) {
        throw new ShipmentConflictError();
      }

      // A shipment reaching LIVRE is the real-world signal that the order
      // was delivered — see docs/adr/0006-delivery-providers.md's audit
      // addendum. Skipped silently (not an error) if the order isn't in
      // EXPEDIEE for some reason; the shipment update is correct either way.
      if (params.newStatus === "LIVRE" && canTransitionOrderStatus(params.currentOrderStatus, "LIVREE")) {
        await tx.order.updateMany({
          where: { id: params.orderId, status: params.currentOrderStatus },
          data: { status: "LIVREE", deliveredAt: new Date() },
        });
      }
    });
  } catch (error) {
    if (error instanceof ShipmentConflictError) {
      return { ok: false, reason: "conflict" };
    }
    throw error;
  }

  return { ok: true };
}
