"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { productCostVisibility } from "@/lib/auth/cost-visibility";
import { recordAuditEvent } from "@/lib/audit";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { randomUUID } from "node:crypto";
import {
  validateReceptionInTx,
  getReceptionRemaining,
  getSupplierBalance,
  planSupplierPaymentAllocation,
  SupplierPaymentError,
  ReceptionError,
} from "@/lib/receptions";
import { getLatestPurchasePrice, getPurchasePriceHistory, type PurchasePriceHistoryEntry } from "@/lib/queries/purchases";
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
  // The draft's CURRENT location too, not only the submitted one — like
  // validate/cancel: a draft of a location the actor is not assigned to can
  // never be edited (or moved) by them (docs/adr/0037, 0048).
  await requireLocationAccessForAction(user, existing.warehouseId);
  const check = await resolveSupplierAndWarehouse(user, parsed.data.supplierId, parsed.data.warehouseId);
  if (!check.ok) return actionError(check.error);
  // `unitCost: null` = « inchangé » (docs/adr/0048): the price already stored on
  // this draft for the same unit. A unit new to the draft needs a price.
  const stored = await prisma.receptionLine.findMany({
    where: { receptionId: existing.id },
    select: { productId: true, variationId: true, unitCost: true },
  });
  const storedPrice = (l: { productId?: string | null; variationId?: string | null }) =>
    stored.find((s) => (l.variationId ? s.variationId === l.variationId : !s.variationId && s.productId === l.productId))?.unitCost;
  const lines: { productId?: string | null; variationId?: string | null; quantity: number; unitCost: number }[] = [];
  for (const l of parsed.data.lines) {
    if (l.unitCost !== null) {
      lines.push({ ...l, unitCost: l.unitCost });
      continue;
    }
    const kept = storedPrice(l);
    if (kept === undefined) return actionError("Saisissez le prix d'achat de chaque nouvel article.");
    lines.push({ ...l, unitCost: Number(kept) });
  }
  const resolved = await resolveReceptionLines(lines);
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

  // Phase 4A (G2, docs/adr/0042): cancelling is a mutation on a location's
  // document, so — like create/update/validate — the caller must be assigned
  // to the reception's destination (ADR 0037). Resolved through the
  // tenant-scoped client, so another tenant's id is simply "introuvable".
  const reception = await prisma.reception.findUnique({ where: { id: parsed.data.id }, select: { warehouseId: true } });
  if (!reception) return actionError("Réception introuvable.");
  await requireLocationAccessForAction(user, reception.warehouseId);

  const res = await prisma.reception.updateMany({
    where: { id: parsed.data.id, status: "BROUILLON" },
    data: { status: "ANNULEE", cancelledAt: new Date() },
  });
  if (res.count === 0) return actionError("Seul un brouillon peut être annulé.");
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

export interface SupplierPaymentAllocationLine {
  receptionId: string;
  receptionLabel: string;
  amount: string;
}

/** What the UI needs to render "Payment: X — allocated to REC-1 (…), REC-2 (…) — remaining balance: Y". */
export interface SupplierPaymentResult {
  /** Set only when the payment was split across MORE than one reception. */
  paymentGroupId: string | null;
  amount: string;
  allocations: SupplierPaymentAllocationLine[];
  remainingBalance: string;
}

/**
 * Records a payment to a supplier. Creates NO stock movement (a payment is
 * not a reception, and a reception is not a payment).
 *
 * Two modes, chosen by whether the caller names a reception (docs/adr/0042):
 *  - `receptionId` given: settles exactly that VALIDATED reception — the
 *    original, still-supported manual path, unchanged behaviour.
 *  - `receptionId` omitted: AUTO-ALLOCATES the amount across the supplier's
 *    outstanding validated receptions, oldest debt first (the primary UX —
 *    the user only enters an amount). See `planSupplierPaymentAllocation`.
 *
 * Both modes run under the same row-lock technique so concurrent payments
 * for one supplier/reception can never both read the same stale "remaining"
 * and together overpay it.
 */
export async function recordSupplierPaymentAction(input: SupplierPaymentInput): Promise<ActionResult<SupplierPaymentResult>> {
  const user = await requirePermissionForAction("purchases.pay");
  const parsed = supplierPaymentSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const supplier = await prisma.supplier.findUnique({ where: { id: parsed.data.supplierId } });
  if (!supplier) return actionError("Fournisseur introuvable.");
  const receptionId = parsed.data.receptionId && parsed.data.receptionId.length > 0 ? parsed.data.receptionId : null;
  const amount = new Prisma.Decimal(parsed.data.amount);

  class BadReceptionError extends Error {}
  try {
    const { paymentGroupId, rows } = await prisma.$transaction(async (tx) => {
      const common = {
        method: parsed.data.method,
        paidAt: parsed.data.paidAt ?? new Date(),
        reference: nz(parsed.data.reference),
        notes: nz(parsed.data.notes),
        createdById: user.id,
        createdByName: user.name,
      };

      if (receptionId) {
        // Manual single-reception targeting — the original path.
        await tx.$queryRaw`SELECT id FROM "receptions" WHERE id = ${receptionId} FOR UPDATE`;
        const reception = await tx.reception.findUnique({ where: { id: receptionId } });
        if (!reception || reception.supplierId !== supplier.id) throw new BadReceptionError("Réception introuvable pour ce fournisseur.");
        if (reception.status !== "VALIDEE") throw new BadReceptionError("Seule une réception validée peut être réglée.");
        const remaining = await getReceptionRemaining(receptionId, tx);
        if (remaining && amount.greaterThan(remaining.remaining)) {
          throw new SupplierPaymentError(`Le montant dépasse le reste à payer de cette réception (${remaining.remaining.toString()}).`);
        }
        const row = await tx.supplierPayment.create({ data: { supplierId: supplier.id, receptionId, amount, paymentGroupId: null, ...common } });
        return { paymentGroupId: null, rows: [{ receptionId: row.receptionId!, receptionLabel: displayReceptionNumber(reception), amount: row.amount, id: row.id }] };
      }

      // Auto-allocation: lock every outstanding validated reception of this
      // supplier for the duration of the tx — two concurrent payments for
      // the same supplier serialize on this instead of both planning off
      // the same stale "outstanding" read (same technique as above, widened
      // from one reception to the whole set a payment might touch).
      await tx.$queryRaw`SELECT id FROM "receptions" WHERE "supplierId" = ${supplier.id} AND status = 'VALIDEE' FOR UPDATE`;
      const allocations = await planSupplierPaymentAllocation(tx, { supplierId: supplier.id, amount });
      const paymentGroupId = allocations.length > 1 ? randomUUID() : null;
      const rows = await Promise.all(
        allocations.map(async (a) => {
          const row = await tx.supplierPayment.create({
            data: { supplierId: supplier.id, receptionId: a.receptionId, amount: a.amount, paymentGroupId, ...common },
          });
          return { receptionId: row.receptionId!, receptionLabel: a.receptionLabel, amount: row.amount, id: row.id };
        })
      );
      return { paymentGroupId, rows };
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "supplier_payment.recorded",
      entityType: "SupplierPayment",
      entityId: rows[0].id,
      newValue: {
        supplierId: supplier.id,
        paymentGroupId,
        amount: amount.toString(),
        method: parsed.data.method,
        allocations: rows.map((r) => ({ receptionId: r.receptionId, amount: r.amount.toString() })),
      },
    });
    revalidatePath(`/fournisseurs/${supplier.id}`);
    revalidatePath("/fournisseurs");

    const balance = await getSupplierBalance(supplier.id);
    return actionOk({
      paymentGroupId,
      amount: amount.toString(),
      allocations: rows.map((r) => ({ receptionId: r.receptionId, receptionLabel: r.receptionLabel, amount: r.amount.toString() })),
      remainingBalance: balance.balance.toString(),
    });
  } catch (error) {
    if (error instanceof SupplierPaymentError || error instanceof BadReceptionError) return actionError(error.message);
    throw error;
  }
}

/**
 * The reception line-entry hint (Batch 3, Task 3A) — "Dernier achat : X MAD
 * chez Y, le Z" shown next to the price input as the operator adds a unit,
 * from the existing ReceptionLine history (getLatestPurchasePrice). Purely
 * informational: never pre-fills or blocks anything, and never touches
 * Product.cost. Same permission as the reception screen itself.
 */
export async function getLatestPurchasePriceAction(input: {
  productId?: string | null;
  variationId?: string | null;
}): Promise<PurchasePriceHistoryEntry | null> {
  const user = await requirePermissionForAction("purchases.create");
  // A purchase price follows `purchases.view` (docs/adr/0052): no hint without it.
  if (!productCostVisibility(user).purchasePrices) return null;
  return getLatestPurchasePrice(input);
}

/**
 * Batch 14 — full purchase-price history for ONE sellable unit, fetched
 * on demand (e.g. a "Historique" dialog on a variation row). `purchases.view`
 * (a read), not `purchases.create` — anyone who can see purchase prices on
 * the product page can open this, even without reception-entry rights.
 */
export async function getUnitPurchaseHistoryAction(input: {
  productId?: string | null;
  variationId?: string | null;
}): Promise<PurchasePriceHistoryEntry[]> {
  const user = await requirePermissionForAction("purchases.view");
  if (!productCostVisibility(user).purchasePrices) return [];
  return getPurchasePriceHistory(input, 10);
}
