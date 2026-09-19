"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { requireCapabilityForAction } from "@/lib/auth/capabilities";
import { recordAuditEvent } from "@/lib/audit";
import { addBarcode, removeBarcode, setPrimaryBarcode, BarcodeError } from "@/lib/catalog/barcodes";
import { lookupSellableUnits, type SellableUnit } from "@/lib/catalog/lookup";
import {
  addBarcodeSchema,
  barcodeIdSchema,
  updateProductReferenceSchema,
  setProductChannelsSchema,
  lookupQuerySchema,
  type AddBarcodeInput,
} from "@/lib/validation/catalog";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Catalog identity — docs/adr/0038-online-offline-unification.md.
 *
 * Reference, barcodes and channel availability are ASODITECH-OWNED, exactly
 * like `cost`/`trackInventory`/`lowStockThreshold` (docs/adr/0017): no
 * WooCommerce/Shopify sync ever writes them, so — unlike name/SKU/price —
 * they stay editable on an externally sourced product. Category is NOT
 * touched here: for a synced product it remains provider-owned.
 */

export async function addBarcodeAction(input: AddBarcodeInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");
  requireCapabilityForAction(user, "catalogIdentity"); // docs/adr/0041
  const parsed = addBarcodeSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  try {
    const barcode = await addBarcode({
      productId: parsed.data.productId,
      variationId: parsed.data.variationId,
      code: parsed.data.code,
      makePrimary: parsed.data.makePrimary,
      createdById: user.id,
    });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "product.barcode_added",
      entityType: "Product",
      entityId: parsed.data.productId ?? (await productIdOfVariation(parsed.data.variationId!)),
      newValue: { code: barcode.code, isPrimary: barcode.isPrimary, variationId: barcode.variationId },
    });
    revalidatePath("/produits");
    return actionOk({ id: barcode.id });
  } catch (error) {
    if (error instanceof BarcodeError) return actionError(error.message, { code: [error.message] });
    throw error;
  }
}

async function productIdOfVariation(variationId: string): Promise<string> {
  const v = await prisma.productVariation.findUnique({ where: { id: variationId }, select: { productId: true } });
  return v?.productId ?? variationId;
}

export async function removeBarcodeAction(input: { barcodeId: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");
  requireCapabilityForAction(user, "catalogIdentity");
  const parsed = barcodeIdSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const existing = await prisma.barcode.findUnique({ where: { id: parsed.data.barcodeId } });
  if (!existing) return actionError("Code-barres introuvable.");
  try {
    await removeBarcode(existing.id);
  } catch (error) {
    if (error instanceof BarcodeError) return actionError(error.message);
    throw error;
  }
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.barcode_removed",
    entityType: "Product",
    entityId: existing.productId ?? (await productIdOfVariation(existing.variationId!)),
    previousValue: { code: existing.code, variationId: existing.variationId },
  });
  revalidatePath("/produits");
  return actionOk({ id: existing.id });
}

export async function setPrimaryBarcodeAction(input: { barcodeId: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");
  requireCapabilityForAction(user, "catalogIdentity");
  const parsed = barcodeIdSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");
  try {
    await setPrimaryBarcode(parsed.data.barcodeId);
  } catch (error) {
    if (error instanceof BarcodeError) return actionError(error.message);
    throw error;
  }
  revalidatePath("/produits");
  return actionOk({ id: parsed.data.barcodeId });
}

/** Model/family reference. ASODITECH-owned → allowed for synced products too. */
export async function updateProductReferenceAction(input: {
  productId: string;
  reference: string | null;
}): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");
  requireCapabilityForAction(user, "catalogIdentity");
  const parsed = updateProductReferenceSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!existing) return actionError("Produit introuvable.");

  const reference = parsed.data.reference && parsed.data.reference.trim().length > 0 ? parsed.data.reference.trim() : null;
  await prisma.product.update({ where: { id: existing.id }, data: { reference } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.identity_updated",
    entityType: "Product",
    entityId: existing.id,
    previousValue: { reference: existing.reference },
    newValue: { reference },
  });
  revalidatePath("/produits");
  revalidatePath(`/produits/${existing.id}`);
  return actionOk({ id: existing.id });
}

/**
 * Replaces a product's channel availability with exactly `salesChannelIds`.
 * Availability ONLY — "this product may be sold here". It stores and moves no
 * quantity. Unknown / other-tenant channel ids fail as "introuvable" (the
 * scoped client cannot see them).
 */
export async function setProductChannelsAction(input: {
  productId: string;
  salesChannelIds: string[];
}): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");
  requireCapabilityForAction(user, "storeChannels");
  const parsed = setProductChannelsSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) return actionError("Produit introuvable.");

  const wanted = [...new Set(parsed.data.salesChannelIds)];
  const channels = await prisma.salesChannel.findMany({ where: { id: { in: wanted } } });
  if (channels.length !== wanted.length) return actionError("Canal de vente introuvable.");
  if (channels.some((c) => !c.isActive)) return actionError("Un canal sélectionné est inactif.");

  const current = await prisma.productSalesChannel.findMany({ where: { productId: product.id } });
  const currentIds = new Set(current.map((c) => c.salesChannelId));
  const toAdd = wanted.filter((id) => !currentIds.has(id));
  const toRemove = current.filter((c) => !wanted.includes(c.salesChannelId)).map((c) => c.id);

  await prisma.$transaction(async (tx) => {
    if (toRemove.length > 0) await tx.productSalesChannel.deleteMany({ where: { id: { in: toRemove } } });
    if (toAdd.length > 0) {
      await tx.productSalesChannel.createMany({
        data: toAdd.map((salesChannelId) => ({ productId: product.id, salesChannelId })),
        skipDuplicates: true,
      });
    }
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.channels_updated",
    entityType: "Product",
    entityId: product.id,
    previousValue: { salesChannelIds: [...currentIds] },
    newValue: { salesChannelIds: wanted },
  });
  revalidatePath(`/produits/${product.id}`);
  return actionOk({ id: product.id });
}

/**
 * Barcode → reference/SKU → name lookup, variant-aware (see lookup.ts).
 * Used by the product-facing pickers. The sale and reception screens have
 * their own actions with their own permission and channel scope.
 */
export async function lookupSellableUnitsAction(input: {
  query: string;
  channelId?: string | null;
}): Promise<SellableUnit[]> {
  const user = await requirePermissionForAction("products.view");
  requireCapabilityForAction(user, "catalogIdentity");
  const parsed = lookupQuerySchema.safeParse(input);
  if (!parsed.success) return [];
  return lookupSellableUnits(prisma, parsed.data.query, { channelId: parsed.data.channelId ?? null, onlyActive: false });
}
