import "server-only";

import { prisma } from "@/lib/prisma";
import { applyStockMovement, ensureInventoryItem, InsufficientStockError } from "@/lib/inventory";
import { formatTransferNumber } from "@/lib/format";

/**
 * Stock transfer service — the two stock-moving lifecycle steps, each in
 * ONE transaction (Phase 32b — docs/adr/0020-stock-transfers.md).
 *
 * `applyStockMovement` stays the canonical stock primitive; these
 * functions only orchestrate the conditional status transition + the
 * per-line movements around it. Permission checks, audit, and cache
 * revalidation live in src/actions/transfers.ts.
 */

/** Thrown when a conditional status-transition update matches 0 rows —
 * a concurrent dispatch/receive/cancel already moved the transfer on. */
export class TransferConflictError extends Error {}

/** Thrown for a business-rule violation the caller turns into an actionError
 * (transfer missing, destination inactive, received quantity out of range). */
export class TransferValidationError extends Error {}

export interface DispatchResult {
  transferNumber: number;
}

/**
 * BROUILLON → EN_TRANSIT. Then one TRANSFERT_SORTIE movement per line at
 * the source. Any insufficient stock OR a missing source InventoryItem
 * rolls the whole transaction back — no partial dispatch, status stays
 * BROUILLON. Does NOT require the source warehouse to still be active
 * (drain-then-deactivate).
 */
export async function dispatchTransfer(transferId: string, userId: string): Promise<DispatchResult> {
  return prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: { lines: true, destination: { select: { name: true } } },
    });
    if (!transfer) throw new TransferValidationError("Transfert introuvable.");

    const gate = await tx.stockTransfer.updateMany({
      where: { id: transferId, status: "BROUILLON" },
      data: { status: "EN_TRANSIT", dispatchedById: userId, dispatchedAt: new Date() },
    });
    if (gate.count === 0) throw new TransferConflictError();

    const reason = `Transfert ${formatTransferNumber(transfer.transferNumber)} → ${transfer.destination.name}`;
    for (const line of transfer.lines) {
      // A line whose catalogue record was deleted has no stock ref — nothing
      // to move (mirrors the orphaned-order-line handling in inventory.ts).
      if (!line.productId && !line.variationId) continue;
      const result = await applyStockMovement(tx, {
        warehouseId: transfer.sourceWarehouseId,
        productId: line.productId,
        variationId: line.variationId,
        type: "TRANSFERT_SORTIE",
        quantity: line.quantitySent,
        onHandDelta: -line.quantitySent,
        performedById: userId,
        reason,
        stockTransferId: transfer.id,
      });
      // No InventoryItem at the source (someone deleted the row between draft
      // and dispatch) — treat exactly like insufficient stock: fail the whole
      // transaction, no partial dispatch.
      if (!result.applied) {
        throw new InsufficientStockError(
          "Stock introuvable à l'entrepôt source pour un article du transfert."
        );
      }
    }

    return { transferNumber: transfer.transferNumber };
  });
}

export interface ReceiveResult {
  transferNumber: number;
  hasShortfall: boolean;
}

/**
 * EN_TRANSIT → RECU. Requires the destination to still be active. Applies
 * one TRANSFERT_ENTREE movement per line for its received quantity
 * (0 ≤ received ≤ sent), creating the destination InventoryItem row if it
 * doesn't exist. Partial receive is allowed; a shortfall is recorded only
 * on `quantityReceived` — stock is never returned to the source. A line
 * whose catalogue record was deleted (both refs null) is skipped safely.
 */
export async function receiveTransfer(
  transferId: string,
  userId: string,
  received: { lineId: string; quantityReceived: number }[]
): Promise<ReceiveResult> {
  const receivedById = new Map(received.map((r) => [r.lineId, r.quantityReceived]));

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.stockTransfer.findUnique({
      where: { id: transferId },
      include: {
        lines: true,
        source: { select: { name: true } },
        destination: { select: { isActive: true } },
      },
    });
    if (!transfer) throw new TransferValidationError("Transfert introuvable.");

    // Validate every line has a received quantity within [0, quantitySent].
    for (const line of transfer.lines) {
      const qty = receivedById.get(line.id);
      if (qty === undefined) {
        throw new TransferValidationError("Quantité reçue manquante pour une ligne du transfert.");
      }
      if (qty < 0 || qty > line.quantitySent) {
        throw new TransferValidationError(
          "La quantité reçue doit être comprise entre 0 et la quantité envoyée."
        );
      }
    }

    const gate = await tx.stockTransfer.updateMany({
      where: { id: transferId, status: "EN_TRANSIT" },
      data: { status: "RECU", receivedById: userId, receivedAt: new Date() },
    });
    if (gate.count === 0) throw new TransferConflictError();

    if (!transfer.destination.isActive) {
      throw new TransferValidationError("L'entrepôt de destination est inactif — réactivez-le pour recevoir ce transfert.");
    }

    const reason = `Transfert ${formatTransferNumber(transfer.transferNumber)} ← ${transfer.source.name}`;
    let hasShortfall = false;
    for (const line of transfer.lines) {
      const qty = receivedById.get(line.id)!;
      await tx.stockTransferLine.update({ where: { id: line.id }, data: { quantityReceived: qty } });
      if (qty < line.quantitySent) hasShortfall = true;

      // Deleted catalogue record → nothing to add anywhere; the recorded
      // quantityReceived above is the only evidence needed.
      if (!line.productId && !line.variationId) continue;
      if (qty === 0) continue;

      await ensureInventoryItem(tx, {
        warehouseId: transfer.destinationWarehouseId,
        productId: line.productId,
        variationId: line.variationId,
      });
      await applyStockMovement(tx, {
        warehouseId: transfer.destinationWarehouseId,
        productId: line.productId,
        variationId: line.variationId,
        type: "TRANSFERT_ENTREE",
        quantity: qty,
        onHandDelta: qty,
        performedById: userId,
        reason,
        stockTransferId: transfer.id,
      });
    }

    return { transferNumber: transfer.transferNumber, hasShortfall };
  });
}
