import "server-only";

import type { Barcode } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * Barcode identity — docs/adr/0038-online-offline-unification.md.
 *
 * A barcode identifies ONE sellable unit: a simple Product, or a
 * ProductVariation (never a variable parent — its stock lives on its
 * variations). Codes are OPAQUE: nothing here parses a code, and size /
 * colour are never derived from one.
 *
 * Uniqueness is DB-enforced per tenant across both owner kinds
 * (`barcodes_tenantId_code_key`, plus an XOR CHECK and one-primary-per-unit
 * partial indexes — see the migration). Two things a database index cannot
 * express are enforced HERE instead, at the application level:
 *
 *  1. A barcode may not equal the SKU of a DIFFERENT unit. `sku` is unique
 *     only per table (Product and ProductVariation are separate indexes), and
 *     the scan lookup resolves barcode → SKU, so a code equal to another
 *     unit's SKU would silently shadow it.
 *  2. The mirror image — a NEW SKU may not equal an existing barcode of a
 *     different unit — is `assertSkuFreeOfBarcodeAndSiblings` below, called by
 *     the product/variation create & update actions.
 *
 * Known, documented limitation: SKUs written by a WooCommerce/Shopify import
 * are not re-checked against barcodes (a sync must never fail on identity a
 * merchant added locally); lookup priority (barcode first) makes the outcome
 * deterministic in that case.
 */

type Db = typeof prisma | PrismaTransactionClient;

export class BarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarcodeError";
  }
}

/** Trim only — a barcode is an opaque string. Empty after trimming → null. */
export function normalizeBarcode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim();
  return code.length > 0 ? code : null;
}

const BARCODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,63}$/;

/** Shape check only (3–64 chars, alphanumerics plus `. _ - /`). No semantics. */
export function isValidBarcodeShape(code: string): boolean {
  return BARCODE_PATTERN.test(code);
}

export interface UnitRef {
  productId?: string | null;
  variationId?: string | null;
}

/** Resolves and validates the ONE sellable unit a barcode/identity edit targets. */
async function resolveUnit(db: Db, ref: UnitRef) {
  const hasProduct = Boolean(ref.productId);
  const hasVariation = Boolean(ref.variationId);
  if (hasProduct === hasVariation) {
    throw new BarcodeError("Un code-barres identifie soit un produit, soit une variation.");
  }
  if (ref.variationId) {
    const variation = await db.productVariation.findUnique({
      where: { id: ref.variationId },
      select: { id: true, sku: true, productId: true },
    });
    if (!variation) throw new BarcodeError("Variation introuvable.");
    return { kind: "variation" as const, id: variation.id, sku: variation.sku };
  }
  const product = await db.product.findUnique({
    where: { id: ref.productId! },
    select: { id: true, sku: true, _count: { select: { variations: true } } },
  });
  if (!product) throw new BarcodeError("Produit introuvable.");
  if (product._count.variations > 0) {
    throw new BarcodeError(
      "Ce produit a des variations : le code-barres se rattache à chaque variation (taille/couleur), pas au produit parent."
    );
  }
  return { kind: "product" as const, id: product.id, sku: product.sku };
}

/** Throws when `code` equals the SKU of a unit other than `except`. */
async function assertNotAnotherUnitsSku(db: Db, code: string, except: { kind: "product" | "variation"; id: string }) {
  const [product, variation] = await Promise.all([
    db.product.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
    db.productVariation.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
  ]);
  const clashesProduct = product && !(except.kind === "product" && except.id === product.id);
  const clashesVariation = variation && !(except.kind === "variation" && except.id === variation.id);
  if (clashesProduct || clashesVariation) {
    throw new BarcodeError("Ce code correspond déjà à la référence (SKU) d'un autre article.");
  }
}

export interface AddBarcodeInput extends UnitRef {
  code: string;
  makePrimary?: boolean;
  createdById?: string | null;
}

/**
 * The write itself, on a CALLER-SUPPLIED transaction client — so product
 * creation can add its first barcode atomically with the product. Throws
 * `BarcodeError` for every business rejection (P2002 is left to the caller /
 * `addBarcode`, which own the transaction boundary).
 *
 * The unit's FIRST barcode becomes primary automatically; `makePrimary`
 * promotes this one (demoting the old primary first, since only one primary
 * per unit exists).
 */
export async function addBarcodeInTx(tx: PrismaTransactionClient, input: AddBarcodeInput): Promise<Barcode> {
  const code = normalizeBarcode(input.code);
  if (!code) throw new BarcodeError("Le code-barres est requis.");
  if (!isValidBarcodeShape(code)) {
    throw new BarcodeError("Code-barres invalide : 3 à 64 caractères (lettres, chiffres, . _ - /).");
  }

  const unit = await resolveUnit(tx, input);
  await assertNotAnotherUnitsSku(tx, code, unit);

  const ownerWhere = unit.kind === "variation" ? { variationId: unit.id } : { productId: unit.id };
  const existingCount = await tx.barcode.count({ where: ownerWhere });
  const isPrimary = existingCount === 0 || Boolean(input.makePrimary);
  if (isPrimary && existingCount > 0) {
    await tx.barcode.updateMany({ where: { ...ownerWhere, isPrimary: true }, data: { isPrimary: false } });
  }
  return tx.barcode.create({
    data: {
      code,
      isPrimary,
      createdById: input.createdById ?? null,
      ...(unit.kind === "variation" ? { variationId: unit.id } : { productId: unit.id }),
    },
  });
}

/** Standalone form of `addBarcodeInTx`: opens its own transaction and maps a duplicate code to a friendly error. */
export async function addBarcode(input: AddBarcodeInput): Promise<Barcode> {
  try {
    return await prisma.$transaction((tx) => addBarcodeInTx(tx, input));
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new BarcodeError("Ce code-barres est déjà utilisé.");
    throw error;
  }
}

/** Removes a barcode; if it was primary, the oldest remaining code of that unit is promoted. */
export async function removeBarcode(barcodeId: string): Promise<{ removedCode: string }> {
  return prisma.$transaction(async (tx) => {
    const barcode = await tx.barcode.findUnique({ where: { id: barcodeId } });
    if (!barcode) throw new BarcodeError("Code-barres introuvable.");
    await tx.barcode.delete({ where: { id: barcode.id } });
    if (barcode.isPrimary) {
      const ownerWhere = barcode.variationId ? { variationId: barcode.variationId } : { productId: barcode.productId };
      const next = await tx.barcode.findFirst({ where: ownerWhere, orderBy: { createdAt: "asc" } });
      if (next) await tx.barcode.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
    return { removedCode: barcode.code };
  });
}

export async function setPrimaryBarcode(barcodeId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const barcode = await tx.barcode.findUnique({ where: { id: barcodeId } });
    if (!barcode) throw new BarcodeError("Code-barres introuvable.");
    if (barcode.isPrimary) return;
    const ownerWhere = barcode.variationId ? { variationId: barcode.variationId } : { productId: barcode.productId };
    await tx.barcode.updateMany({ where: { ...ownerWhere, isPrimary: true }, data: { isPrimary: false } });
    await tx.barcode.update({ where: { id: barcode.id }, data: { isPrimary: true } });
  });
}

/**
 * Application-level cross-table SKU guard (ADR 0038 §"Reference collisions").
 * `sku` is unique per table, so a Product SKU and a ProductVariation SKU may
 * collide, and either may collide with a barcode. Called by the create/update
 * actions before writing a SKU. `except` is the row being edited.
 */
export async function assertSkuFreeOfBarcodeAndSiblings(
  sku: string,
  except?: { kind: "product" | "variation"; id: string },
  db: Db = prisma
): Promise<string | null> {
  const [product, variation, barcode] = await Promise.all([
    db.product.findFirst({ where: { sku }, select: { id: true } }),
    db.productVariation.findFirst({ where: { sku }, select: { id: true } }),
    db.barcode.findFirst({ where: { code: sku }, select: { productId: true, variationId: true } }),
  ]);
  if (product && !(except?.kind === "product" && except.id === product.id)) {
    return "Un produit avec ce SKU existe déjà.";
  }
  if (variation && !(except?.kind === "variation" && except.id === variation.id)) {
    return "Ce SKU est déjà utilisé par une variation.";
  }
  if (barcode) {
    const ownedByExcept =
      (except?.kind === "product" && barcode.productId === except.id) ||
      (except?.kind === "variation" && barcode.variationId === except.id);
    if (!ownedByExcept) return "Ce SKU correspond déjà à un code-barres d'un autre article.";
  }
  return null;
}
