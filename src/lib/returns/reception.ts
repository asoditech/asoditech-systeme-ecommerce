import "server-only";

import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/session";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { recordAuditEvent } from "@/lib/audit";
import { resolveOrderStockWarehouseId, getDefaultWarehouseId } from "@/lib/inventory";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { RETURN_ELIGIBLE_SHIPMENT_STATUS } from "@/lib/queries/return-receiving";
import { RETURN_RECEPTION_CANCEL_REASON_LABELS, type ReturnReceptionCancelReason } from "@/lib/validation/return-receiving";
import {
  mergeReturnLines,
  recordPhysicalReturn,
  NoWarehouseError,
  ReturnCeilingExceededError,
  type TouchedStockRefs,
} from "@/lib/returns/physical-return";

/**
 * P3 returns workspace — the two persisted stages of a carrier-returned
 * parcel (see the ReturnReception block in prisma/schema.prisma):
 *
 *   receiveReturnParcel   — the parcel physically arrived. Writes ONE
 *     ReturnReception (A_INSPECTER) + an `order.return_received` audit
 *     event. Never a stock movement, never an Order / Shipment status, never
 *     a carrier call.
 *   inspectReturnReception — what was inside, condition chosen per unit.
 *     The shared physical-return transaction (src/lib/returns/physical-
 *     return.ts — lock, ceilings, idempotency, RETOUR/ENDOMMAGE movements,
 *     audit) plus the reception's flip to INSPECTE, in ONE transaction.
 *
 * Both derive tenant (tenant-scoped client + RLS), user (session) and
 * warehouse (the order's ORIGINAL fulfilment warehouse) server-side.
 */

type Actor = Pick<CurrentUser, "id" | "role">;

const LOCATION_DENIED = "Non autorisé : accès à cet emplacement non attribué.";
const PARCEL_NOT_FOUND = "Colis introuvable.";
const RECEPTION_CANCELLED = "Cette réception a été annulée — rechargez la page.";

async function hasLocationAccess(user: Actor, warehouseId: string): Promise<boolean> {
  try {
    await requireLocationAccessForAction(user, warehouseId);
    return true;
  } catch {
    return false;
  }
}

/** The order's ORIGINAL fulfilment warehouse — same resolution as the order
 * page's physical return (src/actions/returns.ts): the order's own
 * `fulfillmentWarehouseId`, else (pre-32b legacy order) its first line's. */
async function originalWarehouseId(order: {
  fulfillmentWarehouseId: string | null;
  items: { productId: string | null; variationId: string | null; quantity: number }[];
}): Promise<string | null> {
  if (order.fulfillmentWarehouseId) return order.fulfillmentWarehouseId;
  const first = order.items[0];
  const resolved = first ? await resolveOrderStockWarehouseId(prisma, first, null) : null;
  return resolved ?? (await getDefaultWarehouseId(prisma));
}

export type ReceiveParcelResult =
  | { ok: true; status: "received"; receptionId: string }
  | { ok: true; status: "already_pending"; receptionId: string; receivedAt: Date }
  | { ok: false; code: "already_inspected" | "nothing_remaining" | "not_eligible" | "denied" | "not_found" | "invalid"; error: string };

export async function receiveReturnParcel(
  user: Actor,
  input: { shipmentId: string; additional: boolean; note?: string | null }
): Promise<ReceiveParcelResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    select: {
      id: true,
      status: true,
      trackingNumber: true,
      order: {
        select: {
          id: true,
          shippedAt: true,
          fulfillmentWarehouseId: true,
          items: { select: { id: true, productId: true, variationId: true, quantity: true } },
        },
      },
    },
  });
  if (!shipment) return { ok: false, code: "not_found", error: PARCEL_NOT_FOUND };

  const warehouseId = await originalWarehouseId(shipment.order);
  if (!warehouseId) return { ok: false, code: "invalid", error: "Aucun entrepôt d'origine pour cette commande." };
  // Location before eligibility: a user without access to the warehouse
  // learns nothing about the parcel's state.
  if (!(await hasLocationAccess(user, warehouseId))) return { ok: false, code: "denied", error: LOCATION_DENIED };

  if (shipment.status !== RETURN_ELIGIBLE_SHIPMENT_STATUS) {
    return {
      ok: false,
      code: "not_eligible",
      error: "Ce colis n'est pas au statut « Retourné » chez le transporteur : il ne peut pas être réceptionné comme retour.",
    };
  }
  if (shipment.order.shippedAt === null) {
    return { ok: false, code: "not_eligible", error: "Cette commande n'a jamais été expédiée — aucune unité physique à recevoir." };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Serializes every reception of this parcel (the partial unique index
      // below is the backstop if anything ever bypasses this lock).
      await tx.$queryRaw`SELECT id FROM "shipments" WHERE id = ${shipment.id} FOR UPDATE`;

      const pending = await tx.returnReception.findFirst({
        where: { shipmentId: shipment.id, status: "A_INSPECTER" },
        select: { id: true, receivedAt: true },
      });
      if (pending) return { ok: true, status: "already_pending", receptionId: pending.id, receivedAt: pending.receivedAt } as const;

      const inspected = await tx.returnReception.findFirst({
        where: { shipmentId: shipment.id, status: "INSPECTE" },
        orderBy: { inspectedAt: "desc" },
        select: { inspectedAt: true },
      });
      if (inspected && !input.additional) {
        return {
          ok: false,
          code: "already_inspected",
          error:
            "Ce colis a déjà été réceptionné et inspecté. S'il manquait des articles qui arrivent maintenant, confirmez une nouvelle réception.",
        } as const;
      }

      // Units still returnable on the order (shipped − every prior return).
      const returned = await tx.orderReturnLine.groupBy({
        by: ["orderItemId"],
        where: { orderReturn: { orderId: shipment.order.id } },
        _sum: { quantitySellable: true, quantityDamaged: true },
      });
      const back = new Map(returned.map((r) => [r.orderItemId, (r._sum.quantitySellable ?? 0) + (r._sum.quantityDamaged ?? 0)]));
      const remaining = shipment.order.items.reduce((s, i) => s + Math.max(0, i.quantity - (back.get(i.id) ?? 0)), 0);
      if (remaining <= 0) {
        return { ok: false, code: "nothing_remaining", error: "Toutes les unités de cette commande ont déjà été retournées." } as const;
      }

      const reception = await tx.returnReception.create({
        data: {
          shipmentId: shipment.id,
          orderId: shipment.order.id,
          warehouseId,
          receivedById: user.id,
          note: input.note && input.note.trim().length > 0 ? input.note.trim() : null,
        },
      });
      await recordAuditEvent(
        {
          actorType: "USER",
          actorUserId: user.id,
          action: "order.return_received",
          entityType: "Order",
          entityId: shipment.order.id,
          newValue: {
            returnReceptionId: reception.id,
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
            warehouseId,
            additional: Boolean(inspected),
          },
        },
        tx
      );
      return { ok: true, status: "received", receptionId: reception.id } as const;
    });
  } catch (error) {
    // The partial unique index "one reception awaiting inspection per
    // shipment" — a concurrent reception won; report it, never a 500.
    if (isUniqueConstraintError(error)) {
      const pending = await prisma.returnReception.findFirst({
        where: { shipmentId: shipment.id, status: "A_INSPECTER" },
        select: { id: true, receivedAt: true },
      });
      if (pending) return { ok: true, status: "already_pending", receptionId: pending.id, receivedAt: pending.receivedAt };
    }
    throw error;
  }
}

export type InspectReceptionResult =
  | { ok: true; orderReturnId: string; replay: boolean; touchedRefs: TouchedStockRefs; orderId: string }
  | { ok: false; error: string };

class InspectionConflictError extends Error {}

export async function inspectReturnReception(
  user: Actor,
  input: {
    receptionId: string;
    idempotencyKey: string;
    note?: string | null;
    lines: { orderItemId: string; quantitySellable: number; quantityDamaged: number }[];
  }
): Promise<InspectReceptionResult> {
  const reception = await prisma.returnReception.findUnique({
    where: { id: input.receptionId },
    select: { id: true, shipmentId: true, warehouseId: true, orderId: true },
  });
  if (!reception) return { ok: false, error: "Réception introuvable." };
  if (!(await hasLocationAccess(user, reception.warehouseId))) return { ok: false, error: LOCATION_DENIED };

  const order = await prisma.order.findUnique({ where: { id: reception.orderId }, include: { items: true } });
  if (!order) return { ok: false, error: "Réception introuvable." };
  if (order.shippedAt === null) {
    return { ok: false, error: "Cette commande n'a pas encore été expédiée — aucune unité physique à retourner." };
  }
  const itemIds = new Set(order.items.map((i) => i.id));
  if (input.lines.some((l) => !itemIds.has(l.orderItemId))) {
    return { ok: false, error: "Une ligne de retour référence un article qui n'appartient pas à cette commande." };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock order: reception, then (inside recordPhysicalReturn) the order.
      // Nothing else locks a reception, and the order-page return locks only
      // the order — no cycle.
      await tx.$queryRaw`SELECT id FROM "return_receptions" WHERE id = ${reception.id} FOR UPDATE`;
      const current = await tx.returnReception.findUnique({
        where: { id: reception.id },
        select: { status: true, orderReturn: { select: { id: true, idempotencyKey: true } } },
      });
      // Cancelled (cancelReturnReception) between the read above and this lock.
      if (!current) throw new InspectionConflictError(RECEPTION_CANCELLED);
      if (current.status === "INSPECTE") {
        // The exact same submission retried → its result; anything else is
        // a second inspection of the same parcel, refused.
        if (current.orderReturn && current.orderReturn.idempotencyKey === input.idempotencyKey) {
          return { ok: true, orderReturnId: current.orderReturn.id, replay: true, touchedRefs: { productIds: [], variationIds: [] }, orderId: order.id } as const;
        }
        throw new InspectionConflictError("Ce colis a déjà été inspecté.");
      }

      const recorded = await recordPhysicalReturn(tx, {
        order,
        userId: user.id,
        idempotencyKey: input.idempotencyKey,
        note: input.note,
        mergedLines: mergeReturnLines(input.lines),
        auditMetadata: { returnReceptionId: reception.id, shipmentId: reception.shipmentId },
        // Every line goes back to its own resolved warehouse — the user must
        // hold access to each one (a legacy order's lines may differ).
        authorizeLineWarehouse: async (warehouseId) => {
          await requireLocationAccessForAction(user, warehouseId, tx);
        },
      });
      if (!recorded.created) {
        // The key already belongs to another return event of this order.
        throw new InspectionConflictError("Cette inspection a déjà été enregistrée par ailleurs — rechargez la page.");
      }

      const flipped = await tx.returnReception.updateMany({
        where: { id: reception.id, status: "A_INSPECTER" },
        data: { status: "INSPECTE", orderReturnId: recorded.returnId, inspectedAt: new Date(), inspectedById: user.id },
      });
      if (flipped.count !== 1) throw new InspectionConflictError("Ce colis a déjà été inspecté.");

      return { ok: true, orderReturnId: recorded.returnId, replay: false, touchedRefs: recorded.touchedRefs, orderId: order.id } as const;
    });
  } catch (error) {
    if (error instanceof ReturnCeilingExceededError || error instanceof NoWarehouseError || error instanceof InspectionConflictError) {
      return { ok: false, error: error.message };
    }
    if (error instanceof Error && error.message === LOCATION_DENIED) return { ok: false, error: LOCATION_DENIED };
    // A concurrent inspection linked this reception first (orderReturnId unique).
    if (isUniqueConstraintError(error)) return { ok: false, error: "Ce colis a déjà été inspecté." };
    throw error;
  }
}

export type CancelReceptionResult = { ok: true; orderId: string } | { ok: false; error: string };

/**
 * Voids a reception that is still awaiting inspection — the explicit way out
 * for a reception that can't be inspected (empty or wrong parcel, or its
 * units were already returned elsewhere, e.g. from the order page).
 *
 * Semantics: no unit was physically received under this reception. Nothing
 * else changes — no stock movement, no Order / Shipment status, no return
 * event; the parcel goes back to « À réceptionner » if units are still
 * outstanding (so the real parcel can be received later, with every quantity
 * control of the inspection intact), else to « Déjà retourné ». An inspected
 * reception can never be cancelled (its return is recorded).
 *
 * Auditable: the row is removed — it is what blocks a new reception — and an
 * `order.return_reception_cancelled` event keeps its full snapshot plus the
 * mandatory reason. Same lock as the inspection (the reception row), so a
 * concurrent inspection and cancellation can never both succeed.
 */
export async function cancelReturnReception(
  user: Actor,
  input: { receptionId: string; reason: ReturnReceptionCancelReason; note?: string | null }
): Promise<CancelReceptionResult> {
  const reception = await prisma.returnReception.findUnique({
    where: { id: input.receptionId },
    select: {
      id: true,
      shipmentId: true,
      orderId: true,
      warehouseId: true,
      receivedById: true,
      receivedAt: true,
      note: true,
      shipment: { select: { trackingNumber: true } },
    },
  });
  if (!reception) return { ok: false, error: "Réception introuvable." };
  if (!(await hasLocationAccess(user, reception.warehouseId))) return { ok: false, error: LOCATION_DENIED };

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "return_receptions" WHERE id = ${reception.id} FOR UPDATE`;
    const current = await tx.returnReception.findUnique({ where: { id: reception.id }, select: { status: true } });
    if (!current) return { ok: false, error: "Cette réception a déjà été annulée." } as const;
    if (current.status !== "A_INSPECTER") {
      return { ok: false, error: "Ce colis a déjà été inspecté : sa réception ne peut plus être annulée." } as const;
    }

    const removed = await tx.returnReception.deleteMany({ where: { id: reception.id, status: "A_INSPECTER" } });
    if (removed.count !== 1) return { ok: false, error: "Cette réception a déjà été annulée." } as const;

    const note = input.note && input.note.trim().length > 0 ? input.note.trim() : null;
    await recordAuditEvent(
      {
        actorType: "USER",
        actorUserId: user.id,
        action: "order.return_reception_cancelled",
        entityType: "Order",
        entityId: reception.orderId,
        previousValue: {
          returnReceptionId: reception.id,
          shipmentId: reception.shipmentId,
          trackingNumber: reception.shipment.trackingNumber,
          warehouseId: reception.warehouseId,
          receivedById: reception.receivedById,
          receivedAt: reception.receivedAt.toISOString(),
          receptionNote: reception.note,
        },
        metadata: { reason: input.reason, reasonLabel: RETURN_RECEPTION_CANCEL_REASON_LABELS[input.reason], note },
      },
      tx
    );
    return { ok: true, orderId: reception.orderId } as const;
  });
}
