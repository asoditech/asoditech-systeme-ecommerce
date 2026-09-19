"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { requireChannelAccessForAction, saleChannelWhere } from "@/lib/auth/channel-access";
import { recordAuditEvent } from "@/lib/audit";
import { applyStockMovement, applySaleReturnLine, InsufficientStockError } from "@/lib/inventory";
import { isProductAvailableOnChannel } from "@/lib/channels";
import { lookupSellableUnits, type SellableUnit } from "@/lib/catalog/lookup";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { displaySaleNumber, displaySaleReturnNumber } from "@/lib/format";
import {
  createSaleSchema,
  createSaleReturnSchema,
  lookupForSaleSchema,
  type CreateSaleInput,
  type CreateSaleReturnInput,
} from "@/lib/validation/sale";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * In-store sales — docs/adr/0040-offline-sales-and-receptions.md.
 *
 * A Sale is a SEPARATE transaction type from the delivery Order (whose
 * lifecycle, COD, carriers, commissions and revenue definition are untouched).
 * It completes ATOMICALLY: the sale, its lines, its payments and the canonical
 * VENTE inventory movements are written in ONE transaction. Consequences:
 *
 *  - It consumes stock only through `applyStockMovement`, with
 *    `enforceAvailable: true` — it may only take `onHand − reserved`, so it can
 *    never eat units reserved for a confirmed online order.
 *  - A unit with no InventoryItem at the sale location is a controlled
 *    business error, NEVER silently treated as zero (the order flow's silent
 *    no-op is not acceptable for a completed in-store sale).
 *  - Any failure (insufficient stock, missing stock row, payment mismatch)
 *    rolls back EVERYTHING — no misleading "completed" sale, no partial
 *    decrement.
 *  - It is idempotent on `(tenantId, idempotencyKey)`: a retry / double-click
 *    returns the existing sale and moves stock ONCE.
 */

class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleError";
  }
}

const money = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(new Prisma.Decimal(n).toFixed(2));
const nz = (v: string | null | undefined) => (v && v.trim().length > 0 ? v.trim() : null);
const unitKey = (l: { productId?: string | null; variationId?: string | null }) =>
  l.variationId ? `v:${l.variationId}` : `p:${l.productId}`;

/** Channel + location boundary shared by every sale action. Throws authz errors, returns business errors. */
async function resolveSaleContext(
  user: Parameters<typeof requireChannelAccessForAction>[0] & Parameters<typeof requireLocationAccessForAction>[0],
  salesChannelId: string,
  warehouseId: string
): Promise<{ ok: true; channelId: string; warehouseId: string } | { ok: false; error: string }> {
  let channel;
  try {
    channel = await requireChannelAccessForAction(user, salesChannelId, { kind: "OFFLINE" });
  } catch (error) {
    // "Non autorisé" is an authorization failure → propagate like every other
    // guard; the rest (unknown / inactive / wrong kind) are business errors.
    if (error instanceof Error && !/^Non autorisé/.test(error.message)) return { ok: false, error: error.message };
    throw error;
  }
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse || !warehouse.isActive) return { ok: false, error: "Emplacement de vente invalide." };
  const mapped = await prisma.salesChannelLocation.findUnique({
    where: { salesChannelId_warehouseId: { salesChannelId: channel.id, warehouseId: warehouse.id } },
  });
  if (!mapped) return { ok: false, error: "Cet emplacement n'est pas rattaché à ce canal de vente." };
  // ADR 0037: stock leaves a location — the seller must be assigned to it.
  await requireLocationAccessForAction(user, warehouse.id);
  return { ok: true, channelId: channel.id, warehouseId: warehouse.id };
}

export interface SaleLookupResult {
  unit: SellableUnit;
  /** onHand − reserved at the sale location (what may actually be sold). */
  available: number;
  onHand: number;
  /** false when the location has no stock row for this unit → cannot be sold here. */
  tracked: boolean;
}

/** Barcode → reference → name lookup for the sale screen, with availability at the chosen location. */
export async function lookupForSaleAction(input: {
  query: string;
  salesChannelId: string;
  warehouseId: string;
}): Promise<SaleLookupResult[]> {
  const user = await requirePermissionForAction("sales.create");
  const parsed = lookupForSaleSchema.safeParse(input);
  if (!parsed.success) return [];
  const ctx = await resolveSaleContext(user, parsed.data.salesChannelId, parsed.data.warehouseId);
  if (!ctx.ok) return [];

  const units = await lookupSellableUnits(prisma, parsed.data.query, { channelId: ctx.channelId, onlyActive: true, limit: 12 });
  if (units.length === 0) return [];
  const items = await prisma.inventoryItem.findMany({
    where: {
      warehouseId: ctx.warehouseId,
      OR: [
        { productId: { in: units.filter((u) => !u.variationId).map((u) => u.productId) } },
        { variationId: { in: units.filter((u) => u.variationId).map((u) => u.variationId as string) } },
      ],
    },
    select: { productId: true, variationId: true, quantityOnHand: true, quantityReserved: true },
  });
  return units.map((unit) => {
    const item = items.find((i) => (unit.variationId ? i.variationId === unit.variationId : i.productId === unit.productId && !i.variationId));
    const onHand = item?.quantityOnHand ?? 0;
    return { unit, onHand, available: item ? Math.max(0, item.quantityOnHand - item.quantityReserved) : 0, tracked: Boolean(item) };
  });
}

export async function createSaleAction(input: CreateSaleInput): Promise<ActionResult<{ id: string; duplicate: boolean }>> {
  const user = await requirePermissionForAction("sales.create");
  const parsed = createSaleSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  const data = parsed.data;

  // ---- idempotency fast path: a retry returns the existing sale, moves nothing.
  const already = await prisma.sale.findFirst({ where: { idempotencyKey: data.idempotencyKey, ...saleChannelWhere(user) } });
  if (already) return actionOk({ id: already.id, duplicate: true });

  const ctx = await resolveSaleContext(user, data.salesChannelId, data.warehouseId);
  if (!ctx.ok) return actionError(ctx.error);

  const customerId = data.customerId && data.customerId.length > 0 ? data.customerId : null;
  if (customerId && !(await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } }))) {
    return actionError("Client introuvable.");
  }

  // ---- resolve every line server-side: identity, price, availability on the channel.
  const canOverridePrice = userHasPermission(user, "sales.override_price");
  const resolved: {
    productId: string;
    variationId: string | null;
    nameSnapshot: string;
    skuSnapshot: string;
    barcodeSnapshot: string | null;
    unitPrice: Prisma.Decimal;
    quantity: number;
    discount: Prisma.Decimal;
    total: Prisma.Decimal;
    costSnapshot: Prisma.Decimal | null;
  }[] = [];

  for (const line of data.lines) {
    let productId: string;
    let variationId: string | null = null;
    let name: string;
    let sku: string;
    let barcode: string | null;
    let defaultPrice: Prisma.Decimal;
    let cost: Prisma.Decimal | null;

    if (line.variationId) {
      const v = await prisma.productVariation.findUnique({
        where: { id: line.variationId },
        include: { product: true, barcodes: { where: { isPrimary: true }, take: 1 } },
      });
      if (!v) return actionError("Une variation sélectionnée est introuvable.");
      if (v.product.status !== "ACTIF") return actionError(`« ${v.product.name} » n'est plus disponible à la vente.`);
      if (!v.product.trackInventory) return actionError(`Le suivi de stock est désactivé pour « ${v.product.name} ».`);
      productId = v.productId;
      variationId = v.id;
      name = v.product.name;
      sku = v.sku;
      barcode = v.barcodes[0]?.code ?? null;
      defaultPrice = v.price ?? v.product.salePrice ?? v.product.price;
      cost = v.cost ?? v.product.cost ?? null;
    } else {
      const p = await prisma.product.findUnique({
        where: { id: line.productId! },
        include: { barcodes: { where: { isPrimary: true }, take: 1 }, _count: { select: { variations: true } } },
      });
      if (!p) return actionError("Un produit sélectionné est introuvable.");
      if (p._count.variations > 0) return actionError(`« ${p.name} » a des variations : choisissez la taille/couleur vendue.`);
      if (p.status !== "ACTIF") return actionError(`« ${p.name} » n'est plus disponible à la vente.`);
      if (!p.trackInventory) return actionError(`Le suivi de stock est désactivé pour « ${p.name} ».`);
      productId = p.id;
      name = p.name;
      sku = p.sku;
      barcode = p.barcodes[0]?.code ?? null;
      defaultPrice = p.salePrice ?? p.price;
      cost = p.cost ?? null;
    }

    if (!(await isProductAvailableOnChannel(prisma, productId, ctx.channelId))) {
      return actionError(`« ${name} » n'est pas vendu sur ce canal.`);
    }

    // Price: the SERVER decides. A client-supplied price/discount that departs
    // from the catalogue needs `sales.override_price`.
    const unitPrice = line.unitPrice == null ? money(defaultPrice) : money(line.unitPrice);
    const discount = money(line.discount ?? 0);
    if ((!unitPrice.equals(money(defaultPrice)) || discount.greaterThan(0)) && !canOverridePrice) {
      return actionError(`Vous n'avez pas le droit de modifier le prix ou d'appliquer une remise (« ${name} »).`);
    }
    const gross = unitPrice.times(line.quantity);
    if (discount.greaterThan(gross)) return actionError(`La remise dépasse le montant de la ligne « ${name} ».`);
    resolved.push({
      productId,
      variationId,
      nameSnapshot: name,
      skuSnapshot: sku,
      barcodeSnapshot: barcode,
      unitPrice,
      quantity: line.quantity,
      discount,
      total: gross.minus(discount),
      costSnapshot: cost,
    });
  }

  const subtotal = resolved.reduce((s, l) => s.plus(l.unitPrice.times(l.quantity)), money(0));
  const discountTotal = resolved.reduce((s, l) => s.plus(l.discount), money(0));
  const total = subtotal.minus(discountTotal);
  const paid = data.payments.reduce((s, p) => s.plus(money(p.amount)), money(0));
  if (!paid.equals(total)) {
    return actionError(`La somme des paiements (${paid.toFixed(2)}) doit être égale au total (${total.toFixed(2)}).`);
  }

  // ---- ONE transaction: sale + lines + payments + canonical stock movements.
  let sale;
  try {
    sale = await prisma.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          salesChannelId: ctx.channelId,
          warehouseId: ctx.warehouseId,
          customerId,
          customerLabel: nz(data.customerLabel),
          idempotencyKey: data.idempotencyKey,
          subtotal,
          discountTotal,
          total,
          notes: nz(data.notes),
          soldById: user.id,
          soldByName: user.name,
          lines: { create: resolved },
          payments: {
            create: data.payments.map((p) => ({ method: p.method, amount: money(p.amount), reference: nz(p.reference) })),
          },
        },
      });
      const displayNumber = await claimTenantDisplayNumber(tx, created.tenantId, "sale");
      const numbered = await tx.sale.update({ where: { id: created.id }, data: { displayNumber } });

      // A stable per-unit order avoids lock-order deadlocks between concurrent
      // sales that share units.
      const ordered = [...resolved].sort((a, b) => unitKey(a).localeCompare(unitKey(b)));
      for (const line of ordered) {
        let result;
        try {
          result = await applyStockMovement(tx, {
            warehouseId: ctx.warehouseId,
            productId: line.variationId ? null : line.productId,
            variationId: line.variationId,
            type: "VENTE",
            quantity: line.quantity,
            onHandDelta: -line.quantity,
            saleId: created.id,
            performedById: user.id,
            reason: `Vente magasin ${displaySaleNumber(numbered)}`,
            enforceAvailable: true,
          });
        } catch (error) {
          if (error instanceof InsufficientStockError) {
            throw new SaleError(`Stock disponible insuffisant pour « ${line.nameSnapshot} ». ${error.message}`);
          }
          throw error;
        }
        if (!result.applied) {
          // No stock row at this location: NEVER treat it as zero and carry on.
          throw new SaleError(`« ${line.nameSnapshot} » n'est pas suivi en stock à cet emplacement — vente impossible.`);
        }
      }
      return numbered;
    });
  } catch (error) {
    if (error instanceof SaleError) return actionError(error.message);
    if (isUniqueConstraintError(error)) {
      // Lost a race against an identical submit — the winner's sale is the answer.
      const winner = await prisma.sale.findFirst({ where: { idempotencyKey: data.idempotencyKey, ...saleChannelWhere(user) } });
      if (winner) return actionOk({ id: winner.id, duplicate: true });
      return actionError("Cette clé d'idempotence est déjà utilisée.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "sale.created",
    entityType: "Sale",
    entityId: sale.id,
    newValue: {
      number: displaySaleNumber(sale),
      total: total.toString(),
      salesChannelId: ctx.channelId,
      warehouseId: ctx.warehouseId,
      lineCount: resolved.length,
    },
  });

  // Local stock changed → tell the storefront (best-effort, one-way — ADR 0036).
  const refs = {
    productIds: resolved.map((l) => l.productId),
    variationIds: resolved.map((l) => l.variationId),
  };
  await pushStockAfterLocalChange(refs);
  await checkAndNotifyLowStock(refs);

  revalidatePath("/ventes");
  revalidatePath("/stock");
  return actionOk({ id: sale.id, duplicate: false });
}

/**
 * Records a return against an in-store sale. Stock only comes back when
 * physically accepted (sellable → on-hand via RETOUR, damaged → quantityDamaged
 * via ENDOMMAGE, never on-hand). The cumulative returned quantity per sale line
 * is hard-capped by what was sold, under a `SELECT … FOR UPDATE` on the sale
 * (the same technique as physical returns/refunds), so two concurrent returns
 * cannot both read the same "remaining". Idempotent on `(saleId, idempotencyKey)`.
 */
export async function createSaleReturnAction(input: CreateSaleReturnInput): Promise<ActionResult<{ id: string; duplicate: boolean }>> {
  const user = await requirePermissionForAction("sales.return");
  const parsed = createSaleReturnSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  const data = parsed.data;

  // Row-scoped: a sale of a channel the user cannot read is simply not found.
  const sale = await prisma.sale.findFirst({ where: { id: data.saleId, ...saleChannelWhere(user) }, include: { lines: true } });
  if (!sale) return actionError("Vente introuvable.");
  // Stock returns to the sale's own location — the actor must be assigned to it.
  await requireLocationAccessForAction(user, sale.warehouseId);

  const existing = await prisma.saleReturn.findUnique({
    where: { saleId_idempotencyKey: { saleId: sale.id, idempotencyKey: data.idempotencyKey } },
  });
  if (existing) return actionOk({ id: existing.id, duplicate: true });

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "sales" WHERE id = ${sale.id} FOR UPDATE`;

      // Re-read under the lock: what has already come back, per line.
      const prior = await tx.saleReturnLine.groupBy({
        by: ["saleLineId"],
        where: { saleReturn: { saleId: sale.id } },
        _sum: { quantitySellable: true, quantityDamaged: true },
      });
      const returnedByLine = new Map(
        prior.map((p) => [p.saleLineId, (p._sum.quantitySellable ?? 0) + (p._sum.quantityDamaged ?? 0)])
      );

      const lineById = new Map(sale.lines.map((l) => [l.id, l]));
      const wanted = new Map<string, number>();
      for (const l of data.lines) {
        const saleLine = lineById.get(l.saleLineId);
        if (!saleLine) throw new SaleError("Une ligne retournée n'appartient pas à cette vente.");
        wanted.set(l.saleLineId, (wanted.get(l.saleLineId) ?? 0) + l.quantitySellable + l.quantityDamaged);
      }
      for (const [lineId, qty] of wanted) {
        const saleLine = lineById.get(lineId)!;
        const remaining = saleLine.quantity - (returnedByLine.get(lineId) ?? 0);
        if (qty > remaining) {
          throw new SaleError(
            `« ${saleLine.nameSnapshot} » : ${qty} unité(s) demandée(s) mais seulement ${remaining} restent retournables.`
          );
        }
      }

      // Refund cap: never more than was collected, net of earlier refunds.
      const refundedBefore = await tx.saleReturn.aggregate({ where: { saleId: sale.id }, _sum: { refundAmount: true } });
      const refundable = sale.total.minus(refundedBefore._sum.refundAmount ?? money(0));
      const refund = money(data.refundAmount);
      if (refund.greaterThan(refundable)) {
        throw new SaleError(`Le remboursement dépasse le montant remboursable (${refundable.toFixed(2)}).`);
      }

      const ret = await tx.saleReturn.create({
        data: {
          saleId: sale.id,
          idempotencyKey: data.idempotencyKey,
          refundAmount: refund,
          refundMethod: refund.greaterThan(0) ? data.refundMethod ?? null : null,
          note: nz(data.note),
          receivedById: user.id,
          receivedByName: user.name,
          lines: {
            create: data.lines.map((l) => {
              const sl = lineById.get(l.saleLineId)!;
              return {
                saleLineId: sl.id,
                nameSnapshot: sl.nameSnapshot,
                skuSnapshot: sl.skuSnapshot,
                quantitySellable: l.quantitySellable,
                quantityDamaged: l.quantityDamaged,
                warehouseId: sale.warehouseId,
              };
            }),
          },
        },
      });
      const displayNumber = await claimTenantDisplayNumber(tx, ret.tenantId, "saleReturn");
      const numbered = await tx.saleReturn.update({ where: { id: ret.id }, data: { displayNumber } });

      for (const l of data.lines) {
        const sl = lineById.get(l.saleLineId)!;
        if (!sl.productId && !sl.variationId) {
          throw new SaleError(`« ${sl.nameSnapshot} » n'existe plus dans le catalogue — retour impossible.`);
        }
        const ok = await applySaleReturnLine(tx, {
          warehouseId: sale.warehouseId,
          productId: sl.variationId ? null : sl.productId,
          variationId: sl.variationId,
          quantitySellable: l.quantitySellable,
          quantityDamaged: l.quantityDamaged,
          saleId: sale.id,
          saleReturnId: ret.id,
          performedById: user.id,
          label: displaySaleReturnNumber(numbered),
        });
        if (!ok) throw new SaleError(`« ${sl.nameSnapshot} » n'est plus suivi en stock à cet emplacement — retour impossible.`);
      }
      return numbered;
    });
  } catch (error) {
    if (error instanceof SaleError) return actionError(error.message);
    if (isUniqueConstraintError(error)) {
      const winner = await prisma.saleReturn.findUnique({
        where: { saleId_idempotencyKey: { saleId: sale.id, idempotencyKey: data.idempotencyKey } },
      });
      if (winner) return actionOk({ id: winner.id, duplicate: true });
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "sale.return_created",
    entityType: "SaleReturn",
    entityId: created.id,
    newValue: {
      number: displaySaleReturnNumber(created),
      saleId: sale.id,
      refundAmount: created.refundAmount.toString(),
      lineCount: data.lines.length,
    },
  });
  const refs = {
    productIds: sale.lines.map((l) => l.productId),
    variationIds: sale.lines.map((l) => l.variationId),
  };
  await pushStockAfterLocalChange(refs);

  revalidatePath("/ventes");
  revalidatePath(`/ventes/${sale.id}`);
  revalidatePath("/stock");
  return actionOk({ id: created.id, duplicate: false });
}
