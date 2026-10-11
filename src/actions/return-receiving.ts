"use server";

import { revalidatePath } from "next/cache";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { canReadWarehouse } from "@/lib/auth/location-access";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import { findReturnParcels, type ReturnParcelView } from "@/lib/queries/return-receiving";
import { cancelReturnReception, inspectReturnReception, receiveReturnParcel, type ReceiveParcelResult } from "@/lib/returns/reception";
import {
  cancelReturnReceptionSchema,
  entriesToReturnLines,
  inspectReturnReceptionSchema,
  lookupReturnParcelSchema,
  receiveReturnParcelSchema,
  receiveReturnParcelsSchema,
  type CancelReturnReceptionInput,
  type InspectReturnReceptionInput,
  type LookupReturnParcelInput,
  type ReceiveReturnParcelInput,
  type ReceiveReturnParcelsInput,
} from "@/lib/validation/return-receiving";

/**
 * P3 returns workspace (/livraison/retours) — Server Actions. Same permission
 * as the order page's physical return (`orders.return`); tenant, user and
 * warehouse always come from the session / the database, never the client.
 * No action here calls a carrier API or changes an Order / Shipment status.
 */

const WORKSPACE_PATH = "/livraison/retours";

/** Exact lookup (scan or typed): tracking number, else order number. */
export async function lookupReturnParcelAction(input: LookupReturnParcelInput): Promise<ActionResult<ReturnParcelView[]>> {
  const user = await requirePermissionForAction("orders.return");
  const parsed = lookupReturnParcelSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const found = await findReturnParcels(parsed.data.query);
  if (found.length === 0) return actionError("Aucun colis ne correspond à ce numéro.");
  // Parcels of a warehouse the user can't read are withheld; when that's all
  // of them, say so — within the user's own tenant only (another tenant's
  // parcel is never found at all).
  const readable = found.filter((p) => p.warehouseId !== null && canReadWarehouse(user, p.warehouseId));
  const visible = user.locations.global ? found : readable;
  if (visible.length === 0) return actionError("Non autorisé : accès à cet emplacement non attribué.");
  return actionOk(visible);
}

export async function receiveReturnParcelAction(input: ReceiveReturnParcelInput): Promise<ActionResult<ReceiveParcelResult>> {
  const user = await requirePermissionForAction("orders.return");
  const parsed = receiveReturnParcelSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const result = await receiveReturnParcel(user, parsed.data);
  if (!result.ok) return actionError(result.error);
  revalidatePath(WORKSPACE_PATH);
  return actionOk(result);
}

export interface BatchReceiveItem {
  shipmentId: string;
  result: ReceiveParcelResult;
}

/**
 * Batch reception: each parcel in its OWN transaction, each result reported
 * individually — one invalid / denied / already-inspected parcel never
 * blocks, nor is hidden behind, the others. Never `additional` (a later
 * reception of an already-inspected parcel is always an explicit single act).
 */
export async function receiveReturnParcelsAction(input: ReceiveReturnParcelsInput): Promise<ActionResult<BatchReceiveItem[]>> {
  const user = await requirePermissionForAction("orders.return");
  const parsed = receiveReturnParcelsSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const items: BatchReceiveItem[] = [];
  for (const shipmentId of [...new Set(parsed.data.shipmentIds)]) {
    let result: ReceiveParcelResult;
    try {
      result = await receiveReturnParcel(user, { shipmentId, additional: false });
    } catch {
      result = { ok: false, code: "invalid", error: "Erreur inattendue — réessayez ce colis." };
    }
    items.push({ shipmentId, result });
  }
  revalidatePath(WORKSPACE_PATH);
  return actionOk(items);
}

export async function inspectReturnReceptionAction(
  input: InspectReturnReceptionInput
): Promise<ActionResult<{ orderReturnId: string; replay: boolean }>> {
  const user = await requirePermissionForAction("orders.return");
  const parsed = inspectReturnReceptionSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const result = await inspectReturnReception(user, {
    receptionId: parsed.data.receptionId,
    idempotencyKey: parsed.data.idempotencyKey,
    note: parsed.data.note,
    lines: entriesToReturnLines(parsed.data.entries),
  });
  if (!result.ok) return actionError(result.error);

  // Best-effort, after commit — same as the order page's physical return.
  const refs = result.touchedRefs;
  if (refs.productIds.length > 0 || refs.variationIds.length > 0) {
    await checkAndNotifyLowStock(refs);
    await pushStockAfterLocalChange(refs);
  }
  revalidatePath(WORKSPACE_PATH);
  revalidatePath(`/commandes/${result.orderId}`);
  return actionOk({ orderReturnId: result.orderReturnId, replay: result.replay });
}

/**
 * Voids a reception awaiting inspection (empty / wrong parcel, units already
 * returned elsewhere) with a mandatory reason — see cancelReturnReception.
 * Same permission and location rule as the inspection; no stock change.
 */
export async function cancelReturnReceptionAction(input: CancelReturnReceptionInput): Promise<ActionResult<{ orderId: string }>> {
  const user = await requirePermissionForAction("orders.return");
  const parsed = cancelReturnReceptionSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const result = await cancelReturnReception(user, parsed.data);
  if (!result.ok) return actionError(result.error);
  revalidatePath(WORKSPACE_PATH);
  revalidatePath(`/commandes/${result.orderId}`);
  return actionOk({ orderId: result.orderId });
}
