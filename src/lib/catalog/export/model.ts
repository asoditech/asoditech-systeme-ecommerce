/**
 * Product CSV export — the platform-neutral product shape both exporters
 * read (docs/adr/0054). PURE: no Prisma, no server-only import, so the
 * WooCommerce and Shopify builders and the validator are unit-testable on
 * plain objects. `load.ts` maps database rows into this shape.
 */

export type ExportPlatform = "woocommerce" | "shopify";
export const EXPORT_PLATFORMS: readonly ExportPlatform[] = ["woocommerce", "shopify"];
export const EXPORT_PLATFORM_LABELS: Record<ExportPlatform, string> = { woocommerce: "WooCommerce", shopify: "Shopify" };

export interface ExportVariation {
  id: string;
  sku: string;
  /** Attribute name → value, in the order stored on the variation (e.g. { Taille: "M", Couleur: "Noir" }). */
  attributes: Record<string, string>;
  /** Regular price — the variation's own, else the parent's. */
  price: number | null;
  salePrice: number | null;
  isActive: boolean;
  imageUrl: string | null;
  barcode: string | null;
}

export interface ExportProduct {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  price: number | null;
  salePrice: number | null;
  status: "ACTIF" | "BROUILLON" | "ARCHIVE";
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  /** Category path from the root, e.g. ["Vêtements", "T-Shirts"]; [] = none. */
  categoryPath: string[];
  /** Whether the leaf category came from (and therefore exists in) a connected store. */
  categorySource: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY" | null;
  /** Ordered by position; the first is the main image. */
  images: { url: string; alt: string | null }[];
  barcode: string | null;
  variations: ExportVariation[];
  /** Platforms this product was already published to from ASODITECH. */
  publishedTo: ExportPlatform[];
}

/** Deterministic, platform-specific file name (server-local date). */
export function exportFilename(platform: ExportPlatform, now: Date = new Date()): string {
  return `asoditech-${platform}-products-${now.toLocaleDateString("en-CA")}.csv`;
}

/** Active variations only — an inactive variation is never offered for sale, so never exported. */
export function activeVariations(p: ExportProduct): ExportVariation[] {
  return p.variations.filter((v) => v.isActive);
}

/** Attribute names across the product's active variations, first-seen order. */
export function attributeNames(p: ExportProduct): string[] {
  const names: string[] = [];
  for (const v of activeVariations(p)) for (const k of Object.keys(v.attributes)) if (!names.includes(k)) names.push(k);
  return names;
}

/** Public, importable image URL: absolute http(s), not a local/private host, no data: URI. */
export function isPublicImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost") || h === "0.0.0.0" || h === "[::1]") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

const money = (n: number | null) => (n === null ? "" : n.toFixed(2));
export { money as formatExportMoney };

/**
 * RFC 4180 CSV for an IMPORT file: UTF-8 (no BOM), CRLF, a cell is quoted
 * when it contains a comma, quote, CR or LF (quotes doubled). Values are
 * written EXACTLY — no spreadsheet "formula guard" prefix — because the file
 * is meant to be imported by WooCommerce / Shopify, where a prepended
 * character would corrupt the merchant's own text.
 */
export function toImportCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
