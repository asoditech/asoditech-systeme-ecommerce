"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { recordAuditEvent } from "@/lib/audit";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { validateReceptionInTx, getReceptionRemaining, ReceptionError } from "@/lib/receptions";
import { displayReceptionNumber } from "@/lib/format";
import {
  createSupplierSchema,
  updateSupplierSchema,
  createReceptionSchema,
  updateReceptionDraftSchema,
  receptionIdSchema,
  supplierPaymentSchema,
  type CreateSupplierInput,
  type UpdateSupplierInput,
  type CreateReceptionInput,
  type UpdateReceptionDraftInput,
  type SupplierPaymentInput,
} from "@/lib/validation/purchases";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Suppliers, purchase receptions and supplier payments — docs/adr/0040.
 *
 * Permissions: `suppliers.manage` (supplier records), `purchases.create`
 * (draft / validate / cancel a reception — warehouse-floor work),
 * `purchases.pay` (a supplier payment — a FINANCIAL act, deliberately separate
 * from receiving). A reception's destination is a Warehouse, so the acting
 * user must also hold location access to it (ADR 0037).
 */

const nz = (v: string | null | undefined) => (v && v.trim().length > 0 ? v.trim() : null);

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function createSupplierAction(input: CreateSupplierInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("suppliers.manage");
  const parsed = createSupplierSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const supplier = await prisma.supplier.create({
    data: {
      name: parsed.data.name,
      phone: nz(parsed.data.phone),
      email: nz(parsed.data.email),
      address: nz(parsed.data.address),
      city: nz(parsed.data.city),
      notes: nz(parsed.data.notes),
      createdById: user.id,
    },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "supplier.created",
    entityType: "Supplier",
    entityId: supplier.id,
    newValue: { name: supplier.name },
  });
  revalidatePath("/fournisseurs");
  return actionOk({ id: supplier.id });
}

export async function updateSupplierAction(input: UpdateSupplierInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("suppliers.manage");
  const parsed = updateSupplierSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.supplier.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Fournisseur introuvable.");
  const supplier = await prisma.supplier.update({
    where: { id: existing.id },
    data: {
      name: parsed.data.name,
      phone: nz(parsed.data.phone),
      email: nz(parsed.data.email),
      address: nz(parsed.data.address),
      city: nz(parsed.data.city),
      notes: nz(parsed.data.notes),
      isActive: parsed.data.isActive,
    },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "supplier.updated",
    entityType: "Supplier",
    entityId: supplier.id,
    previousValue: { name: existing.name, isActive: existing.isActive },
    newValue: { name: supplier.name, isActive: supplier.isActive },
  });
  revalidatePath("/fournisseurs");
  revalidatePath(`/fournisseurs/${supplier.id}`);
  return actionOk({ id: supplier.id });
}

// ---------------------------------------------------------------------------
// Receptions
// ---------------------------------------------------------------------------

interface ResolvedLine {
  productId: string | null;
  variationId: string | null;
  nameSnapshot: string;
  skuSnapshot: string;
  barcodeSnapshot: string | null;
  quantity: number;
  unitCost: number;
}

/** Resolves each draft line to a real sellable unit and snapshots its identity. */
async function resolveReceptionLines(
  lines: { productId?: string | null; variationId?: string | null; quantity: number; unitCost: number }[]
): Promise<{ ok: true; lines: ResolvedLine[] } | { ok: false; error: string }> {
  const out: ResolvedLine[] = [];
  for (const line of lines) {
    if (line.variationId) {
      const v = await prisma.productVariation.findUnique({
        where: { id: line.variationId },
        include: { product: { select: { name: true, trackInventory: true } }, barcodes: { where: { isPrimary: true }, take: 1 } },
      });
      if (!v) return { ok: false, error: "Une variation sélectionnée est introuvable." };
      if (!v.product.trackInventory) {
        return { ok: false, error: `Le suivi de stock est désactivé pour « ${v.product.name} ».` };
      }
      out.push({
        productId: v.productId,
        variationId: v.id,
        nameSnapshot: v.product.name,
        skuSnapshot: v.sku,
        barcodeSnapshot: v.barcodes[0]?.code ?? null,
        quantity: line.quantity,
        unitCost: line.unitCost,
      });
    } else if (line.productId) {
      const p = await prisma.product.findUnique({
        where: { id: line.productId },
        include: { barcodes: { where: { isPrimary: true }, take: 1 }, _count: { select: { variations: true } } },
      });
      if (!p) return { ok: false, error: "Un produit sélectionné est introuvable." };
      if (p._count.variations > 0) {
        return { ok: false, error: `« ${p.name} » a des variations : choisissez la taille/couleur reçue.` };
      }
      if (!p.trackInventory) return { ok: false, error: `Le suivi de stock est désactivé pour « ${p.name} ».` };
      out.push({
        productId: p.id,
        variationId: null,
        nameSnapshot: p.name,
        skuSnapshot: p.sku,
        barcodeSnapshot: p.barcodes[0]?.code ?? null,
        quantity: line.quantity,
        unitCost: line.unitCost,
      });
    } else {
      return { ok: false, error: "Chaque ligne doit référencer un produit ou une variation." };
    }
  }
  return { ok: true, lines: out };
}

async function resolveSupplierAndWarehouse(
  user: { id: string; role: import("@prisma/client").UserRole },
  supplierId: string,
  warehouseId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [supplier, warehouse] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: supplierId } }),
    prisma.warehouse.findUnique({ where: { id: warehouseId } }),
  ]);
  if (!supplier) return { ok: false, error: "Fournisseur introuvable." };
  if (!supplier.isActive) return { ok: false, error: "Ce fournisseur est inactif." };
  if (!warehouse || !warehouse.isActive) return { ok: false, error: "Emplacement de destination invalide." };
  // ADR 0037: stock lands in a location — the actor must be assigned to it.
  await requireLocationAccessForAction(user, warehouse.id);
  return { ok: true };
}

export async function createReceptionAction(input: CreateReceptionInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("purchases.create");
  const parsed = createReceptionSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const check = await resolveSupplierAndWarehouse(user, parsed.data.supplierId, parsed.data.warehouseId);
  if (!check.ok) return actionError(check.error);
  const resolved = await resolveReceptionLines(parsed.data.lines);
  if (!resolved.ok) return actionError(resolved.error);

  const reception = await prisma.$transaction(async (tx) => {
    const created = await tx.reception.create({
      data: {
        supplierId: parsed.data.supplierId,
        warehouseId: parsed.data.warehouseId,
        receptionDate: parsed.data.receptionDate ?? new Date(),
        supplierReference: nz(parsed.data.supplierReference),
        notes: nz(parsed.data.notes),
        createdById: user.id,
        createdByName: user.name,
        lines: { create: resolved.lines },
      },
    });
    const displayNumber = await claimTenantDisplayNumber(tx, created.tenantId, "reception");
    return tx.reception.update({ where: { id: created.id }, data: { displayNumber } });
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "reception.created",
    entityType: "Reception",
    entityId: reception.id,
    newValue: { number: displayReceptionNumber(reception), supplierId: reception.supplierId, lineCount: resolved.lines.length },
  });
  revalidatePath("/receptions");
  return actionOk({ id: reception.id });
}

export async function updateReceptionDraftAction(input: UpdateReceptionDraftInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("purchases.create");
  const parsed = updateReceptionDraftSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.reception.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Réception introuvable.");
  if (existing.status !== "BROUILLON") {
    return actionError("Une réception validée ou annulée ne peut plus être modifiée.");
  }
  const check = await resolveSupplierAndWarehouse(user, parsed.data.supplierId, parsed.data.warehouseId);
  if (!check.ok) return actionError(check.error);
  const resolved = await resolveReceptionLines(parsed.data.lines);
  if (!resolved.ok) return actionError(resolved.error);

  const updated = await prisma.$transaction(async (tx) => {
    // Compare-and-set on the status so an edit can never race a validation.
    const still = await tx.reception.updateMany({
      where: { id: existing.id, status: "BROUILLON" },
      data: {
        supplierId: parsed.data.supplierId,
        warehouseId: parsed.data.warehouseId,
        receptionDate: parsed.data.receptionDate ?? existing.receptionDate,
        supplierReference: nz(parsed.data.supplierReference),
        notes: nz(parsed.data.notes),
      },
    });
    if (still.count === 0) return null;
    await tx.receptionLine.deleteMany({ where: { receptionId: existing.id } });
    await tx.receptionLine.createMany({ data: resolved.lines.map((l) => ({ ...l, receptionId: existing.id })) });
    return existing.id;
  });
  if (!updated) return actionError("Cette réception vient d'être validée ou annulée.");

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "reception.updated",
    entityType: "Reception",
    entityId: existing.id,
    newValue: { lineCount: resolved.lines.length },
  });
  revalidatePath("/receptions");
  revalidatePath(`/receptions/${existing.id}`);
  return actionOk({ id: existing.id });
}

/**
 * Validates a draft: ADDS STOCK, through the canonical movement primitive.
 * Idempotent — validating an already-validated reception is a no-op that
 * reports success and never adds stock twice.
 */
export async function validateReceptionAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("purchases.create");
  const parsed = receptionIdSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const reception = await prisma.reception.findUnique({ where: { id: parsed.data.id }, include: { lines: true } });
  if (!reception) return actionError("Réception introuvable.");
  const warehouse = await prisma.warehouse.findUnique({ where: { id: reception.warehouseId } });
  if (!warehouse || !warehouse.isActive) return actionError("L'emplacement de destination est inactif.");
  await requireLocationAccessForAction(user, warehouse.id);

  let result;
  try {
    result = await prisma.$transaction((tx) =>
      validateReceptionInTx(tx, { receptionId: reception.id, performedById: user.id, performedByName: user.name })
    );
  } catch (error) {
    if (error instanceof ReceptionError) return actionError(error.message);
    throw error;
  }

  if (result.validated) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "reception.validated",
      entityType: "Reception",
      entityId: reception.id,
      newValue: { number: displayReceptionNumber(reception), totalCost: result.totalCost, lineCount: result.lineCount },
    });
    // Local stock changed → tell the storefront (best-effort, one-way — ADR 0036).
    await pushStockAfterLocalChange({
      productIds: reception.lines.map((l) => l.productId),
      variationIds: reception.lines.map((l) => l.variationId),
    });
  }
  revalidatePath("/receptions");
  revalidatePath(`/receptions/${reception.id}`);
  revalidatePath("/stock");
  revalidatePath("/fournisseurs");
  return actionOk({ id: reception.id });
}

/** Cancels a DRAFT (no stock effect). A validated reception is never cancelled/edited — see the ADR. */
export async function cancelReceptionAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("purchases.create");
  const parsed = receptionIdSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const res = await prisma.reception.updateMany({
    where: { id: parsed.data.id, status: "BROUILLON" },
    data: { status: "ANNULEE", cancelledAt: new Date() },
  });
  if (res.count === 0) {
    const exists = await prisma.reception.findUnique({ where: { id: parsed.data.id }, select: { id: true } });
    return actionError(exists ? "Seul un brouillon peut être annulé." : "Réception introuvable.");
  }
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "reception.cancelled",
    entityType: "Reception",
    entityId: parsed.data.id,
  });
  revalidatePath("/receptions");
  revalidatePath(`/receptions/${parsed.data.id}`);
  return actionOk({ id: parsed.data.id });
}

// ---------------------------------------------------------------------------
// Supplier payments — a FINANCIAL record, separate from receiving stock.
// ---------------------------------------------------------------------------

/**
 * Records a payment to a supplier. Creates NO stock movement (a payment is
 * not a reception, and a reception is not a payment). When linked to a
 * reception it must be a VALIDATED one, and cumulative payments may not exceed
 * its total — enforced under a row lock (`SELECT … FOR UPDATE` on the
 * reception, the same technique as refunds/returns) so two concurrent
 * payments cannot both read the same "remaining".
 */
export async function recordSupplierPaymentAction(input: SupplierPaymentInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("purchases.pay");
  const parsed = supplierPaymentSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const supplier = await prisma.supplier.findUnique({ where: { id: parsed.data.supplierId } });
  if (!supplier) return actionError("Fournisseur introuvable.");
  const receptionId = parsed.data.receptionId && parsed.data.receptionId.length > 0 ? parsed.data.receptionId : null;

  class OverpayError extends Error {}
  class BadReceptionError extends Error {}
  try {
    const payment = await prisma.$transaction(async (tx) => {
      if (receptionId) {
        await tx.$queryRaw`SELECT id FROM "receptions" WHERE id = ${receptionId} FOR UPDATE`;
        const reception = await tx.reception.findUnique({ where: { id: receptionId } });
        if (!reception || reception.supplierId !== supplier.id) throw new BadReceptionError("Réception introuvable pour ce fournisseur.");
        if (reception.status !== "VALIDEE") throw new BadReceptionError("Seule une réception validée peut être réglée.");
        const remaining = await getReceptionRemaining(receptionId, tx);
        if (remaining && new Prisma.Decimal(parsed.data.amount).greaterThan(remaining.remaining)) {
          throw new OverpayError(`Le montant dépasse le reste à payer de cette réception (${remaining.remaining.toString()}).`);
        }
      }
      return tx.supplierPayment.create({
        data: {
          supplierId: supplier.id,
          receptionId,
          amount: parsed.data.amount,
          method: parsed.data.method,
          paidAt: parsed.data.paidAt ?? new Date(),
          reference: nz(parsed.data.reference),
          notes: nz(parsed.data.notes),
          createdById: user.id,
          createdByName: user.name,
        },
      });
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "supplier_payment.recorded",
      entityType: "SupplierPayment",
      entityId: payment.id,
      newValue: { supplierId: supplier.id, receptionId, amount: payment.amount.toString(), method: payment.method },
    });
    revalidatePath(`/fournisseurs/${supplier.id}`);
    revalidatePath("/fournisseurs");
    return actionOk({ id: payment.id });
  } catch (error) {
    if (error instanceof OverpayError || error instanceof BadReceptionError) return actionError(error.message);
    throw error;
  }
}
