import "server-only";

import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import {
  InsufficientStockError,
  orderLineStockStates,
  reserveStockForOrder,
  type ReservationCeiling,
  type StockRowState,
} from "@/lib/inventory";
import { isDeadlockError, isTransactionTimeoutError } from "@/lib/prisma-errors";
import { recordAuditEvent } from "@/lib/audit";
import { canOverrideStock, parseStockOverrideReason } from "@/lib/auth/stock-override";
import {
  signStockOverrideToken,
  verifyStockOverrideToken,
  type StockOverrideTokenPayload,
} from "@/lib/stock-override-token";
import { actionError, type ActionResult } from "@/actions/types";
import type { Permission } from "@/lib/auth/permissions";
import type { UserRole } from "@prisma/client";

/**
 * P2 — stock validation when an Online order is confirmed.
 *
 * Policy (enforced in `reserveForConfirmation`, inside the confirmation
 * transaction, atomically with the reservation):
 *  - a TRACKED row (product.trackInventory, InventoryItem at the order's
 *    fulfilment warehouse) must cover the order: the reservation runs with
 *    `maxOvercommit: 0` — exactly `enforceAvailable`;
 *  - an authorised override (role + permission + reason + a signed token of
 *    the shortages that were SHOWN) lifts the ceiling ONLY for the shown rows,
 *    and only up to the overcommit that was shown and accepted. Every other
 *    row stays strictly enforced;
 *  - `trackInventory = false`: no ceiling, but the reservation still happens
 *    on an existing row (release/fulfilment stay symmetric);
 *  - no InventoryItem row at the warehouse: nothing to reserve (unchanged),
 *    the confirmation goes through (« Stock non suivi »).
 * A refusal throws `OrderStockShortageError` → the whole transaction rolls
 * back. The shortage answer (with a fresh token) is built AFTER the rollback
 * by `stockShortageResult`, from a separate read — it writes nothing.
 */

export type ConfirmationVia = "queue" | "status_change" | "order_creation";

type RowWithStock = Exclude<StockRowState, { kind: "no_row" }>;

export class OrderStockShortageError extends Error {
  constructor() {
    super("Stock insuffisant pour confirmer cette commande.");
    this.name = "OrderStockShortageError";
  }
}

/** A verified, authorised override, ready to be applied inside the transaction. */
export interface PreparedStockOverride {
  payload: StockOverrideTokenPayload;
  reason: string;
  via: ConfirmationVia;
}

type OverrideActor = { id: string; role: UserRole; permissions: ReadonlySet<Permission> };

/**
 * Validates an override request BEFORE the transaction: role + permission
 * (server-side, never the UI), the 3–500 character reason, and the signed
 * token (signature, expiry, binding to this order/draft and to this actor).
 * `null` input token → no override requested.
 */
export function prepareStockOverride(params: {
  user: OverrideActor;
  bindingId: string;
  token: unknown;
  reason: unknown;
  via: ConfirmationVia;
}): { ok: true; override: PreparedStockOverride | null } | { ok: false; error: string } {
  if (params.token === null || params.token === undefined || params.token === "") return { ok: true, override: null };
  if (!canOverrideStock(params.user)) {
    return { ok: false, error: "Seuls un propriétaire, un administrateur ou un responsable peuvent confirmer malgré une rupture de stock." };
  }
  const reason = parseStockOverrideReason(params.reason);
  if (!reason.ok) return { ok: false, error: reason.error };
  const check = verifyStockOverrideToken(params.token, { orderId: params.bindingId, actorUserId: params.user.id }, env.AUTH_SECRET);
  if (!check.ok) {
    return { ok: false, error: "Cette validation de rupture n'est plus valable. Relancez la confirmation pour voir le stock actuel." };
  }
  return { ok: true, override: { payload: check.payload, reason: reason.reason, via: params.via } };
}

/**
 * Binding id for « Client déjà confirmé » at creation, when no order id exists
 * yet: a fingerprint of the draft (customer, resolved fulfilment warehouse,
 * sorted lines), computed by the server from the submitted order — an
 * override token only applies to the identical cart.
 */
export function draftOrderBindingId(input: {
  customerId: string;
  fulfillmentWarehouseId: string | null;
  lines: { productId?: string | null; variationId?: string | null; quantity: number }[];
}): string {
  const lines = input.lines
    .map((l) => `${l.variationId ?? ""}:${l.productId ?? ""}:${l.quantity}`)
    .sort()
    .join(",");
  const digest = createHash("sha256")
    .update(`${input.customerId}|${input.fulfillmentWarehouseId ?? ""}|${lines}`)
    .digest("hex")
    .slice(0, 40);
  return `draft:${digest}`;
}

export type ConfirmationStockLine = {
  productId: string | null;
  variationId: string | null;
  quantity: number;
  product?: { trackInventory?: boolean } | null;
  variation?: { product?: { trackInventory?: boolean } | null } | null;
};

/**
 * `trackInventory` of an order line — ONE rule for the confirmation check and
 * the queue/page warnings. A variation inherits its product's flag, so the
 * variation's product wins, then the line's product. When the flag was not
 * loaded (relation absent, or loaded without that field) it is UNKNOWN, and
 * unknown means the schema default — tracked: a stock check or warning is
 * never silently skipped because a caller did not select the flag. (A line
 * whose product was deleted has no product/variation id and is skipped before
 * this matters.)
 */
export function lineTrackInventory(line: Pick<ConfirmationStockLine, "product" | "variation">): boolean {
  return line.variation?.product?.trackInventory ?? line.product?.trackInventory ?? true;
}

export function withTracking(lines: ConfirmationStockLine[]) {
  return lines.map((l) => ({
    productId: l.productId,
    variationId: l.variationId,
    quantity: l.quantity,
    trackInventory: lineTrackInventory(l),
  }));
}

/** Prisma `select` for order items carrying what the stock policy needs. */
export const CONFIRMATION_STOCK_ITEM_SELECT = {
  productId: true,
  variationId: true,
  quantity: true,
  product: { select: { trackInventory: true } },
  variation: { select: { product: { select: { trackInventory: true } } } },
} as const;

/**
 * Inside the confirmation transaction: checks the order's stock, writes the
 * override audit when an accepted shortage is actually used, and reserves
 * with the per-row ceilings. Throws `OrderStockShortageError` (→ rollback) on
 * any shortage the override does not cover.
 */
export async function reserveForConfirmation(
  tx: PrismaTransactionClient,
  params: {
    orderId: string;
    fulfillmentWarehouseId: string | null;
    lines: ConfirmationStockLine[];
    /** Null for a store-driven confirmation (order sync), which never carries an override. */
    confirmerUserId: string | null;
    override?: PreparedStockOverride | null;
  }
): Promise<{ overrideUsed: boolean }> {
  const lines = withTracking(params.lines);
  const states = await orderLineStockStates(tx, lines, params.fulfillmentWarehouseId);
  const accepted = new Map((params.override?.payload.rows ?? []).map((r) => [r.rowKey, r]));

  const ceilings = new Map<string, number>();
  const overridden: RowWithStock[] = [];
  for (const s of states) {
    if (s.kind !== "tracked") continue; // untracked: no ceiling; no row: nothing reserved
    if (!s.short) {
      ceilings.set(s.rowKey, 0); // sufficient now → strictly enforced, whatever the token says
      continue;
    }
    const row = accepted.get(s.rowKey);
    // Only a shortage that was shown for THIS demand, and has not grown since.
    if (!row || row.requested !== s.requested || s.overcommit > row.acceptedOvercommit) {
      throw new OrderStockShortageError();
    }
    ceilings.set(s.rowKey, row.acceptedOvercommit);
    overridden.push(s);
  }

  if (overridden.length > 0 && params.override && params.confirmerUserId) {
    await recordAuditEvent(
      {
        actorType: "USER",
        actorUserId: params.confirmerUserId,
        action: "order.stock_override",
        entityType: "Order",
        entityId: params.orderId,
        metadata: {
          reason: params.override.reason,
          via: params.override.via,
          rows: overridden.map((s) => ({
            inventoryItemId: s.inventoryItemId,
            warehouseId: s.warehouseId,
            productId: s.productId,
            variationId: s.variationId,
            requested: s.requested,
            onHand: s.onHand,
            reserved: s.reserved,
            available: s.available,
            acceptedOvercommit: ceilings.get(s.rowKey) ?? 0,
          })),
        },
      },
      tx
    );
  }

  // The ceilings are re-checked on the POST-update row under its lock: a
  // concurrent reservation between the read above and this update can only
  // make the check stricter (→ InsufficientStockError → rollback).
  await reserveStockForOrder(tx, params.orderId, params.lines, params.confirmerUserId, {
    ceiling: confirmationCeiling(ceilings, lines),
  });
  return { overrideUsed: overridden.length > 0 };
}

/**
 * The reservation ceiling used at confirmation. A row the pre-read checked
 * keeps its ceiling (0, or the overcommit an authorised user accepted). A row
 * the pre-read did NOT see — created concurrently, or reached through a
 * different warehouse than the one read — is held to 0 (fully covered by
 * physical stock) when its line is TRACKED: an unknown key must never mean
 * "no check". Untracked products keep their historical no-ceiling behaviour.
 */
export function confirmationCeiling(
  ceilings: ReadonlyMap<string, number>,
  lines: readonly { productId?: string | null; variationId?: string | null; trackInventory: boolean }[]
): ReservationCeiling {
  const untrackedUnits = new Set(
    lines.filter((l) => !l.trackInventory).map((l) => (l.variationId ? `v:${l.variationId}` : `p:${l.productId}`))
  );
  return (rowKey) => {
    const known = ceilings.get(rowKey);
    if (known !== undefined) return known;
    const unit = rowKey.slice(rowKey.indexOf("|") + 1); // stockRowKey = `${warehouseId}|v:…` / `|p:…`
    return untrackedUnits.has(unit) ? undefined : 0;
  };
}

/**
 * The refusal answer, built AFTER the rolled-back transaction from a separate
 * READ-ONLY read: one line per shortage, whether this user may override, and
 * — only for such a user — a signed token of exactly these shortages.
 * Writes nothing, calls nothing external.
 */
export async function stockShortageResult(params: {
  user: OverrideActor;
  bindingId: string;
  fulfillmentWarehouseId: string | null;
  lines: ConfirmationStockLine[];
}): Promise<ActionResult<never>> {
  const states = await orderLineStockStates(prisma, withTracking(params.lines), params.fulfillmentWarehouseId);
  const short = states.filter((s): s is RowWithStock => s.kind === "tracked" && s.short);
  if (short.length === 0) {
    // The shortage disappeared meanwhile (stock received / released): a plain retry will go through.
    return actionError("Le stock a changé pendant la confirmation. Réessayez.");
  }
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: short.map((s) => s.inventoryItemId) } },
    select: {
      id: true,
      warehouse: { select: { name: true } },
      product: { select: { name: true, sku: true } },
      variation: { select: { sku: true, attributes: true, product: { select: { name: true } } } },
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const label = (s: (typeof short)[number]) => {
    const i = byId.get(s.inventoryItemId);
    const name = i?.variation
      ? `${i.variation.product.name}${variantSuffix(i.variation.attributes)} (${i.variation.sku})`
      : i?.product
        ? `${i.product.name} (${i.product.sku})`
        : "Article";
    const over = s.overReserved ? " — déjà surréservé" : "";
    return `${name} — ${i?.warehouse.name ?? "Emplacement"} : demandé ${s.requested}, disponible ${s.available} (en stock ${s.onHand}, réservé ${s.reserved})${over}`;
  };

  const canOverride = canOverrideStock(params.user);
  const fieldErrors: Record<string, string[]> = {
    stockShortage: short.map(label),
    canOverride: [canOverride ? "true" : "false"],
  };
  if (canOverride) {
    fieldErrors.stockOverrideToken = [
      signStockOverrideToken(
        {
          orderId: params.bindingId,
          actorUserId: params.user.id,
          rows: short.map((s) => ({
            rowKey: s.rowKey,
            requested: s.requested,
            onHand: s.onHand,
            reserved: s.reserved,
            acceptedOvercommit: s.overcommit,
          })),
        },
        env.AUTH_SECRET
      ),
    ];
  }
  return actionError("Stock insuffisant pour confirmer cette commande.", fieldErrors);
}

function variantSuffix(attributes: unknown): string {
  if (!attributes || typeof attributes !== "object") return "";
  const parts = Object.values(attributes as Record<string, unknown>).filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? ` ${parts.join(" / ")}` : "";
}

/** Shown when a confirmation lost a lock race (deadlock / expired transaction) — already rolled back, never auto-retried. */
export const STOCK_CONFLICT_RETRY_MESSAGE = "Conflit de stock avec une autre opération en cours — rien n'a été enregistré. Réessayez.";

/** The shortage answer for an EXISTING order (re-read after the rollback; read-only). */
export async function orderStockShortageResult(user: OverrideActor, orderId: string): Promise<ActionResult<never>> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { fulfillmentWarehouseId: true, items: { select: CONFIRMATION_STOCK_ITEM_SELECT } },
  });
  if (!order) return actionError("Commande introuvable.");
  return stockShortageResult({ user, bindingId: orderId, fulfillmentWarehouseId: order.fulfillmentWarehouseId, lines: order.items });
}

/** Lines of a not-yet-created order, with each product's `trackInventory` (read-only). */
export async function draftStockLines(
  items: { productId?: string | null; variationId?: string | null; quantity: number }[]
): Promise<ConfirmationStockLine[]> {
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => Boolean(x)))];
  const variationIds = [...new Set(items.map((i) => i.variationId).filter((x): x is string => Boolean(x)))];
  const [products, variations] = await Promise.all([
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, trackInventory: true } }) : [],
    variationIds.length
      ? prisma.productVariation.findMany({ where: { id: { in: variationIds } }, select: { id: true, product: { select: { trackInventory: true } } } })
      : [],
  ]);
  const p = new Map(products.map((x) => [x.id, x]));
  const v = new Map(variations.map((x) => [x.id, x]));
  return items.map((i) => ({
    productId: i.productId ?? null,
    variationId: i.variationId ?? null,
    quantity: i.quantity,
    product: i.productId ? (p.get(i.productId) ?? null) : null,
    variation: i.variationId ? (v.get(i.variationId) ?? null) : null,
  }));
}

/**
 * Maps a failed confirmation transaction to its answer — or `null` (re-throw)
 * for anything else. A stock shortage → the read-only shortage answer; a
 * verified lock-race shape (deadlock 40P01 / expired transaction P2028) → a
 * plain "retry" message. No automatic retry: the transaction is already
 * rolled back and nothing (audit, notification, stock push) ran.
 */
export async function confirmationFailureResult(
  error: unknown,
  buildShortage: () => Promise<ActionResult<never>>
): Promise<ActionResult<never> | null> {
  if (error instanceof OrderStockShortageError || error instanceof InsufficientStockError) return buildShortage();
  if (isDeadlockError(error) || isTransactionTimeoutError(error)) return actionError(STOCK_CONFLICT_RETRY_MESSAGE);
  return null;
}
