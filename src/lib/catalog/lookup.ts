import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { variationIdsMatchingOptionValue } from "@/lib/catalog/variation-search";

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
  /**
   * Server-resolved default unit price. Batch 4 adds ONE new top tier —
   * a variation's own `salePrice`, when set — on top of the pre-existing
   * chain, which is otherwise unchanged: variation.salePrice ??
   * variation.price ?? product.salePrice ?? product.price.
   */
  price: number;
  cost: number | null;
  status: "ACTIF" | "BROUILLON" | "ARCHIVE";
  trackInventory: boolean;
  matchedBy: MatchedBy;
}

/**
 * A sellable unit as it may be sent to a SELLER's browser (Phase 4A, G1 —
 * docs/adr/0042-store-seller-role.md): everything the sale screen needs to
 * identify, price and add a unit, minus the procurement cost. The sale price
 * is still resolved on the server at `createSaleAction` time, and the sale's
 * `costSnapshot` is read from the database there — never from this payload.
 */
export type SellerSafeUnit = Omit<SellableUnit, "cost">;

/** Explicitly rebuilt (not spread-then-delete) so a field later added to
 * `SellableUnit` never reaches a seller's browser without a deliberate
 * decision here. */
export function toSellerSafeUnit(unit: SellableUnit): SellerSafeUnit {
  return {
    productId: unit.productId,
    variationId: unit.variationId,
    name: unit.name,
    variantLabel: unit.variantLabel,
    sku: unit.sku,
    reference: unit.reference,
    primaryBarcode: unit.primaryBarcode,
    categoryName: unit.categoryName,
    price: unit.price,
    status: unit.status,
    trackInventory: unit.trackInventory,
    matchedBy: unit.matchedBy,
  };
}

export interface LookupOptions {
  limit?: number;
  /** Only ACTIF products AND, for a variation, only an active one — what a
   * new sale/order/POS operation may sell (Batch 4, Task 11). Default true. */
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
    price: num(v.salePrice) ?? num(v.price) ?? num(p.salePrice) ?? num(p.price) ?? 0,
    cost: num(v.cost) ?? num(p.cost),
    status: p.status,
    trackInventory: p.trackInventory,
    matchedBy,
  };
}

/**
 * Expands a product into its sellable units (a variable parent → its
 * variations). `onlyActive` (Batch 4, Task 11) drops an inactive variation
 * from the result — never the product itself, and never a simple product
 * (which has no variation-level active flag), so a product with SOME
 * inactive variations still returns its remaining active ones.
 */
function unitsOf(
  p: ProductRow,
  matchedBy: MatchedBy,
  opts: { onlyVariationId?: string; onlyVariationIds?: ReadonlySet<string>; onlyActive?: boolean } = {}
): SellableUnit[] {
  if (p.variations.length === 0) return [unitFromProduct(p, matchedBy)];
  return p.variations
    .filter((v) => (opts.onlyVariationId ? v.id === opts.onlyVariationId : true))
    .filter((v) => (opts.onlyVariationIds ? opts.onlyVariationIds.has(v.id) : true))
    .filter((v) => (opts.onlyActive === false ? true : v.isActive))
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
    if (product) {
      return unitsOf(product, "barcode", { onlyVariationId: barcode.variationId ?? undefined, onlyActive: opts.onlyActive });
    }
    // A code that exists but is not sellable here (archived / not on this
    // channel / an inactive variation) must NOT fall through to a fuzzy
    // match — a scan is exact.
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
      if (matchedVariation) out.push(...unitsOf(p, "sku", { onlyVariationId: matchedVariation.id, onlyActive: opts.onlyActive }));
      else out.push(...unitsOf(p, "sku", { onlyActive: opts.onlyActive }));
    }
    return out.slice(0, limit);
  }

  // 3. Partial — name, model reference, SKU, variation SKU, and variation
  //    OPTION VALUES ("Rouge", "XL" — src/lib/catalog/variation-search.ts).
  const optionIds = await variationIdsMatchingOptionValue(query);
  const partial = await db.product.findMany({
    where: {
      ...base,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { reference: { contains: query, mode: "insensitive" } },
        { sku: { contains: query, mode: "insensitive" } },
        { variations: { some: { sku: { contains: query, mode: "insensitive" } } } },
        ...(optionIds.length > 0 ? [{ variations: { some: { id: { in: optionIds } } } }] : []),
      ],
    },
    include: productInclude,
    orderBy: { name: "asc" },
    take: limit,
  });
  const optionSet = new Set(optionIds);
  const out: SellableUnit[] = [];
  for (const p of partial) {
    // Matched by the PRODUCT itself (name / reference / product SKU): every
    // unit, exactly as before. Matched through its variations (a variation SKU
    // or an option value): just those variations ("T-shirt — Rouge / M",
    // "Rouge / L") — so the result shows why it matched.
    const onlyVariationIds = productLevelMatches(p, query) ? undefined : matchingVariationIds(p.variations, query, optionSet);
    out.push(...unitsOf(p, "partial", { onlyActive: opts.onlyActive, onlyVariationIds }));
  }
  return out.slice(0, limit);
}

/**
 * The first sellable units with NO search text — the picker's initial list
 * when it is opened empty. Same product filter (active / channel), same
 * expansion and serialization as `lookupSellableUnits`; fixed order (name,
 * then id) and a hard cap, never the whole catalogue. Tagged "partial" so an
 * exact-match shortcut (scanner auto-add) can never fire on this list.
 */
export async function listSellableUnits(db: Db, opts: LookupOptions = {}): Promise<SellableUnit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const products = await db.product.findMany({
    where: baseProductWhere(opts),
    include: productInclude,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit,
  });
  const out: SellableUnit[] = [];
  for (const p of products) out.push(...unitsOf(p, "partial", { onlyActive: opts.onlyActive }));
  return out.slice(0, limit);
}

/**
 * Whether the PRODUCT itself matches `query` by its own text — name, model
 * reference or product SKU (case-insensitive). When it does, the search shows
 * all its units; otherwise only the variations that match
 * (`matchingVariationIds`).
 */
export function productLevelMatches(p: { name: string; reference?: string | null; sku: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.reference ?? "", p.sku].some((s) => s.toLowerCase().includes(q));
}

/** Ids of the variations that match `query` by their SKU (partial) or an option value. */
export function matchingVariationIds(
  variations: readonly { id: string; sku: string }[],
  query: string,
  optionVariationIds: ReadonlySet<string>
): Set<string> {
  const q = query.trim().toLowerCase();
  return new Set(variations.filter((v) => optionVariationIds.has(v.id) || (q !== "" && v.sku.toLowerCase().includes(q))).map((v) => v.id));
}
