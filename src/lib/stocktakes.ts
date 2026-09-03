import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyStockMovement } from "@/lib/inventory";
import { formatStocktakeNumber } from "@/lib/format";

/**
 * Stocktake service — Phase 32c (docs/adr/0021-stocktaking.md).
 *
 * Counting NEVER freezes inventory. A session's `StocktakeLine` rows are a
 * point-in-time snapshot (`systemQuantityAtCount`) taken at creation and
 * re-captured on every count edit. Finalization re-reads the AUTHORITATIVE
 * current on-hand under a row lock, and any counted line whose current
 * on-hand no longer equals its snapshot is STALE — the whole finalize is
 * rejected, the session stays EN_COURS, and zero movements are applied.
 *
 * `applyStockMovement` stays the one stock primitive; the service only
 * orchestrates the conditional status transition + the per-line INVENTAIRE
 * movements around it. Permission checks, audit, and revalidation live in
 * src/actions/stocktakes.ts.
 */

/** Thrown when a conditional status-transition update matches 0 rows —
 * a concurrent finalize/cancel already moved the session on. */
export class StocktakeConflictError extends Error {}

/** Thrown for a business-rule violation the caller turns into an
 * actionError (session missing, not EN_COURS, line not in session). */
export class StocktakeValidationError extends Error {}

/** Thrown when one or more counted lines are stale — finalize is aborted,
 * the session stays EN_COURS, no movement is applied. The affected lines
 * carry a persisted `isStale = true` flag for the UI. */
export class StocktakeStaleError extends Error {
  constructor(public readonly staleLineIds: string[]) {
    super(`${staleLineIds.length} ligne(s) périmée(s)`);
    this.name = "StocktakeStaleError";
  }
}

/**
 * Snapshot EVERY InventoryItem in the warehouse (including zero on-hand
 * rows) into StocktakeLine rows for a freshly-created session. Uses only
 * the InventoryItem records that already exist — never manufactures a row.
 * Product/variation identity is carried by `inventoryItemId`; a
 * variation-backed item and a product-backed item are handled identically.
 */
export async function snapshotWarehouseInventory(
  tx: Prisma.TransactionClient,
  sessionId: string,
  warehouseId: string
): Promise<number> {
  const items = await tx.inventoryItem.findMany({
    where: { warehouseId },
    select: { id: true, quantityOnHand: true },
  });
  if (items.length > 0) {
    await tx.stocktakeLine.createMany({
      data: items.map((i) => ({
        stocktakeSessionId: sessionId,
        inventoryItemId: i.id,
        systemQuantityAtCount: i.quantityOnHand,
      })),
    });
  }
  return items.length;
}

export interface FinalizeResult {
  sessionNumber: number;
  /** Counted lines that produced a non-zero INVENTAIRE movement. */
  appliedCount: number;
  /** Counted lines whose count matched the system — no movement. */
  zeroVarianceCount: number;
  /** Lines never counted in this session — skipped, no movement. */
  uncountedCount: number;
  movementIds: string[];
}

/**
 * EN_COURS → CLOTURE.
 *
 * Phase 1 (own transaction): lock the session, verify EN_COURS, lock the
 * counted lines' InventoryItem rows FOR UPDATE, compare each to its
 * snapshot, and PERSIST `isStale` (true on drifted lines, false on fresh
 * ones). If any stale → throw StocktakeStaleError (session untouched).
 *
 * Phase 2 (own transaction, atomic): conditional gate EN_COURS → CLOTURE
 * (+ closed metadata); re-lock the counted lines' items FOR UPDATE and
 * re-verify freshness (covers a mutation landing between phase 1 and 2 —
 * if so the whole phase-2 transaction rolls back, session back to
 * EN_COURS, no movement); then per counted line apply the signed variance
 * `countedQuantity - currentQuantity` through applyStockMovement
 * (INVENTAIRE, warehouse-explicit, stocktakeSessionId set), persisting
 * `appliedMovementId` on the line. Zero variance → `appliedAt` set, no
 * movement. Uncounted lines are skipped entirely.
 */
export async function finalizeStocktakeSession(sessionId: string, userId: string): Promise<FinalizeResult> {
  // ---- Phase 1: detect + persist stale flags (no status change, no movements) ----
  const staleLineIds = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "stocktake_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
    if (locked.length === 0) throw new StocktakeValidationError("Inventaire introuvable.");
    if (locked[0].status !== "EN_COURS") throw new StocktakeValidationError("Cet inventaire n'est plus en cours.");

    const lines = await tx.stocktakeLine.findMany({
      where: { stocktakeSessionId: sessionId, countedQuantity: { not: null }, appliedAt: null },
      select: { id: true, systemQuantityAtCount: true, inventoryItemId: true },
    });
    if (lines.length === 0) return [] as string[];

    const currentById = await lockCurrentQuantities(tx, lines.map((l) => l.inventoryItemId));

    const stale: string[] = [];
    const fresh: string[] = [];
    for (const l of lines) {
      const current = currentById.get(l.inventoryItemId);
      if (current === undefined || current !== l.systemQuantityAtCount) stale.push(l.id);
      else fresh.push(l.id);
    }
    if (stale.length > 0) {
      await tx.stocktakeLine.updateMany({ where: { id: { in: stale } }, data: { isStale: true } });
    }
    if (fresh.length > 0) {
      await tx.stocktakeLine.updateMany({ where: { id: { in: fresh } }, data: { isStale: false } });
    }
    return stale;
  });

  if (staleLineIds.length > 0) throw new StocktakeStaleError(staleLineIds);

  // ---- Phase 2: apply + close (atomic) ----
  return prisma.$transaction(async (tx) => {
    const gate = await tx.stocktakeSession.updateMany({
      where: { id: sessionId, status: "EN_COURS" },
      data: { status: "CLOTURE", closedById: userId, closedAt: new Date() },
    });
    if (gate.count === 0) throw new StocktakeConflictError();

    const session = await tx.stocktakeSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { sessionNumber: true },
    });
    const reason = `Inventaire ${formatStocktakeNumber(session.sessionNumber)}`;

    const allLines = await tx.stocktakeLine.findMany({
      where: { stocktakeSessionId: sessionId },
      select: {
        id: true,
        countedQuantity: true,
        systemQuantityAtCount: true,
        appliedAt: true,
        inventoryItem: {
          select: { id: true, warehouseId: true, productId: true, variationId: true },
        },
      },
    });

    const uncountedCount = allLines.filter((l) => l.countedQuantity === null).length;
    const toApply = allLines.filter((l) => l.countedQuantity !== null && l.appliedAt === null);

    let appliedCount = 0;
    let zeroVarianceCount = 0;
    const movementIds: string[] = [];

    if (toApply.length > 0) {
      const currentById = await lockCurrentQuantities(tx, toApply.map((l) => l.inventoryItem.id));

      // Re-verify freshness under the lock (race between phase 1 and 2).
      const nowStale = toApply
        .filter((l) => currentById.get(l.inventoryItem.id) !== l.systemQuantityAtCount)
        .map((l) => l.id);
      if (nowStale.length > 0) throw new StocktakeStaleError(nowStale);

      const now = new Date();
      for (const l of toApply) {
        const current = currentById.get(l.inventoryItem.id)!;
        const variance = l.countedQuantity! - current;
        if (variance === 0) {
          await tx.stocktakeLine.update({ where: { id: l.id }, data: { appliedAt: now, isStale: false } });
          zeroVarianceCount++;
          continue;
        }
        const result = await applyStockMovement(tx, {
          warehouseId: l.inventoryItem.warehouseId,
          productId: l.inventoryItem.productId,
          variationId: l.inventoryItem.variationId,
          type: "INVENTAIRE",
          quantity: Math.abs(variance),
          onHandDelta: variance,
          performedById: userId,
          reason,
          stocktakeSessionId: sessionId,
        });
        if (!result.applied) {
          // Unreachable in practice: StocktakeLine.inventoryItemId is
          // onDelete: Cascade, so a deleted item takes its line with it.
          throw new StocktakeValidationError("Un article de l'inventaire n'existe plus.");
        }
        await tx.stocktakeLine.update({
          where: { id: l.id },
          data: { appliedAt: now, appliedMovementId: result.movementId, isStale: false },
        });
        movementIds.push(result.movementId);
        appliedCount++;
      }
    }

    return { sessionNumber: session.sessionNumber, appliedCount, zeroVarianceCount, uncountedCount, movementIds };
  });
}

/** Row-lock the given InventoryItem rows and return their authoritative
 * current on-hand. `SELECT … FOR UPDATE` — the codebase's sanctioned
 * pessimistic-lock pattern (see createRefundAction), not an advisory lock. */
async function lockCurrentQuantities(
  tx: Prisma.TransactionClient,
  itemIds: string[]
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; quantityOnHand: number }[]>(
    Prisma.sql`SELECT "id", "quantityOnHand" FROM "inventory_items" WHERE "id" IN (${Prisma.join(itemIds)}) FOR UPDATE`
  );
  return new Map(rows.map((r) => [r.id, r.quantityOnHand]));
}
