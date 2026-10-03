import "server-only";

import type { Product, ProductVariation } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Store → ASODITECH product identity reconciliation (docs/adr/0055).
 *
 * Every integration path (product sync, product webhooks, order-line
 * mapping, stock push, deletion webhooks) identifies a store product by
 * `(source, externalId)`. A product that was CREATED in ASODITECH and then
 * reached the store another way — « Publier » (ProductPublication) or a CSV
 * export imported into the store — has `source = INTERNE` and no
 * `externalId`, so it used to come back as a duplicate (SKU suffixed
 * `-wc-<id>` / `-shop-<id>`).
 *
 * Resolution, in order — the first hit wins:
 *   1. LINKED:      a product with (source = provider, externalId = id).
 *   2. PUBLICATION: a ProductPublication (provider, externalId = id) → its
 *                   product, if still unlinked (INTERNE).
 *   3. SKU:         ONE unlinked (INTERNE) product of this tenant with exactly
 *                   the store product's SKU, of the same shape (variable ⇔ it
 *                   has variations), and not published to this provider under
 *                   a DIFFERENT id. For a variable store product without a
 *                   parent SKU (Shopify), every matching variant SKU must
 *                   belong to the SAME unlinked product.
 *   Otherwise: null — the caller creates a new product, as before.
 *
 * A match is ADOPTED: the existing product receives the store identity
 * (source/externalId), so every other path recognizes it from then on, and a
 * ProductPublication records the link. Adoption is a conditional update
 * (only while still unlinked) — a concurrent webhook + sync cannot both adopt.
 *
 * Never by name. Never two existing products merged. All queries go through
 * the tenant-scoped client: a product of another tenant is never a candidate.
 */

export type StoreProvider = "WOOCOMMERCE" | "SHOPIFY";

export interface StoreProductHints {
  /** The store product's own SKU (trimmed, may be empty). */
  sku: string | null;
  /** Whether the store product has variants (WooCommerce `variable`, a non-default Shopify product). */
  isVariable: boolean;
  /** Variant SKUs, used only when the parent has no SKU (Shopify). */
  variantSkus?: string[];
}

export interface ResolvedStoreProduct {
  product: Product;
  /** How it was found: already linked, or adopted now (by publication / SKU). */
  via: "linked" | "publication" | "sku";
}

export async function resolveStoreProduct(provider: StoreProvider, externalId: string, hints: StoreProductHints): Promise<ResolvedStoreProduct | null> {
  const linked = await prisma.product.findFirst({ where: { source: provider, externalId } });
  if (linked) return { product: linked, via: "linked" };

  const publication = await prisma.productPublication.findFirst({
    where: { provider, externalId, product: { source: "INTERNE" } },
    select: { productId: true },
  });
  if (publication) {
    const adopted = await adopt(provider, externalId, publication.productId, "publication");
    if (adopted) return { product: adopted, via: "publication" };
  }

  const candidateId = await skuCandidate(provider, externalId, hints);
  if (candidateId) {
    const adopted = await adopt(provider, externalId, candidateId, "sku");
    if (adopted) return { product: adopted, via: "sku" };
  }

  // Lost a race to a concurrent adoption of the same store product: it is linked now.
  const raced = await prisma.product.findFirst({ where: { source: provider, externalId } });
  return raced ? { product: raced, via: "linked" } : null;
}

async function skuCandidate(provider: StoreProvider, externalId: string, hints: StoreProductHints): Promise<string | null> {
  const unlinked = { source: "INTERNE" as const, externalId: null };
  let candidateId: string | null = null;

  const sku = hints.sku?.trim();
  if (sku) {
    const p = await prisma.product.findFirst({ where: { sku, ...unlinked }, select: { id: true } });
    candidateId = p?.id ?? null;
  } else if (hints.isVariable && hints.variantSkus?.length) {
    const skus = [...new Set(hints.variantSkus.map((s) => s.trim()).filter(Boolean))];
    if (skus.length === 0) return null;
    const vars = await prisma.productVariation.findMany({ where: { sku: { in: skus } }, select: { productId: true, source: true, product: { select: { source: true, externalId: true } } } });
    const owners = new Set(vars.map((v) => v.productId));
    const allUnlinked = vars.every((v) => v.source === "INTERNE" && v.product.source === "INTERNE" && v.product.externalId === null);
    // Every matched variant must point to ONE product — never stitch variants of several products together.
    if (vars.length > 0 && owners.size === 1 && allUnlinked) candidateId = [...owners][0];
  }
  if (!candidateId) return null;

  const candidate = await prisma.product.findFirst({
    where: { id: candidateId },
    select: { _count: { select: { variations: true } }, publications: { where: { provider }, select: { externalId: true } } },
  });
  if (!candidate) return null;
  // Shape must agree: a simple store product never adopts a product with variations, and vice versa.
  if ((candidate._count.variations > 0) !== hints.isVariable) return null;
  // Already published to this provider under ANOTHER id: ambiguous — never guess.
  if (candidate.publications.some((p) => p.externalId !== externalId)) return null;
  return candidateId;
}

async function adopt(provider: StoreProvider, externalId: string, productId: string, how: "publication" | "sku"): Promise<Product | null> {
  const moved = await prisma.product.updateMany({
    where: { id: productId, source: "INTERNE", externalId: null },
    data: { source: provider, externalId },
  });
  if (moved.count === 0) return null;
  const product = await prisma.product.findFirstOrThrow({ where: { id: productId } });
  const existing = await prisma.productPublication.findFirst({ where: { productId, provider } });
  if (!existing) {
    await prisma.productPublication.create({
      data: { productId, provider, externalId, publishedByName: how === "sku" ? "Rapprochement automatique (SKU)" : "Rapprochement automatique" },
    });
  }
  return product;
}

/**
 * Same rule for a variation, strictly WITHIN its parent: (provider,
 * externalId) first, else one unlinked variation of THAT product with exactly
 * this SKU — never a variation of another product. Adopted conditionally.
 */
export async function resolveStoreVariation(provider: StoreProvider, externalId: string, productId: string, sku: string | null): Promise<ProductVariation | null> {
  const linked = await prisma.productVariation.findFirst({ where: { source: provider, externalId } });
  if (linked) return linked;
  const s = sku?.trim();
  if (!s) return null;
  const candidate = await prisma.productVariation.findFirst({ where: { productId, sku: s, source: "INTERNE", externalId: null }, select: { id: true } });
  if (!candidate) return null;
  const moved = await prisma.productVariation.updateMany({
    where: { id: candidate.id, source: "INTERNE", externalId: null },
    data: { source: provider, externalId },
  });
  if (moved.count === 0) return prisma.productVariation.findFirst({ where: { source: provider, externalId } });
  return prisma.productVariation.findFirst({ where: { id: candidate.id } });
}
