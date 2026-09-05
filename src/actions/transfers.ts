"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { InsufficientStockError } from "@/lib/inventory";
import {
  dispatchTransfer,
  receiveTransfer,
  TransferConflictError,
  TransferValidationError,
} from "@/lib/transfers";
import {
  createStockTransferSchema,
  updateStockTransferDraftSchema,
  dispatchStockTransferSchema,
  receiveStockTransferSchema,
  cancelStockTransferSchema,
  type CreateStockTransferInput,
  type UpdateStockTransferDraftInput,
  type ReceiveStockTransferInput,
} from "@/lib/validation/transfer";
import { listStockAtWarehouse } from "@/lib/queries/transfers";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/** The affected product/variation refs for a transfer's own lines — a
 * transfer's lines don't change across dispatch/receive, so this is safe
 * to read fresh right after either action commits. */
async function transferStockRefs(transferId: string) {
  const lines = await prisma.stockTransferLine.findMany({
    where: { stockTransferId: transferId },
    select: { productId: true, variationId: true },
  });
  return { productIds: lines.map((l) => l.productId), variationIds: lines.map((l) => l.variationId) };
}

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

const CONFLICT_MESSAGE =
  "Ce transfert a été modifié entre-temps par une autre action. Rechargez la page et réessayez.";

interface ResolvedLine {
  productId: string | null;
  variationId: string | null;
  quantitySent: number;
}

/** Resolve + validate each draft line's product/variation server-side. */
async function resolveLines(
  lines: { productId?: string | null; variationId?: string | null; quantitySent: number }[]
): Promise<{ ok: true; lines: ResolvedLine[] } | { ok: false; error: string }> {
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    if (line.variationId) {
      const variation = await prisma.productVariation.findUnique({ where: { id: line.variationId } });
      if (!variation) return { ok: false, error: "Une variation sélectionnée est introuvable." };
      resolved.push({ productId: variation.productId, variationId: variation.id, quantitySent: line.quantitySent });
    } else if (line.productId) {
      const product = await prisma.product.findUnique({ where: { id: line.productId } });
      if (!product) return { ok: false, error: "Un produit sélectionné est introuvable." };
      resolved.push({ productId: product.id, variationId: null, quantitySent: line.quantitySent });
    } else {
      return { ok: false, error: "Chaque ligne doit référencer un produit ou une variation." };
    }
  }
  return { ok: true, lines: resolved };
}

/** Physically-held stock at a warehouse, for the create form's line picker. */
export async function listSourceStockAction(warehouseId: string) {
  await requirePermissionForAction("inventory.transfer");
  if (!warehouseId) return [];
  return listStockAtWarehouse(warehouseId);
}

export async function createStockTransferAction(
  input: CreateStockTransferInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.transfer");

  const parsed = createStockTransferSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const [source, destination] = await Promise.all([
    prisma.warehouse.findUnique({ where: { id: parsed.data.sourceWarehouseId } }),
    prisma.warehouse.findUnique({ where: { id: parsed.data.destinationWarehouseId } }),
  ]);
  if (!source || !destination) return actionError("Entrepôt source ou destination introuvable.");
  if (!source.isActive || !destination.isActive) {
    return actionError("La source et la destination doivent toutes deux être actives.");
  }

  const resolved = await resolveLines(parsed.data.lines);
  if (!resolved.ok) return actionError(resolved.error);

  const transfer = await prisma.stockTransfer.create({
    data: {
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      notes: normalizeOptional(parsed.data.notes),
      createdById: user.id,
      lines: { create: resolved.lines },
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stock_transfer.created",
    entityType: "StockTransfer",
    entityId: transfer.id,
    newValue: {
      transferNumber: transfer.transferNumber,
      sourceWarehouseId: source.id,
      destinationWarehouseId: destination.id,
      lineCount: resolved.lines.length,
    },
  });

  revalidatePath("/transferts");
  return actionOk({ id: transfer.id });
}

export async function updateStockTransferDraftAction(
  input: UpdateStockTransferDraftInput
): Promise<ActionResult<IdResult>> {
  await requirePermissionForAction("inventory.transfer");

  const parsed = updateStockTransferDraftSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.stockTransfer.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Transfert introuvable.");

  const resolved = await resolveLines(parsed.data.lines);
  if (!resolved.ok) return actionError(resolved.error);

  try {
    await prisma.$transaction(async (tx) => {
      // Conditional gate: only a BROUILLON draft is editable, and only its
      // lines + notes (source/destination are immutable after creation).
      const gate = await tx.stockTransfer.updateMany({
        where: { id: parsed.data.id, status: "BROUILLON" },
        data: { notes: normalizeOptional(parsed.data.notes) },
      });
      if (gate.count === 0) throw new TransferConflictError();
      await tx.stockTransferLine.deleteMany({ where: { stockTransferId: parsed.data.id } });
      await tx.stockTransferLine.createMany({
        data: resolved.lines.map((l) => ({ ...l, stockTransferId: parsed.data.id })),
      });
    });
  } catch (error) {
    if (error instanceof TransferConflictError) {
      return actionError("Seul un transfert au statut « brouillon » peut être modifié.");
    }
    throw error;
  }

  revalidatePath("/transferts");
  revalidatePath(`/transferts/${parsed.data.id}`);
  return actionOk({ id: parsed.data.id });
}

export async function dispatchStockTransferAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.transfer");

  const parsed = dispatchStockTransferSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  let result;
  try {
    result = await dispatchTransfer(parsed.data.id, user.id);
  } catch (error) {
    if (error instanceof InsufficientStockError) return actionError(error.message);
    if (error instanceof TransferConflictError) return actionError(CONFLICT_MESSAGE);
    if (error instanceof TransferValidationError) return actionError(error.message);
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stock_transfer.dispatched",
    entityType: "StockTransfer",
    entityId: parsed.data.id,
    metadata: { transferNumber: result.transferNumber },
  });

  // Dispatch just reduced the source warehouse's on-hand stock — a
  // linked store needs to hear about that too.
  await pushStockAfterLocalChange(await transferStockRefs(parsed.data.id));

  revalidatePath("/transferts");
  revalidatePath(`/transferts/${parsed.data.id}`);
  revalidatePath("/stock");
  return actionOk({ id: parsed.data.id });
}

export async function receiveStockTransferAction(
  input: ReceiveStockTransferInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.transfer");

  const parsed = receiveStockTransferSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  let result;
  try {
    result = await receiveTransfer(parsed.data.id, user.id, parsed.data.lines);
  } catch (error) {
    if (error instanceof InsufficientStockError) return actionError(error.message);
    if (error instanceof TransferConflictError) return actionError(CONFLICT_MESSAGE);
    if (error instanceof TransferValidationError) return actionError(error.message);
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stock_transfer.received",
    entityType: "StockTransfer",
    entityId: parsed.data.id,
    metadata: { transferNumber: result.transferNumber, hasShortfall: result.hasShortfall },
  });

  // Receiving just increased the destination warehouse's on-hand stock —
  // a linked store needs to hear about that too.
  await pushStockAfterLocalChange(await transferStockRefs(parsed.data.id));

  revalidatePath("/transferts");
  revalidatePath(`/transferts/${parsed.data.id}`);
  revalidatePath("/stock");
  return actionOk({ id: parsed.data.id });
}

export async function cancelStockTransferAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.transfer");

  const parsed = cancelStockTransferSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const existing = await prisma.stockTransfer.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Transfert introuvable.");

  const gate = await prisma.stockTransfer.updateMany({
    where: { id: parsed.data.id, status: "BROUILLON" },
    data: { status: "ANNULE" },
  });
  if (gate.count === 0) {
    return actionError("Seul un transfert au statut « brouillon » peut être annulé.");
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stock_transfer.cancelled",
    entityType: "StockTransfer",
    entityId: parsed.data.id,
    previousValue: { status: existing.status },
    newValue: { status: "ANNULE" },
  });

  revalidatePath("/transferts");
  revalidatePath(`/transferts/${parsed.data.id}`);
  return actionOk({ id: parsed.data.id });
}
