import { describe, expect, it } from "vitest";
import { exportFilename, toImportCsv, type ExportProduct } from "@/lib/catalog/export/model";
import { buildWooCommerceCsv } from "@/lib/catalog/export/woocommerce";
import { buildShopifyCsv, SHOPIFY_HEADERS, shopifyHandle } from "@/lib/catalog/export/shopify";
import { validateExport } from "@/lib/catalog/export/validate";

/** Pure exporters / validator — docs/adr/0054. */

const base = (over: Partial<ExportProduct> = {}): ExportProduct => ({
  id: "p1",
  name: "Basket Été",
  sku: "BSK-1",
  description: "Toile, semelle « gomme »",
  price: 300,
  salePrice: 250,
  status: "ACTIF",
  source: "INTERNE",
  categoryPath: ["Chaussures", "Baskets"],
  categorySource: "INTERNE",
  images: [
    { url: "https://cdn.example.com/a.jpg", alt: "Face" },
    { url: "https://cdn.example.com/b.jpg", alt: null },
    { url: "https://cdn.example.com/c.jpg", alt: null },
  ],
  barcode: "6111000000011",
  variations: [],
  publishedTo: [],
  ...over,
});
const variable = (over: Partial<ExportProduct> = {}): ExportProduct =>
  base({
    id: "p2",
    name: "T-Shirt",
    sku: "TS",
    barcode: null,
    variations: [
      { id: "v1", sku: "TS-S-N", attributes: { Taille: "S", Couleur: "Noir" }, price: 100, salePrice: null, isActive: true, imageUrl: "https://cdn.example.com/ts-n.jpg", barcode: "611100000002" },
      { id: "v2", sku: "TS-M-N", attributes: { Taille: "M", Couleur: "Noir" }, price: 110, salePrice: 90, isActive: true, imageUrl: null, barcode: null },
      { id: "v3", sku: "TS-L-N", attributes: { Taille: "L", Couleur: "Noir" }, price: 120, salePrice: null, isActive: false, imageUrl: null, barcode: null },
    ],
    ...over,
  });
const col = (headers: string[], row: string[], name: string) => row[headers.indexOf(name)];

describe("WooCommerce CSV", () => {
  it("simple product: official headers, prices, featured image first, category hierarchy, barcode", () => {
    const { headers, rows } = buildWooCommerceCsv([base()]);
    expect(headers.slice(0, 4)).toEqual(["Type", "SKU", "GTIN, UPC, EAN, or ISBN", "Name"]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(col(headers, r, "Type")).toBe("simple");
    expect(col(headers, r, "Published")).toBe("1");
    expect(col(headers, r, "Regular price")).toBe("300.00");
    expect(col(headers, r, "Sale price")).toBe("250.00");
    expect(col(headers, r, "Categories")).toBe("Chaussures > Baskets");
    expect(col(headers, r, "Images")).toBe("https://cdn.example.com/a.jpg, https://cdn.example.com/b.jpg, https://cdn.example.com/c.jpg");
    expect(col(headers, r, "GTIN, UPC, EAN, or ISBN")).toBe("6111000000011");
  });

  it("variable product: parent with all values, one row per ACTIVE variation linked by parent SKU", () => {
    const { headers, rows } = buildWooCommerceCsv([variable()]);
    expect(rows.map((r) => col(headers, r, "Type"))).toEqual(["variable", "variation", "variation"]); // L is inactive
    const [parent, s, m] = rows;
    expect(col(headers, parent, "Attribute 1 name")).toBe("Taille");
    expect(col(headers, parent, "Attribute 1 value(s)")).toBe("S, M");
    expect(col(headers, parent, "Attribute 2 value(s)")).toBe("Noir");
    expect(col(headers, parent, "Regular price")).toBe("");
    expect(col(headers, s, "Parent")).toBe("TS");
    expect(col(headers, s, "Attribute 1 value(s)")).toBe("S");
    expect(col(headers, s, "Images")).toBe("https://cdn.example.com/ts-n.jpg");
    expect(col(headers, s, "GTIN, UPC, EAN, or ISBN")).toBe("611100000002");
    expect(col(headers, m, "Sale price")).toBe("90.00");
    expect(col(headers, m, "Name")).toBe("T-Shirt - M, Noir");
  });

  it("escapes a comma inside a category or attribute value; drafts are unpublished; a sale ≥ price is dropped", () => {
    const { headers, rows } = buildWooCommerceCsv([base({ categoryPath: ["Hommes, Femmes"], status: "ARCHIVE", salePrice: 400 })]);
    expect(col(headers, rows[0], "Categories")).toBe("Hommes\\, Femmes");
    expect(col(headers, rows[0], "Published")).toBe("-1");
    expect(col(headers, rows[0], "Sale price")).toBe("");
  });
});

describe("Shopify CSV", () => {
  it("simple product: Default Title variant, product fields on row 1, extra images on handle-only rows", () => {
    const { headers, rows } = buildShopifyCsv([base()]);
    expect(headers).toEqual([...SHOPIFY_HEADERS]);
    expect(rows).toHaveLength(3); // 1 variant, 3 images
    expect(col(headers, rows[0], "URL handle")).toBe("basket-ete");
    expect(col(headers, rows[0], "Title")).toBe("Basket Été");
    expect(col(headers, rows[0], "Option1 name")).toBe("Title");
    expect(col(headers, rows[0], "Option1 value")).toBe("Default Title");
    expect(col(headers, rows[0], "Price")).toBe("250.00");
    expect(col(headers, rows[0], "Compare-at price")).toBe("300.00");
    expect(col(headers, rows[0], "Status")).toBe("active");
    expect(col(headers, rows[0], "Type")).toBe("Baskets");
    expect(col(headers, rows[0], "Product category")).toBe("");
    expect(col(headers, rows[0], "Barcodes")).toBe("6111000000011");
    expect(col(headers, rows[1], "Title")).toBe("");
    expect(col(headers, rows[1], "SKU")).toBe("");
    expect(rows.slice(1).map((r) => [col(headers, r, "URL handle"), col(headers, r, "Product image URL"), col(headers, r, "Image position")])).toEqual([
      ["basket-ete", "https://cdn.example.com/b.jpg", "2"],
      ["basket-ete", "https://cdn.example.com/c.jpg", "3"],
    ]);
    expect(col(headers, rows[0], "Cost per item")).toBe("");
    expect(col(headers, rows[0], "Inventory quantity")).toBe("");
  });

  it("variable product: one row per active variant sharing the handle, option names only on row 1, variant image", () => {
    const { headers, rows } = buildShopifyCsv([variable()]);
    expect(rows.map((r) => col(headers, r, "SKU"))).toEqual(["TS-S-N", "TS-M-N", ""]); // 2 variants, 3 images
    expect(col(headers, rows[0], "Option1 name")).toBe("Taille");
    expect(col(headers, rows[1], "Option1 name")).toBe("");
    expect(col(headers, rows[1], "Option1 value")).toBe("M");
    expect(col(headers, rows[1], "Option2 value")).toBe("Noir");
    expect(col(headers, rows[0], "Variant image URL")).toBe("https://cdn.example.com/ts-n.jpg");
    expect(new Set(rows.map((r) => col(headers, r, "URL handle")))).toEqual(new Set(["t-shirt"]));
  });

  it("handles: accents folded, deterministic de-duplication within the file", () => {
    expect(shopifyHandle("Ça va Été!", "x")).toBe("ca-va-ete");
    const { headers, rows } = buildShopifyCsv([base({ id: "a", images: [] }), base({ id: "b", sku: "BSK-2", images: [] })]);
    expect(rows.map((r) => col(headers, r, "URL handle"))).toEqual(["basket-ete", "basket-ete-2"]);
  });
});

describe("CSV writer and file names", () => {
  it("RFC 4180 quoting, Unicode preserved, CRLF, no BOM, no formula prefix", () => {
    const csv = toImportCsv(["A", "B"], [["a,b", 'say "hi"'], ["line1\nline2", "=SUM(1)"], ["Été — 測試", "-5"]]);
    expect(csv).toBe('A,B\r\n"a,b","say ""hi"""\r\n"line1\nline2",=SUM(1)\r\nÉté — 測試,-5\r\n');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("deterministic file names", () => {
    const d = new Date(2026, 9, 2, 15);
    expect(exportFilename("woocommerce", d)).toBe("asoditech-woocommerce-products-2026-10-02.csv");
    expect(exportFilename("shopify", d)).toBe("asoditech-shopify-products-2026-10-02.csv");
  });
});

describe("export validation", () => {
  const codes = (v: { code: string }[]) => v.map((x) => x.code);

  it("blocks: empty selection, missing price, duplicate SKU, product already on the platform", () => {
    expect(codes(validateExport([], "woocommerce", { storeConnected: false }).errors)).toEqual(["empty"]);
    const v = validateExport(
      [base({ price: null }), base({ id: "x", name: "Autre", sku: "BSK-1" }), base({ id: "w", name: "Importé", sku: "W1", source: "WOOCOMMERCE" })],
      "woocommerce",
      { storeConnected: false }
    );
    expect(codes(v.errors)).toEqual(expect.arrayContaining(["missing_price", "duplicate_sku", "already_on_platform"]));
    expect(codes(validateExport([base({ publishedTo: ["shopify"] })], "shopify", { storeConnected: false }).errors)).toContain("already_published");
  });

  it("Shopify: more than 3 options, an incomplete or duplicated combination are blocking", () => {
    const four = variable({
      variations: [{ id: "v", sku: "V1", attributes: { A: "1", B: "2", C: "3", D: "4" }, price: 1, salePrice: null, isActive: true, imageUrl: null, barcode: null }],
    });
    expect(codes(validateExport([four], "shopify", { storeConnected: false }).errors)).toContain("too_many_options");
    expect(codes(validateExport([four], "woocommerce", { storeConnected: false }).errors)).not.toContain("too_many_options");
    const dup = variable({
      variations: [
        { id: "a", sku: "A", attributes: { Taille: "S" }, price: 1, salePrice: null, isActive: true, imageUrl: null, barcode: null },
        { id: "b", sku: "B", attributes: { Taille: "S" }, price: 1, salePrice: null, isActive: true, imageUrl: null, barcode: null },
        { id: "c", sku: "C", attributes: { Couleur: "Bleu" }, price: 1, salePrice: null, isActive: true, imageUrl: null, barcode: null },
      ],
    });
    expect(codes(validateExport([dup], "shopify", { storeConnected: false }).errors)).toEqual(expect.arrayContaining(["duplicate_combination", "incomplete_variation"]));
  });

  it("warns: unverified WooCommerce category (not when synced from WooCommerce), Shopify taxonomy, private image, draft, connected store", () => {
    const woo = validateExport([base({ status: "BROUILLON", images: [{ url: "http://localhost/x.jpg", alt: null }] })], "woocommerce", { storeConnected: true });
    expect(woo.errors).toEqual([]);
    expect(codes(woo.warnings)).toEqual(expect.arrayContaining(["category_unverified", "private_image", "inactive", "linked_on_sync", "no_stock"]));
    const synced = validateExport([base({ categorySource: "WOOCOMMERCE" })], "woocommerce", { storeConnected: false });
    expect(codes(synced.warnings)).not.toContain("category_unverified");
    expect(codes(validateExport([base()], "shopify", { storeConnected: false }).warnings)).toContain("shopify_category");
  });
});
