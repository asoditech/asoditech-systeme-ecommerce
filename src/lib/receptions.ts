import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { applyStockMovement, ensureInventoryItem } from "@/lib/inventory";
import { displayReceptionNumber } from "@/lib/format";

/**
 * Reception domain service — docs/adr/0040-offline-sales-and-receptions.md.
 *
 * A reception is physical stock ENTERING the business. Validating it is the
 * ONLY thing that adds stock, and it does so exclusively through the
 * canonical `applyStockMovement` primitive (type RECEPTION, carrying the
 * line's unit cost and `receptionLineId`). `ReceptionLine.quantity` is a
 * document; the inventory movement is authoritative — so a validated
 * reception can never be a second inventory source, and validating twice can
 * never add stock twice (the status transition is the idempotency guard).
 */

type Tx = PrismaTransactionClient;

export class ReceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceptionError";
  }
}

const d2 = (n: Prisma.Decimal | number | string) => new Prisma.Decimal(n);

export type ValidateReceptionResult =
  | { validated: true; alreadyValidated: false; totalCost: string; lineCount: number }
  | { validated: false; alreadyValidated: true };

/**
 * Validates a draft reception on the caller's transaction. Idempotent: the
 * BROUILLON→VALIDEE transition is a compare-and-set (`updateMany` on status),
 * so a retry or a concurrent second validation finds nothing to transition and
 * returns `alreadyValidated` WITHOUT touching stock.
 */
export async function validateReceptionInTx(
  tx: Tx,
  input: { receptionId: string; performedById: string | null; performedByName: string | null }
): Promise<ValidateReceptionResult> {
  const reception = await tx.reception.findUnique({
    where: { id: input.receptionId },
    include: { lines: true },
  });
  if (!reception) throw new ReceptionError("Réception introuvable.");
  if (reception.status === "ANNULEE") throw new ReceptionError("Cette réception est annulée.");
  if (reception.status === "VALIDEE") return { validated: false, alreadyValidated: true };
  if (reception.lines.length === 0) throw new ReceptionError("Une réception doit contenir au moins une ligne.");

  // Compare-and-set: only ONE caller can move it out of BROUILLON.
  const claimed = await tx.reception.updateMany({
    where: { id: reception.id, status: "BROUILLON" },
    data: { status: "VALIDEE", validatedAt: new Date(), validatedById: input.performedById, validatedByName: input.performedByName },
  });
  if (claimed.count === 0) return { validated: false, alreadyValidated: true };

  let total = d2(0);
  const label = displayReceptionNumber(reception);
  for (const line of reception.lines) {
    if (!line.productId && !line.variationId) {
      throw new ReceptionError(`L'article « ${line.nameSnapshot} » n'existe plus dans le catalogue.`);
    }
    // Receiving into a location that does not track this unit yet creates its
    // (empty) InventoryItem row — same primitive transfers use.
    await ensureInventoryItem(tx, {
      warehouseId: reception.warehouseId,
      productId: line.variationId ? null : line.productId,
      variationId: line.variationId,
    });
    const result = await applyStockMovement(tx, {
      warehouseId: reception.warehouseId,
      productId: line.productId,
      variationId: line.variationId,
      type: "RECEPTION",
      quantity: line.quantity,
      onHandDelta: line.quantity,
      unitCost: line.unitCost.toString(),
      receptionLineId: line.id,
      performedById: input.performedById,
      reason: `Réception ${label}`,
    });
    if (!result.applied) {
      // Never silently lose received stock: ensureInventoryItem just created the row.
      throw new ReceptionError(`Impossible d'enregistrer le stock de « ${line.nameSnapshot} ».`);
    }
    total = total.plus(d2(line.unitCost).times(line.quantity));
  }

  await tx.reception.update({ where: { id: reception.id }, data: { totalCost: total } });
  return { validated: true, alreadyValidated: false, totalCost: total.toString(), lineCount: reception.lines.length };
}

/**
 * Supplier balance — DERIVED, never stored: what we owe =
 *   Σ totalCost of VALIDATED receptions − Σ payments made.
 * (A draft or cancelled reception owes nothing; a payment is a separate
 * financial record from the reception it may settle.)
 */
export async function getSupplierBalance(supplierId: string, db: typeof prisma | Tx = prisma) {
  const [received, paid] = await Promise.all([
    db.reception.aggregate({ where: { supplierId, status: "VALIDEE" }, _sum: { totalCost: true } }),
    db.supplierPayment.aggregate({ where: { supplierId }, _sum: { amount: true } }),
  ]);
  const totalReceived = received._sum.totalCost ?? d2(0);
  const totalPaid = paid._sum.amount ?? d2(0);
  return { totalReceived, totalPaid, balance: totalReceived.minus(totalPaid) };
}

/** Remaining amount on ONE reception (validated total − payments explicitly linked to it). */
export async function getReceptionRemaining(receptionId: string, db: typeof prisma | Tx = prisma) {
  const reception = await db.reception.findUnique({ where: { id: receptionId }, select: { status: true, totalCost: true } });
  if (!reception) return null;
  const paid = await db.supplierPayment.aggregate({ where: { receptionId }, _sum: { amount: true } });
  const totalPaid = paid._sum.amount ?? d2(0);
  return { status: reception.status, total: reception.totalCost, paid: totalPaid, remaining: reception.totalCost.minus(totalPaid) };
}
