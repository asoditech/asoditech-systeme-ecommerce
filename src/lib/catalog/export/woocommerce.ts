import { activeVariations, attributeNames, formatExportMoney, isPublicImageUrl, type ExportProduct } from "@/lib/catalog/export/model";

/**
 * WooCommerce product CSV (built-in importer — WooCommerce wiki « Product CSV
 * Import Schema »). docs/adr/0054.
 *
 * - Simple product: one `simple` row.
 * - Variable product: one `variable` parent row carrying every attribute and
 *   all its values, then one `variation` row per ACTIVE variation whose
 *   `Parent` is the parent's SKU and whose attribute columns hold its single
 *   value. Attributes are product-level (« global » = 0): no global
 *   WooCommerce attribute taxonomy is created implicitly.
 * - `Images`: comma-separated URLs, first = featured. A variation row carries
 *   its own image.
 * - `Categories`: hierarchy with " > " (multiple would be separated by ","):
 *   a literal comma is escaped as "\," per the importer's rules.
 * - Stock columns are deliberately NOT exported: ASODITECH stays the stock
 *   authority (docs/adr/0036) and a quantity in a file would be stale on import.
 * - Purchase cost is never exported.
 */

const BASE_HEADERS = [
  "Type",
  "SKU",
  "GTIN, UPC, EAN, or ISBN",
  "Name",
  "Published",
  "Visibility in catalog",
  "Description",
  "Regular price",
  "Sale price",
  "Categories",
  "Images",
  "Parent",
] as const;

const escapeList = (v: string) => v.replace(/,/g, "\\,");
const published = (status: ExportProduct["status"]) => (status === "ACTIF" ? "1" : "-1");
const salePriceFor = (regular: number | null, sale: number | null) =>
  sale !== null && regular !== null && sale < regular ? formatExportMoney(sale) : "";
const images = (urls: string[]) => urls.filter((u) => isPublicImageUrl(u) && !u.includes(",")).join(", ");

export function buildWooCommerceCsv(products: readonly ExportProduct[]): { headers: string[]; rows: string[][] } {
  const maxAttributes = Math.max(0, ...products.map((p) => attributeNames(p).length));
  const attrHeaders: string[] = [];
  for (let i = 1; i <= maxAttributes; i++) {
    attrHeaders.push(`Attribute ${i} name`, `Attribute ${i} value(s)`, `Attribute ${i} visible`, `Attribute ${i} global`);
  }
  const headers = [...BASE_HEADERS, ...attrHeaders];
  const rows: string[][] = [];
  const pad = (cells: string[]) => [...cells, ...Array(attrHeaders.length).fill("")].slice(0, headers.length);

  for (const p of products) {
    const variations = activeVariations(p);
    const category = p.categoryPath.length ? p.categoryPath.map(escapeList).join(" > ") : "";
    const productImages = images(p.images.map((i) => i.url));

    if (variations.length === 0) {
      rows.push(
        pad([
          "simple",
          p.sku,
          p.barcode ?? "",
          p.name,
          published(p.status),
          "visible",
          p.description ?? "",
          formatExportMoney(p.price),
          salePriceFor(p.price, p.salePrice),
          category,
          productImages,
          "",
        ])
      );
      continue;
    }

    const names = attributeNames(p);
    const parentAttrs: string[] = [];
    names.forEach((name) => {
      const values: string[] = [];
      for (const v of variations) {
        const value = v.attributes[name];
        if (value && !values.includes(value)) values.push(value);
      }
      parentAttrs.push(name, values.map(escapeList).join(", "), "1", "0");
    });
    rows.push(
      pad([
        "variable",
        p.sku,
        p.barcode ?? "",
        p.name,
        published(p.status),
        "visible",
        p.description ?? "",
        "",
        "",
        category,
        productImages,
        "",
        ...parentAttrs,
      ])
    );

    for (const v of variations) {
      const varAttrs: string[] = [];
      names.forEach((name) => varAttrs.push(name, escapeList(v.attributes[name] ?? ""), "", "0"));
      const label = names.map((n) => v.attributes[n]).filter(Boolean).join(", ");
      rows.push(
        pad([
          "variation",
          v.sku,
          v.barcode ?? "",
          label ? `${p.name} - ${label}` : p.name,
          published(p.status),
          "visible",
          "",
          formatExportMoney(v.price),
          salePriceFor(v.price, v.salePrice),
          "",
          v.imageUrl ? images([v.imageUrl]) : "",
          p.sku,
          ...varAttrs,
        ])
      );
    }
  }
  return { headers, rows };
}
