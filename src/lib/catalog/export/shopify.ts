import { activeVariations, attributeNames, formatExportMoney, isPublicImageUrl, type ExportProduct } from "@/lib/catalog/export/model";

/**
 * Shopify product CSV (Shopify Help Center « Using CSV files to import and
 * export products », current template headers). docs/adr/0054.
 *
 * - One row per variant, all sharing the product's `URL handle`; product-level
 *   fields (Title, Description, Type, Status, …) only on the FIRST row, as in
 *   Shopify's own exports. Option NAMES only on the first row; option VALUES
 *   on every variant row. At most 3 options (Shopify's limit — the validator
 *   refuses more).
 * - A product without variations is Shopify's single default variant:
 *   `Option1 name` = "Title", `Option1 value` = "Default Title".
 * - Images: `Product image URL` + `Image position` on as many rows as there
 *   are images; extra images beyond the variant rows get handle-only rows.
 *   `Variant image URL` on the variant's row.
 * - `Product category` (Shopify Standard Product Taxonomy) is LEFT BLANK:
 *   an ASODITECH category cannot be verified against that taxonomy. The
 *   category name goes to `Type` (free text) — the validator warns.
 * - Price: Shopify « Price » is the selling price and « Compare-at price »
 *   the struck-through one, so an ASODITECH promo (salePrice < price)
 *   becomes Price = salePrice, Compare-at = price.
 * - No inventory quantity (ASODITECH is the stock authority) and no
 *   `Cost per item` (purchase cost is finance data, never exported).
 */

export const SHOPIFY_HEADERS = [
  "Title",
  "URL handle",
  "Description",
  "Vendor",
  "Product category",
  "Type",
  "Tags",
  "Published on online store",
  "Status",
  "SKU",
  "Barcodes",
  "Option1 name",
  "Option1 value",
  "Option1 LinkedTo",
  "Option2 name",
  "Option2 value",
  "Option2 LinkedTo",
  "Option3 name",
  "Option3 value",
  "Option3 LinkedTo",
  "Price",
  "Compare-at price",
  "Cost per item",
  "Charge tax",
  "Inventory tracker",
  "Inventory quantity",
  "Continue selling when out of stock",
  "Weight value (grams)",
  "Weight unit for display",
  "Requires shipping",
  "Fulfillment service",
  "Product image URL",
  "Image position",
  "Image alt text",
  "Variant image URL",
  "Gift card",
  "SEO title",
  "SEO description",
] as const;

type Header = (typeof SHOPIFY_HEADERS)[number];

/** URL handle: lowercase ASCII, accents folded, non-alphanumerics → "-". */
export function shopifyHandle(name: string, fallback: string): string {
  const slug = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return slug(name) || slug(fallback) || "produit";
}

const STATUS: Record<ExportProduct["status"], string> = { ACTIF: "active", BROUILLON: "draft", ARCHIVE: "archived" };

function prices(regular: number | null, sale: number | null): { price: string; compareAt: string } {
  if (sale !== null && regular !== null && sale < regular) return { price: formatExportMoney(sale), compareAt: formatExportMoney(regular) };
  return { price: formatExportMoney(regular), compareAt: "" };
}

export function buildShopifyCsv(products: readonly ExportProduct[]): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  const usedHandles = new Map<string, number>();

  for (const p of products) {
    const base = shopifyHandle(p.name, p.sku);
    const n = (usedHandles.get(base) ?? 0) + 1;
    usedHandles.set(base, n);
    const handle = n === 1 ? base : `${base}-${n}`;

    const variations = activeVariations(p);
    const optionNames = variations.length ? attributeNames(p).slice(0, 3) : ["Title"];
    const variants = variations.length
      ? variations.map((v) => ({ sku: v.sku, barcode: v.barcode, price: v.price, sale: v.salePrice, image: v.imageUrl, values: optionNames.map((o) => v.attributes[o] ?? "") }))
      : [{ sku: p.sku, barcode: p.barcode, price: p.price, sale: p.salePrice, image: null as string | null, values: ["Default Title"] }];
    const images = p.images.filter((i) => isPublicImageUrl(i.url));
    const rowCount = Math.max(variants.length, images.length);

    for (let i = 0; i < rowCount; i++) {
      const row: Partial<Record<Header, string>> = { "URL handle": handle };
      if (i === 0) {
        Object.assign(row, {
          Title: p.name,
          Description: p.description ?? "",
          Type: p.categoryPath.at(-1) ?? "",
          "Published on online store": p.status === "ACTIF" ? "TRUE" : "FALSE",
          Status: STATUS[p.status],
          "Gift card": "FALSE",
        });
        optionNames.forEach((name, k) => (row[`Option${k + 1} name` as Header] = name));
      }
      const v = variants[i];
      if (v) {
        const { price, compareAt } = prices(v.price, v.sale);
        Object.assign(row, {
          SKU: v.sku,
          Barcodes: v.barcode ?? "",
          Price: price,
          "Compare-at price": compareAt,
          "Requires shipping": "TRUE",
          "Fulfillment service": "manual",
          "Variant image URL": v.image && isPublicImageUrl(v.image) ? v.image : "",
        });
        v.values.forEach((value, k) => (row[`Option${k + 1} value` as Header] = value));
      }
      const img = images[i];
      if (img) {
        Object.assign(row, { "Product image URL": img.url, "Image position": String(i + 1), "Image alt text": img.alt ?? "" });
      }
      rows.push(SHOPIFY_HEADERS.map((h) => row[h] ?? ""));
    }
  }
  return { headers: [...SHOPIFY_HEADERS], rows };
}
