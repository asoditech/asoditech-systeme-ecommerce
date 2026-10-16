import { formatCurrency } from "@/lib/format";

type Money = { toString(): string } | number | string | null | undefined;

/**
 * « Prix de vente » of a variable product on /produits and the product page.
 *
 * Each variation's REGULAR price is `variation.price ?? product.price` — the
 * documented inheritance (variant-edit-dialog `regularPrice`, the variations
 * table, src/lib/catalog/lookup.ts). A variation created in ASODITECH without
 * its own price stores `price = null` and sells at the parent's price, so
 * reading `variation.price` alone showed « — » for priced products.
 *
 * Nothing is invented: a WooCommerce variable parent keeps price 0, so when
 * no variation has a price either, the label stays « — ».
 */
export function variationPriceRange(productPrice: Money, variations: { price: Money }[]): { min: number; max: number } | null {
  const parent = productPrice == null ? null : Number(productPrice.toString());
  const prices = variations
    .map((v) => (v.price != null ? Number(v.price.toString()) : parent))
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
  if (prices.length === 0) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

export function formatPriceRange(range: { min: number; max: number } | null, currency?: string): string {
  if (!range) return "—";
  return range.min === range.max
    ? formatCurrency(String(range.min), currency)
    : `${formatCurrency(String(range.min), currency)} – ${formatCurrency(String(range.max), currency)}`;
}
