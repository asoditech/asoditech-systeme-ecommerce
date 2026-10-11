import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { OrderStatus, ShipmentCostSource } from "@prisma/client";
import { canTransitionOrderStatus } from "@/lib/validation/order";
import { canTransitionShipmentStatus, type ShipmentStatusValue } from "@/lib/validation/delivery";
import { reconcileOrderCommission } from "@/lib/commissions";
import { recordAuditEvent } from "@/lib/audit";
import { fulfillStockForOrder, InsufficientStockError } from "@/lib/inventory";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { PACKING_NOT_VERIFIED_MESSAGE } from "@/lib/packing";
import { isPackingRequired } from "@/lib/packing-settings";

/** « Taux de livraison réussie » — the one definition lives in src/lib/metrics/formulas.ts. */
export { deliveryOutcomeRate } from "@/lib/metrics/formulas";

/** Thrown when a conditional status-transition update matches 0 rows. */
export class ShipmentConflictError extends Error {}

/**
 * An order's stock is deducted ONCE (its first « Expédiée », docs/adr/0036)
 * and its physical returns are capped at the ordered quantity — the model
 * has no second fulfilment cycle. So once goods of an order came back (a
 * recorded physical return, or a parcel the carrier marked « Retourné »
 * whose reception would restock it), the SAME order can't ship again: the
 * new parcel would leave without a deduction and the shelf would count
 * units that are with the customer. A new order is the way to re-send.
 */
export const RESHIP_AFTER_RETURN_MESSAGE =
  "Des articles de cette commande sont revenus (colis retourné ou retour enregistré) : un nouvel envoi doit faire l'objet d'une nouvelle commande.";

export async function orderGoodsCameBack(db: typeof prisma | PrismaTransactionClient, orderId: string): Promise<boolean> {
  const [returnedLines, returnedParcels] = await Promise.all([
    db.orderReturnLine.count({
      where: { orderReturn: { orderId }, OR: [{ quantitySellable: { gt: 0 } }, { quantityDamaged: { gt: 0 } }] },
    }),
    db.shipment.count({ where: { orderId, status: "RETOURNE" } }),
  ]);
  return returnedLines + returnedParcels > 0;
}

/** The order can't be advanced to « Expédiée » for this shipment (packing
 * not verified, stock missing) — carries the French reason. */
class ShipmentOrderBlockedError extends Error {}

/**
 * Statuses in which a shipment's cost becomes financially final — see
 * docs/adr/0032-delivery-cost-rules.md. Once reached, `costFinalizedAt` is
 * set and neither a later carrier re-fetch nor a provider-rule change may
 * rewrite the recorded cost.
 */
export const FINAL_SHIPMENT_STATUSES: ShipmentStatusValue[] = ["LIVRE", "ECHEC", "RETOURNE", "ANNULE"];

export function isFinalShipmentStatus(status: ShipmentStatusValue): boolean {
  return FINAL_SHIPMENT_STATUSES.includes(status);
}

export interface ProviderCostRules {
  returnCost: Prisma.Decimal | number | null;
  failureCost: Prisma.Decimal | number | null;
  /** True for a `type: "API"` provider — the carrier is then the source
   * of truth for a successful delivery's price. */
  isApiProvider: boolean;
  /** The shipment's current cost source, kept for a delivered shipment on
   * a non-API provider (its cost is the operator-entered figure, which
   * has no `ShipmentCostSource` enum value). */
  currentCostSource: ShipmentCostSource | null;
}

/**
 * The single decision point for "what does this shipment cost, now that it
 * has reached a financially final state" (docs/adr/0032).
 *
 *  - `LIVRE` on an API provider → the carrier's own price (`carrierCost`).
 *    NEVER invented: no carrier price ⇒ result stays `null` ("unknown"),
 *    never a placeholder or a fallback figure.
 *  - `LIVRE` on a manual provider → the cost the operator already entered
 *    (`carrierCost` here is really `shipment.cost`), source unchanged.
 *  - `RETOURNE` → the merchant's `provider.returnCost` (null ⇒ 0).
 *  - `ECHEC` / `ANNULE` → the merchant's `provider.failureCost` (null ⇒ 0).
 *
 * Returns `null` for a non-final status (nothing to finalise yet).
 */
export function resolveFinalShipmentCost(
  status: ShipmentStatusValue,
  carrierCost: Prisma.Decimal | number | null,
  rules: ProviderCostRules
): { cost: Prisma.Decimal | null; costSource: ShipmentCostSource | null } | null {
  const dec = (v: Prisma.Decimal | number | null): Prisma.Decimal | null =>
    v === null || v === undefined ? null : v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);

  switch (status) {
    case "LIVRE": {
      const c = dec(carrierCost);
      if (c === null) return { cost: null, costSource: null };
      return { cost: c, costSource: rules.isApiProvider ? "CARRIER_API" : rules.currentCostSource };
    }
    case "RETOURNE":
      return { cost: dec(rules.returnCost) ?? new Prisma.Decimal(0), costSource: "RETURN_RULE" };
    case "ECHEC":
    case "ANNULE":
      return { cost: dec(rules.failureCost) ?? new Prisma.Decimal(0), costSource: "FAILURE_RULE" };
    default:
      return null;
  }
}

/**
 * A short, human-readable summary of an order's line items for a carrier's
 * "contents / nature" field and for pre-filling the shipment notes — e.g.
 * "2× Tablier Élégant (Rouge), 1× Tablier Élégant (Vert)". Uses the
 * name/qty snapshot on the order item (so it's stable even if the product
 * is edited later) plus the variation's attribute values when present.
 * Returns "" for an order with no resolvable items — the caller then sends
 * nothing rather than an empty string.
 */
export function buildParcelContentsSummary(
  items: { nameSnapshot: string; quantity: number; variation?: { attributes: unknown } | null }[]
): string {
  const parts: string[] = [];
  for (const item of items) {
    const name = item.nameSnapshot?.trim();
    if (!name || !Number.isFinite(item.quantity) || item.quantity <= 0) continue;
    let label = `${item.quantity}× ${name}`;
    const attrs = item.variation?.attributes;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const values = Object.values(attrs as Record<string, unknown>)
        .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (values.length > 0) label += ` (${values.join(", ")})`;
    }
    parts.push(label);
  }
  // OzonExpress's own field is not huge — keep it sane.
  return parts.join(", ").slice(0, 500);
}

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
  | {
      ok: true;
      /** The cost that was frozen onto the shipment by this transition,
       * if it reached a financially final state — for the caller's audit
       * event. Absent when no finalisation happened. */
      finalizedCost?: { cost: number | null; costSource: ShipmentCostSource | null };
      /** The order moved to LIVREE with this transition. */
      orderDelivered?: boolean;
    }
  | { ok: false; reason: "invalid_transition" | "conflict" }
  /** A non-active row (ECHEC) would move again (« En transit » / « Livré »)
   * while another parcel of the same order is still in flight: refused —
   * at most one live parcel per order (see reserveShipmentSlot). */
  | { ok: false; reason: "conflict_active"; message: string }
  /** The parcel left / arrived but its order could not be marked
   * « Expédiée » (packing not verified, stock missing): nothing changed. */
  | { ok: false; reason: "order_blocked"; message: string };

/** Shown when an old (failed) parcel is reported moving again while
 * another parcel of the same order is still in flight. */
export const ANOTHER_ACTIVE_SHIPMENT_MESSAGE =
  "Une autre expédition est déjà en cours pour cette commande : ce colis ne peut pas repartir tant qu'elle n'est pas annulée ou terminée.";

/** Postgres advisory-lock key serializing "is there an active parcel for
 * this order?" checks — shared by reserveShipmentSlot and
 * applyShipmentStatusTransition so both take the SAME lock. */
export function shipmentSlotLockKey(orderId: string): string {
  return `shipment-slot:${orderId}`;
}

/** Thrown inside the transition transaction — mapped to `conflict_active`. */
class AnotherActiveShipmentError extends Error {}

/**
 * Order statuses from which a parcel reported « En transit » / « Livré »
 * first advances the order to « Expédiée » (docs/adr/0006 audit addendum,
 * 2026-10 revision). These are exactly the statuses a shipment may be
 * created against (SHIPPABLE_ORDER_STATUSES): CONFIRMEE and ECHEC reach
 * EXPEDIEE through EN_PREPARATION, as in the order state machine.
 */
const AUTO_SHIP_ORDER_STATUSES: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "ECHEC"];

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
  /** The freshest carrier-reported delivery price known to the caller
   * (e.g. from the status-fetch that triggered this transition). Only
   * consulted when `newStatus` is `LIVRE` — see docs/adr/0032. */
  carrierCost?: Prisma.Decimal | number | null;
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

  let finalizedCost: { cost: number | null; costSource: ShipmentCostSource | null } | undefined;
  const parcelMoving = params.newStatus === "EN_TRANSIT" || params.newStatus === "LIVRE";
  const packingRequired = parcelMoving ? await isPackingRequired() : false;
  const actor = params.updatedById
    ? ({ actorType: "USER", actorUserId: params.updatedById } as const)
    : ({ actorType: "SYSTEM", actorUserId: null } as const);
  /** Set when this transition shipped the order's stock (post-commit effects). */
  let stockRefs: { productIds: (string | null)[]; variationIds: (string | null)[] } | null = null;
  let orderDelivered = false;

  // A non-active row (ECHEC) moving again — « En transit », or « Livré »
  // which also closes the order — must not coexist with another in-flight
  // parcel of the same order (two live parcels for one order's goods).
  const reactivating = parcelMoving && !ACTIVE_SHIPMENT_STATUSES.includes(params.currentStatus);

  try {
    await prisma.$transaction(async (tx) => {
      // Same advisory lock as reserveShipmentSlot, taken BEFORE the order
      // row lock: reserveShipmentSlot holds it while inserting a shipment
      // (which takes a key-share lock on the order row), so the opposite
      // order here could deadlock.
      if (reactivating) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shipmentSlotLockKey(params.orderId)}))`;
        const otherActive = await tx.shipment.count({
          where: { orderId: params.orderId, id: { not: params.shipmentId }, status: { in: ACTIVE_SHIPMENT_STATUSES } },
        });
        if (otherActive > 0) throw new AnotherActiveShipmentError();
      }

      // The order row is locked first (after the slot lock above, when
      // taken) and its status re-read under the
      // lock (never trusted from the caller's earlier read): this
      // serializes against updateOrderStatusAction and a concurrent
      // shipment transition, so « Expédiée »'s stock deduction runs at
      // most once — the same shippedAt marker that action uses.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${params.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: params.orderId },
        select: {
          status: true,
          shippedAt: true,
          packedAt: true,
          items: { select: { productId: true, variationId: true, quantity: true } },
        },
      });
      let orderStatus = order.status;

      // Cost finalisation (docs/adr/0032): the moment a shipment reaches a
      // financially final state, freeze its cost from the right source —
      // the carrier's own price for a delivery, the provider's own rule
      // for a return / failure. Never recomputed once `costFinalizedAt` is
      // set (a later carrier re-fetch or a rule change can't touch it).
      let costData: Prisma.ShipmentUpdateManyMutationInput = {};
      if (isFinalShipmentStatus(params.newStatus)) {
        const current = await tx.shipment.findUnique({
          where: { id: params.shipmentId },
          select: {
            cost: true,
            costSource: true,
            costFinalizedAt: true,
            provider: { select: { type: true, returnCost: true, failureCost: true } },
          },
        });
        if (current && current.costFinalizedAt === null) {
          const carrierCost = params.carrierCost ?? current.cost;
          const resolved = resolveFinalShipmentCost(params.newStatus, carrierCost, {
            returnCost: current.provider.returnCost,
            failureCost: current.provider.failureCost,
            isApiProvider: current.provider.type === "API",
            currentCostSource: current.costSource,
          });
          if (resolved) {
            costData = { cost: resolved.cost, costSource: resolved.costSource, costFinalizedAt: new Date() };
            finalizedCost = {
              cost: resolved.cost === null ? null : Number(resolved.cost),
              costSource: resolved.costSource,
            };
          }
        }
      }

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
          ...costData,
        },
      });
      if (result.count === 0) {
        throw new ShipmentConflictError();
      }

      // A parcel in transit or delivered means the goods physically left:
      // an order still before « Expédiée » gets that transition now, with
      // its one-time stock deduction (docs/adr/0036) — never a second time
      // (shippedAt already set = already fulfilled, e.g. an ECHEC retry).
      if (parcelMoving && AUTO_SHIP_ORDER_STATUSES.includes(orderStatus)) {
        if (packingRequired && !order.packedAt) throw new ShipmentOrderBlockedError(PACKING_NOT_VERIFIED_MESSAGE);
        if (order.shippedAt !== null && (await orderGoodsCameBack(tx, params.orderId))) {
          throw new ShipmentOrderBlockedError(RESHIP_AFTER_RETURN_MESSAGE);
        }
        await tx.order.update({ where: { id: params.orderId }, data: { status: "EXPEDIEE", shippedAt: new Date() } });
        if (order.shippedAt === null) {
          try {
            await fulfillStockForOrder(tx, params.orderId, order.items, params.updatedById);
          } catch (error) {
            if (error instanceof InsufficientStockError) throw new ShipmentOrderBlockedError(error.message);
            throw error;
          }
          stockRefs = {
            productIds: order.items.map((i) => i.productId),
            variationIds: order.items.map((i) => i.variationId),
          };
        }
        await recordAuditEvent(
          {
            ...actor,
            action: "order.status_changed",
            entityType: "Order",
            entityId: params.orderId,
            previousValue: { status: orderStatus },
            newValue: { status: "EXPEDIEE" },
            metadata: { via: "shipment", shipmentId: params.shipmentId, shipmentStatus: params.newStatus },
          },
          tx
        );
        orderStatus = "EXPEDIEE";
      }

      // A shipment reaching LIVRE is the real-world signal that the order
      // was delivered — see docs/adr/0006-delivery-providers.md's audit
      // addendum. Skipped (not an error) from a status that can't become
      // LIVREE (RETOUR, ANNULEE…); the shipment update is correct either way.
      if (params.newStatus === "LIVRE" && canTransitionOrderStatus(orderStatus, "LIVREE")) {
        await tx.order.update({ where: { id: params.orderId }, data: { status: "LIVREE", deliveredAt: new Date() } });
        await recordAuditEvent(
          {
            ...actor,
            action: "order.status_changed",
            entityType: "Order",
            entityId: params.orderId,
            previousValue: { status: orderStatus },
            newValue: { status: "LIVREE" },
            metadata: { via: "shipment", shipmentId: params.shipmentId, shipmentStatus: params.newStatus },
          },
          tx
        );
        orderDelivered = true;
      }
    });
  } catch (error) {
    if (error instanceof ShipmentConflictError) {
      return { ok: false, reason: "conflict" };
    }
    if (error instanceof ShipmentOrderBlockedError) {
      return { ok: false, reason: "order_blocked", message: error.message };
    }
    if (error instanceof AnotherActiveShipmentError) {
      return { ok: false, reason: "conflict_active", message: ANOTHER_ACTIVE_SHIPMENT_MESSAGE };
    }
    throw error;
  }

  // Same post-commit effects as updateOrderStatusAction's EXPEDIEE.
  const shippedRefs = stockRefs as { productIds: (string | null)[]; variationIds: (string | null)[] } | null;
  if (shippedRefs) {
    await checkAndNotifyLowStock(shippedRefs);
    await pushStockAfterLocalChange(shippedRefs);
  }

  // A carrier-confirmed delivery just moved the order to LIVREE (above) —
  // credit the confirmation-agent commission. Idempotent, best-effort,
  // outside the status transaction. See docs/adr/0022.
  if (orderDelivered) {
    await reconcileOrderCommission(params.orderId, params.updatedById ?? null);
  }

  return { ok: true, finalizedCost, orderDelivered };
}
