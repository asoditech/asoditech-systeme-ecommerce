"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { InsufficientStockError } from "@/lib/inventory";
import {
  snapshotWarehouseInventory,
  finalizeStocktakeSession,
  StocktakeConflictError,
  StocktakeValidationError,
  StocktakeStaleError,
} from "@/lib/stocktakes";
import {
  createStocktakeSessionSchema,
  updateStocktakeCountsSchema,
  finalizeStocktakeSessionSchema,
  cancelStocktakeSessionSchema,
  type CreateStocktakeSessionInput,
  type UpdateStocktakeCountsInput,
} from "@/lib/validation/stocktake";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

const CONFLICT_MESSAGE =
  "Cet inventaire a été modifié entre-temps par une autre action. Rechargez la page et réessayez.";

export async function createStocktakeSessionAction(
  input: CreateStocktakeSessionInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.count");

  const parsed = createStocktakeSessionSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Never trust the client's warehouseId — resolve and validate it here.
  const warehouse = await prisma.warehouse.findUnique({ where: { id: parsed.data.warehouseId } });
  if (!warehouse) return actionError("Entrepôt introuvable.");
  if (!warehouse.isActive) {
    return actionError("Cet entrepôt est désactivé — impossible de démarrer un inventaire.");
  }

  let session: { id: string; sessionNumber: number; lineCount: number };
  try {
    session = await prisma.$transaction(async (tx) => {
      const created = await tx.stocktakeSession.create({
        data: {
          warehouseId: warehouse.id,
          notes: normalizeOptional(parsed.data.notes),
          startedById: user.id,
        },
      });
      const lineCount = await snapshotWarehouseInventory(tx, created.id, warehouse.id);
      return { id: created.id, sessionNumber: created.sessionNumber, lineCount };
    });
  } catch (error) {
    // Partial unique index: at most one EN_COURS session per warehouse.
    if (isUniqueConstraintError(error)) {
      return actionError("Un inventaire est déjà en cours pour cet entrepôt.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stocktake.created",
    entityType: "StocktakeSession",
    entityId: session.id,
    newValue: {
      sessionNumber: session.sessionNumber,
      warehouseId: warehouse.id,
      lineCount: session.lineCount,
    },
  });

  revalidatePath("/inventaires");
  return actionOk({ id: session.id });
}

export async function updateStocktakeCountsAction(
  input: UpdateStocktakeCountsInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.count");

  const parsed = updateStocktakeCountsSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Row-lock the session so a concurrent finalize/cancel serializes here.
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "stocktake_sessions" WHERE "id" = ${parsed.data.id} FOR UPDATE`;
      if (locked.length === 0) throw new StocktakeValidationError("Inventaire introuvable.");
      if (locked[0].status !== "EN_COURS") {
        throw new StocktakeValidationError("Cet inventaire n'est plus modifiable.");
      }

      const lineIds = parsed.data.counts.map((c) => c.lineId);
      // The `stocktakeSessionId` filter is the IDOR guard: a line id that
      // isn't part of THIS session simply isn't returned.
      const lines = await tx.stocktakeLine.findMany({
        where: { id: { in: lineIds }, stocktakeSessionId: parsed.data.id },
        select: { id: true, inventoryItem: { select: { quantityOnHand: true } } },
      });
      if (lines.length !== new Set(lineIds).size) {
        throw new StocktakeValidationError("Une ligne sélectionnée ne fait pas partie de cet inventaire.");
      }
      const currentById = new Map(lines.map((l) => [l.id, l.inventoryItem.quantityOnHand]));

      for (const c of parsed.data.counts) {
        // `systemQuantityAtCount` is re-captured server-side from the
        // authoritative current on-hand — the client-supplied value (if
        // any) is ignored.
        const current = currentById.get(c.lineId)!;
        await tx.stocktakeLine.update({
          where: { id: c.lineId },
          data:
            c.countedQuantity === null
              ? {
                  countedQuantity: null,
                  countedAt: null,
                  countedById: null,
                  systemQuantityAtCount: current,
                  isStale: false,
                }
              : {
                  countedQuantity: c.countedQuantity,
                  countedAt: new Date(),
                  countedById: user.id,
                  systemQuantityAtCount: current,
                  isStale: false,
                },
        });
      }
    });
  } catch (error) {
    if (error instanceof StocktakeValidationError) return actionError(error.message);
    throw error;
  }

  // No audit event — count edits are recorded on the StocktakeLine rows and
  // the finalize movements are the ledger evidence.
  revalidatePath(`/inventaires/${parsed.data.id}`);
  return actionOk({ id: parsed.data.id });
}

interface FinalizeIdResult extends IdResult {
  applied: number;
  zeroVariance: number;
  uncounted: number;
}

export async function finalizeStocktakeSessionAction(
  input: { id: string }
): Promise<ActionResult<FinalizeIdResult>> {
  const user = await requirePermissionForAction("inventory.count");

  const parsed = finalizeStocktakeSessionSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  let result;
  try {
    result = await finalizeStocktakeSession(parsed.data.id, user.id);
  } catch (error) {
    if (error instanceof StocktakeStaleError) {
      return actionError(
        `${error.staleLineIds.length} ligne(s) ont changé de stock depuis le comptage. ` +
          "Recomptez ces lignes puis clôturez à nouveau."
      );
    }
    if (error instanceof InsufficientStockError) return actionError(error.message);
    if (error instanceof StocktakeConflictError) {
      const s = await prisma.stocktakeSession.findUnique({
        where: { id: parsed.data.id },
        select: { status: true },
      });
      return actionError(s?.status === "CLOTURE" ? "Cet inventaire est déjà clôturé." : CONFLICT_MESSAGE);
    }
    if (error instanceof StocktakeValidationError) return actionError(error.message);
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stocktake.closed",
    entityType: "StocktakeSession",
    entityId: parsed.data.id,
    metadata: {
      sessionNumber: result.sessionNumber,
      appliedCount: result.appliedCount,
      zeroVarianceCount: result.zeroVarianceCount,
      uncountedCount: result.uncountedCount,
      movementCount: result.movementIds.length,
    },
  });

  revalidatePath("/inventaires");
  revalidatePath(`/inventaires/${parsed.data.id}`);
  revalidatePath("/stock");
  return actionOk({
    id: parsed.data.id,
    applied: result.appliedCount,
    zeroVariance: result.zeroVarianceCount,
    uncounted: result.uncountedCount,
  });
}

export async function cancelStocktakeSessionAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("inventory.count");

  const parsed = cancelStocktakeSessionSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const existing = await prisma.stocktakeSession.findUnique({
    where: { id: parsed.data.id },
    select: { status: true },
  });
  if (!existing) return actionError("Inventaire introuvable.");

  const gate = await prisma.stocktakeSession.updateMany({
    where: { id: parsed.data.id, status: "EN_COURS" },
    data: { status: "ANNULE" },
  });
  if (gate.count === 0) {
    return actionError("Seul un inventaire en cours peut être annulé.");
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "stocktake.cancelled",
    entityType: "StocktakeSession",
    entityId: parsed.data.id,
    previousValue: { status: existing.status },
    newValue: { status: "ANNULE" },
  });

  revalidatePath("/inventaires");
  revalidatePath(`/inventaires/${parsed.data.id}`);
  return actionOk({ id: parsed.data.id });
}
