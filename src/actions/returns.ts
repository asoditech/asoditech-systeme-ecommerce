"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { resolveOrderStockWarehouseId } from "@/lib/inventory";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { confirmPhysicalReturnSchema, type ConfirmPhysicalReturnInput } from "@/lib/validation/returns";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { resolveExactCode } from "@/lib/catalog/exact-code";
import type { ScannedUnit } from "@/lib/returns/scan";
import {
  mergeReturnLines,
  recordPhysicalReturn,
  NoWarehouseError,
  ReturnCeilingExceededError,
  type TouchedStockRefs,
} from "@/lib/returns/physical-return";

/**
 * Confirm a physical-return event on a shipped order — the ONLY mechanism
 * that credits physically-returned stock back to InventoryItem
 * (docs/adr/0036-inventory-single-source-of-truth.md). Fully decoupled
 * from `Order.status`: never changes it, and is never triggered by a
 * status change (RETOUR/ANNULEE are workflow labels only — see
 * src/actions/orders.ts).
 *
 * One order can have several return events over time (partial returns);
 * each line is split between sellable (restored to on-hand) and damaged
 * (recorded in quantityDamaged, never on-hand). The cumulative returned
 * quantity per order item is hard-capped, transactionally, by what
 * EXPEDIEE actually consumed for that item (its own `quantity` — no
 * split-shipment support in this version, so "consumed" is simply the
 * order item's full quantity once the order has shipped).
 *
 * Concurrency: a `SELECT ... FOR UPDATE` on the order row (same technique
 * as `createRefundAction`'s identical race) serializes every physical
 * -return submission for this order — two concurrent requests can never
 * both read the same "remaining" quantity and both apply, because the
 * second is blocked until the first's transaction (and its newly
 * inserted `OrderReturnLine` rows) has committed.
 *
 * Idempotency: `@@unique([orderId, idempotencyKey])` on `OrderReturn` — a
 * retry of the exact same (orderId, idempotencyKey) is a silent no-op
 * (returns the existing event's id), never a second event or a second set
 * of inventory movements.
 */
export async function confirmPhysicalReturnAction(
  input: ConfirmPhysicalReturnInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.return");

  const parsed = confirmPhysicalReturnSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    include: { items: true },
  });
  if (!order) return actionError("Commande introuvable.");
  if (order.shippedAt === null) {
    return actionError("Cette commande n'a pas encore été expédiée — aucune unité physique à retourner.");
  }

  // Location Access Management v1 (docs/adr/0037): a physical return must
  // resolve to the SAME warehouse the order actually shipped from (never a
  // new selector — see resolveOrderStockWarehouseId's own doc comment) —
  // authorization checks that exact warehouse. `fulfillmentWarehouseId` is
  // null only for a pre-32b legacy order; resolve the same way
  // applyPhysicalReturnLine's own per-line loop below will, using the
  // order's first line as the representative case (every item resolves to
  // the SAME warehouse once `preferredWarehouseId` is set, which it always
  // is for any order created after 32b).
  const primaryWarehouseId =
    order.fulfillmentWarehouseId ??
    (order.items[0]
      ? await resolveOrderStockWarehouseId(prisma, order.items[0], null)
      : null);
  if (primaryWarehouseId) {
    await requireLocationAccessForAction(user, primaryWarehouseId);
  }

  const itemsById = new Map(order.items.map((i) => [i.id, i]));
  for (const line of parsed.data.lines) {
    if (!itemsById.has(line.orderItemId)) {
      return actionError("Une ligne de retour référence un article qui n'appartient pas à cette commande.");
    }
  }

  // Merge duplicate lines for the same order item within one request — the
  // ceiling check must see the true combined request, not let a split
  // submission of the same item across two lines bypass it.
  const mergedLines = mergeReturnLines(parsed.data.lines);

  // The transaction body (lock, idempotency, ceilings, return event + lines,
  // stock movements, audit) lives in src/lib/returns/physical-return.ts —
  // shared with the P3 returns workspace inspection, unchanged.
  let returnId: string;
  let touchedRefs: TouchedStockRefs;
  try {
    ({ returnId, touchedRefs } = await prisma.$transaction((tx) =>
      recordPhysicalReturn(tx, {
        order,
        userId: user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        note: parsed.data.note,
        mergedLines,
      })
    ));
  } catch (error) {
    if (error instanceof ReturnCeilingExceededError || error instanceof NoWarehouseError) {
      return actionError(error.message);
    }
    throw error;
  }

  // Best-effort, after commit — same convention as every other stock
  // mutation (checkAndNotifyLowStock resolves a stale low-stock alert now
  // that units are back; pushStockAfterLocalChange pushes the new
  // sellable number outward for every order source, docs/adr/0036).
  if (touchedRefs.productIds.length > 0 || touchedRefs.variationIds.length > 0) {
    await checkAndNotifyLowStock(touchedRefs);
    await pushStockAfterLocalChange(touchedRefs);
  }

  revalidatePath("/commandes");
  revalidatePath(`/commandes/${parsed.data.orderId}`);
  return actionOk({ id: returnId });
}

/**
 * Return dialogs' « Scanner »: a scanned / typed code → the ONE catalogue
 * unit it stands for (shared exact resolver — barcode, variation SKU or
 * simple-product SKU; never a name, partial or ambiguous match). Read-only:
 * the dialog matches it to its own lines (src/lib/returns/scan.ts) and the
 * return itself still goes through confirmPhysicalReturnAction /
 * createSaleReturnAction with every server-side guarantee unchanged.
 */
export async function resolveReturnCodeAction(input: {
  code: string;
  scope: "order" | "sale";
}): Promise<ActionResult<ScannedUnit>> {
  await requirePermissionForAction(input.scope === "sale" ? "sales.return" : "orders.return");
  const resolved = await resolveExactCode(prisma, String(input.code ?? ""));
  if (!resolved.ok) return actionError(resolved.error);
  const u = resolved.unit;
  return actionOk({
    productId: u.productId,
    variationId: u.variationId,
    label: u.variantLabel ? `${u.name} — ${u.variantLabel}` : u.name,
  });
}
