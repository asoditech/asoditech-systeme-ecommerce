import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";

/**
 * Sellable-unit lookup — docs/adr/0038-online-offline-unification.md.
 *
 * ONE search used by the sale screen, the reception screen and the
 * traceability page: it resolves whatever the operator typed or scanned to
 * SELLABLE UNITS — a simple Product, or one ProductVariation. A variable
 * parent is never a unit (its stock lives on its variations), so it is
 * expanded into its variations.
 *
 * Priority (first tier that matches wins; later tiers are not consulted):
 *   1. barcode      — exact match. A scan must resolve to exactly one unit.
 *   2. reference    — exact SKU (variation or product), case-insensitive. May
 *                     be ambiguous (Product and ProductVariation SKUs are
 *                     unique per table only) — every match is returned.
 *   3. name/partial — product name, model reference, SKU, variation SKU.
 *
 * No barcode parsing, and size/colour are read from the variation's own
 * `attributes` — never derived from a code or a name.
 */

type Db = typeof prisma | PrismaTransactionClient;

export type MatchedBy = "barcode" | "sku" | "partial";

export interface SellableUnit {
  productId: string;
  variationId: string | null;
  name: string;
  /** "Bleu / 42" — from the variation's attributes; null for a simple product. */
  variantLabel: string | null;
  sku: string;
  /** Model/family reference of the parent product. */
  reference: string | null;
  primaryBarcode: string | null;
  categoryName: string | null;
  /** Server-resolved default unit price: variation.price ?? product.salePrice ?? product.price. */
  price: number;
  cost: number | null;
  status: "ACTIF" | "BROUILLON" | "ARCHIVE";
  trackInventory: boolean;
  matchedBy: MatchedBy;
}

export interface LookupOptions {
  limit?: number;
  /** Only ACTIF products (what a sale/order may sell). Default true. */
  onlyActive?: boolean;
  /** Restrict to products enabled on this channel (ProductSalesChannel). */
  channelId?: string | null;
}

export function variantLabel(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const parts = Object.values(attributes as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  return parts.length > 0 ? parts.join(" / ") : null;
}

const productInclude = {
  category: { select: { name: true } },
  barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
  variations: {
    orderBy: { createdAt: "asc" as const },
    include: { barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 } },
  },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VariationRow = ProductRow["variations"][number];

const num = (d: { toString(): string } | null | undefined): number | null => (d == null ? null : Number(d.toString()));

function unitFromProduct(p: ProductRow, matchedBy: MatchedBy): SellableUnit {
  return {
    productId: p.id,
    variationId: null,
    name: p.name,
    variantLabel: null,
    sku: p.sku,
    reference: p.reference,
    primaryBarcode: p.barcodes[0]?.code ?? null,
    categoryName: p.category?.name ?? null,
    price: num(p.salePrice) ?? num(p.price) ?? 0,
    cost: num(p.cost),
    status: p.status,
    trackInventory: p.trackInventory,
    matchedBy,
  };
}

function unitFromVariation(p: ProductRow, v: VariationRow, matchedBy: MatchedBy): SellableUnit {
  return {
    productId: p.id,
    variationId: v.id,
    name: p.name,
    variantLabel: variantLabel(v.attributes),
    sku: v.sku,
    reference: p.reference,
    primaryBarcode: v.barcodes[0]?.code ?? null,
    categoryName: p.category?.name ?? null,
    price: num(v.price) ?? num(p.salePrice) ?? num(p.price) ?? 0,
    cost: num(v.cost) ?? num(p.cost),
    status: p.status,
    trackInventory: p.trackInventory,
    matchedBy,
  };
}

/** Expands a product into its sellable units (a variable parent → its variations). */
function unitsOf(p: ProductRow, matchedBy: MatchedBy, onlyVariationId?: string): SellableUnit[] {
  if (p.variations.length === 0) return [unitFromProduct(p, matchedBy)];
  return p.variations
    .filter((v) => (onlyVariationId ? v.id === onlyVariationId : true))
    .map((v) => unitFromVariation(p, v, matchedBy));
}

function baseProductWhere(opts: LookupOptions): Prisma.ProductWhereInput {
  return {
    ...(opts.onlyActive === false ? {} : { status: "ACTIF" as const }),
    ...(opts.channelId ? { salesChannels: { some: { salesChannelId: opts.channelId } } } : {}),
  };
}

export async function lookupSellableUnits(db: Db, rawQuery: string, opts: LookupOptions = {}): Promise<SellableUnit[]> {
  const query = rawQuery.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const base = baseProductWhere(opts);

  // 1. Barcode — exact. Resolves to exactly one unit by DB uniqueness.
  // `(tenantId, code)` is unique, and the tenant-scoped client adds the
  // tenant half, so a plain findFirst on `code` is an exact, unique lookup.
  const barcode = await db.barcode.findFirst({
    where: { code: query },
    select: { productId: true, variationId: true },
  });
  if (barcode) {
    const productWhere: Prisma.ProductWhereInput = barcode.variationId
      ? { ...base, variations: { some: { id: barcode.variationId } } }
      : { ...base, id: barcode.productId! };
    const product = await db.product.findFirst({ where: productWhere, include: productInclude });
    if (product) return unitsOf(product, "barcode", barcode.variationId ?? undefined);
    // A code that exists but is not sellable here (archived / not on this
    // channel) must NOT fall through to a fuzzy match — a scan is exact.
    return [];
  }

  // 2. Reference / SKU — exact, case-insensitive; variation and product both.
  const bySku = await db.product.findMany({
    where: {
      ...base,
      OR: [
        { sku: { equals: query, mode: "insensitive" } },
        { variations: { some: { sku: { equals: query, mode: "insensitive" } } } },
      ],
    },
    include: productInclude,
    take: limit,
  });
  if (bySku.length > 0) {
    const out: SellableUnit[] = [];
    for (const p of bySku) {
      const matchedVariation = p.variations.find((v) => v.sku.toLowerCase() === query.toLowerCase());
      if (matchedVariation) out.push(...unitsOf(p, "sku", matchedVariation.id));
      else out.push(...unitsOf(p, "sku"));
    }
    return out.slice(0, limit);
  }

  // 3. Partial — name, model reference, SKU, variation SKU.
  const partial = await db.product.findMany({
    where: {
      ...base,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { reference: { contains: query, mode: "insensitive" } },
        { sku: { contains: query, mode: "insensitive" } },
        { variations: { some: { sku: { contains: query, mode: "insensitive" } } } },
      ],
    },
    include: productInclude,
    orderBy: { name: "asc" },
    take: limit,
  });
  const out: SellableUnit[] = [];
  for (const p of partial) out.push(...unitsOf(p, "partial"));
  return out.slice(0, limit);
}
