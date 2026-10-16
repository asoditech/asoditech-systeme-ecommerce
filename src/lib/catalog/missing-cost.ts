import type { Prisma, RecordSource } from "@prisma/client";

/**
 * « Coût d'achat manquant » — which sellable units have NO purchase cost to
 * freeze into an order / sale line, so their margin and every profit figure
 * built on them come out « Non calculable ».
 *
 * Effective cost = the variation's own cost, else the product's (the same
 * fallback order lines freeze: `variation?.cost ?? product?.cost`). So:
 *  - a simple product (no variation) is missing when `Product.cost` is null;
 *  - a variable product counts each ACTIVE variation whose cost is null while
 *    the product has none to fall back on.
 * Only ACTIF products: an archived / draft product is not being sold.
 *
 * Pure data rule — nothing is invented or defaulted: the warning disappears
 * by itself as soon as the cost is entered (by hand or by a reception), for
 * manually created and synchronised (WooCommerce / Shopify) products alike.
 */

/** Products with at least one sellable unit missing its purchase cost. */
export function missingCostProductWhere(): Prisma.ProductWhereInput {
  return {
    status: "ACTIF",
    cost: null,
    OR: [{ variations: { none: {} } }, { variations: { some: { isActive: true, cost: null } } }],
  };
}

/** Active variations (of ACTIF products) missing their effective purchase cost. */
export function missingCostVariationWhere(): Prisma.ProductVariationWhereInput {
  return { isActive: true, cost: null, product: { status: "ACTIF", cost: null } };
}

/** Simple ACTIF products (no variation) missing their purchase cost. */
export function missingCostSimpleProductWhere(): Prisma.ProductWhereInput {
  return { status: "ACTIF", cost: null, variations: { none: {} } };
}

export interface MissingCostSummary {
  /** Sellable units (simple products + active variations) without a cost. */
  units: number;
  /** Distinct products concerned (what the `?cout=manquant` list shows). */
  products: number;
  bySource: Record<RecordSource, number>;
  /**
   * Of those, units that DO have a purchase cost at one location at least
   * (InventoryItem.currentUnitCost). Still counted as missing: imported
   * WooCommerce / Shopify orders and online reports use the global cost only;
   * store sales and orders created here from that location use the
   * location cost first (src/lib/catalog/location-cost.ts). Absent = not computed.
   */
  withLocationCost?: number;
}

export function missingCostMessage(s: Pick<MissingCostSummary, "units">): string | null {
  if (s.units <= 0) return null;
  return `${s.units} produit(s)/variante(s) sans coût d'achat : les marges et rapports financiers sont incomplets.`;
}
